import { createServer, type Server } from "node:https";
import { connect, type Socket } from "node:net";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

/**
 * A tiny Upstash-REST facade over a real Redis, used only by the acceptance suite.
 *
 * The point of the acceptance run is that the Lua the application ships is executed by a real
 * Redis, with real atomicity and real concurrency — not by a stub that returns what the test
 * expects. So this speaks RESP to an actual server and re-frames the reply in the Upstash JSON
 * shape the stores already parse, and it serves over HTTPS because every store refuses a
 * plaintext endpoint. Nothing here is imported by application code.
 */

type RedisValue = string | number | null | RedisValue[];

function encodeCommand(args: ReadonlyArray<string | number>): string {
  return args.reduce<string>(
    (buffer, argument) => {
      const value = String(argument);
      return `${buffer}$${Buffer.byteLength(value, "utf8")}\r\n${value}\r\n`;
    },
    `*${args.length}\r\n`,
  );
}

type ParseResult = { value: RedisValue; offset: number } | undefined;

function parseReply(buffer: Buffer, start: number): ParseResult {
  const lineEnd = buffer.indexOf("\r\n", start);
  if (lineEnd === -1) return undefined;

  const type = String.fromCharCode(buffer[start]!);
  const payload = buffer.toString("utf8", start + 1, lineEnd);
  const next = lineEnd + 2;

  if (type === "+") return { value: payload, offset: next };
  if (type === "-") throw new Error(payload);
  if (type === ":") return { value: Number(payload), offset: next };
  if (type === "$") {
    const length = Number(payload);
    if (length === -1) return { value: null, offset: next };
    if (buffer.length < next + length + 2) return undefined;
    return { value: buffer.toString("utf8", next, next + length), offset: next + length + 2 };
  }
  if (type === "*") {
    const count = Number(payload);
    if (count === -1) return { value: null, offset: next };
    const items: RedisValue[] = [];
    let offset = next;
    for (let index = 0; index < count; index += 1) {
      const item = parseReply(buffer, offset);
      if (!item) return undefined;
      items.push(item.value);
      offset = item.offset;
    }
    return { value: items, offset };
  }
  throw new Error(`unsupported RESP type ${type}`);
}

class RedisConnection {
  private buffer = Buffer.alloc(0);
  private readonly pending: Array<{
    resolve: (value: RedisValue) => void;
    reject: (error: Error) => void;
  }> = [];

  private constructor(private readonly socket: Socket) {
    socket.on("data", (chunk) => {
      this.buffer = Buffer.concat([this.buffer, chunk]);
      this.drain();
    });
    socket.on("error", (error) => {
      while (this.pending.length > 0) this.pending.shift()!.reject(error);
    });
  }

  private drain() {
    while (this.pending.length > 0 && this.buffer.length > 0) {
      let parsed: ParseResult;
      try {
        parsed = parseReply(this.buffer, 0);
      } catch (error) {
        this.buffer = Buffer.alloc(0);
        this.pending.shift()!.reject(error as Error);
        continue;
      }
      if (!parsed) return;
      this.buffer = this.buffer.subarray(parsed.offset);
      this.pending.shift()!.resolve(parsed.value);
    }
  }

  static async open(host: string, port: number) {
    const socket = await new Promise<Socket>((resolve, reject) => {
      const candidate = connect({ host, port }, () => resolve(candidate));
      candidate.once("error", reject);
    });
    socket.setNoDelay(true);
    return new RedisConnection(socket);
  }

  send(args: ReadonlyArray<string | number>) {
    return new Promise<RedisValue>((resolve, reject) => {
      this.pending.push({ resolve, reject });
      this.socket.write(encodeCommand(args));
    });
  }

  close() {
    this.socket.destroy();
  }
}

function selfSignedCertificate() {
  const directory = mkdtempSync(path.join(tmpdir(), "ikas-acceptance-tls-"));
  const keyPath = path.join(directory, "key.pem");
  const certPath = path.join(directory, "cert.pem");
  execFileSync("openssl", [
    "req",
    "-x509",
    "-newkey",
    "rsa:2048",
    "-nodes",
    "-keyout",
    keyPath,
    "-out",
    certPath,
    "-days",
    "1",
    "-subj",
    "/CN=127.0.0.1",
  ]);
  return { key: readFileSync(keyPath), cert: readFileSync(certPath) };
}

export type UpstashShim = {
  url: string;
  token: string;
  /** Ignores TLS trust only; everything else is a real HTTPS request to a real Redis. */
  fetchImpl: typeof fetch;
  flush(): Promise<void>;
  close(): Promise<void>;
};

export async function startUpstashRestShim({
  host = "127.0.0.1",
  port = 6399,
}: { host?: string; port?: number } = {}): Promise<UpstashShim> {
  const connection = await RedisConnection.open(host, port);
  const token = "acceptance-token";
  const { key, cert } = selfSignedCertificate();

  const server: Server = createServer({ key, cert }, (request, response) => {
    if (request.headers.authorization !== `Bearer ${token}`) {
      response.writeHead(401).end();
      return;
    }
    const chunks: Buffer[] = [];
    request.on("data", (chunk: Buffer) => chunks.push(chunk));
    request.on("end", () => {
      void (async () => {
        try {
          const command = JSON.parse(Buffer.concat(chunks).toString("utf8")) as Array<string | number>;
          const result = await connection.send(command);
          response
            .writeHead(200, { "content-type": "application/json" })
            .end(JSON.stringify({ result }));
        } catch (error) {
          response
            .writeHead(200, { "content-type": "application/json" })
            .end(JSON.stringify({ error: (error as Error).message }));
        }
      })();
    });
  });

  const shimPort = await new Promise<number>((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      resolve((server.address() as { port: number }).port);
    });
  });

  const previousTlsSetting = process.env.NODE_TLS_REJECT_UNAUTHORIZED;
  process.env.NODE_TLS_REJECT_UNAUTHORIZED = "0";

  return {
    url: `https://127.0.0.1:${shimPort}`,
    token,
    fetchImpl: fetch,
    async flush() {
      await connection.send(["FLUSHALL"]);
    },
    async close() {
      if (previousTlsSetting === undefined) delete process.env.NODE_TLS_REJECT_UNAUTHORIZED;
      else process.env.NODE_TLS_REJECT_UNAUTHORIZED = previousTlsSetting;
      connection.close();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}
