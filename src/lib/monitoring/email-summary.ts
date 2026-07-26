import type { VerifiedRecipient } from "./verified-recipient";

const RESEND_ENDPOINT = "https://api.resend.com/emails";
const REQUEST_TIMEOUT_MS = 5_000;
const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const IDEMPOTENCY_KEY_PATTERN = /^[A-Za-z0-9._:/-]{1,256}$/;

type Environment = Record<string, string | undefined>;

export type DailyEmailSummary = {
  generatedAt: string;
  score: number | null;
  state: string;
  productCount: number;
  issueCount: number;
  lowStockCount: number;
  historyUrl: string;
};

export type DailySummaryEmailSender = {
  send(recipient: VerifiedRecipient, summary: DailyEmailSummary, idempotencyKey: string): Promise<void>;
};

export class MonitoringEmailError extends Error {
  readonly code:
    | "IKAS_MONITORING_EMAIL_CONFIGURATION_INVALID"
    | "IKAS_MONITORING_EMAIL_DELIVERY_FAILED";

  constructor(code: MonitoringEmailError["code"]) {
    super(code);
    this.name = "MonitoringEmailError";
    this.code = code;
  }
}

function configurationError(): never {
  throw new MonitoringEmailError("IKAS_MONITORING_EMAIL_CONFIGURATION_INVALID");
}

function validEmail(value: string) {
  return value.length > 0 && value.length <= 320 && EMAIL_PATTERN.test(value);
}

function parseFrom(value: string | undefined) {
  const from = value?.trim();
  if (!from || from.length > 512) configurationError();
  const angle = from.match(/<([^<>]+)>$/);
  const address = (angle?.[1] ?? from).trim();
  if (!validEmail(address)) configurationError();
  return from;
}

function assertSummary(summary: DailyEmailSummary) {
  const url = new URL(summary.historyUrl);
  if (url.protocol !== "https:" || url.pathname !== "/history") configurationError();
  if (Number.isNaN(Date.parse(summary.generatedAt))) configurationError();
  for (const value of [summary.productCount, summary.issueCount, summary.lowStockCount]) {
    if (!Number.isSafeInteger(value) || value < 0) configurationError();
  }
  if (summary.score !== null && (!Number.isInteger(summary.score) || summary.score < 0 || summary.score > 100)) {
    configurationError();
  }
  if (typeof summary.state !== "string" || summary.state.length === 0 || summary.state.length > 64) {
    configurationError();
  }
}

function textFor(summary: DailyEmailSummary) {
  const score = summary.score === null ? "Hesaplanamadı" : `${summary.score}/100`;
  const state =
    ({ healthy: "Sağlıklı", attention: "Dikkat gerekiyor", critical: "Kritik" } as Record<string, string>)[
      summary.state
    ] ?? "Bilinmiyor";
  const generatedAt = new Intl.DateTimeFormat("tr-TR", {
    dateStyle: "short",
    timeStyle: "short",
    timeZone: "Europe/Istanbul",
  }).format(new Date(summary.generatedAt));
  return [
    "Ürün Sağlığı günlük özeti",
    `Tarama zamanı: ${generatedAt}`,
    `Sağlık skoru: ${score}`,
    `Durum: ${state}`,
    `Ürün: ${summary.productCount}`,
    `Toplam sorun: ${summary.issueCount}`,
    `Düşük stok uyarısı: ${summary.lowStockCount}`,
    `Geçmiş: ${summary.historyUrl}`,
  ].join("\n");
}

function readEmailConfiguration(env: Environment) {
  const apiKey = env.RESEND_API_KEY?.trim();
  if (!apiKey || apiKey.length < 16 || apiKey.length > 512) configurationError();
  const from = parseFrom(env.IKAS_EMAIL_FROM);
  return { apiKey, from };
}

export function isDailySummaryEmailConfigured(env: Environment = process.env) {
  try {
    readEmailConfiguration(env);
    return true;
  } catch {
    return false;
  }
}

export type TransactionalEmail = { subject: string; text: string };

export type TransactionalEmailSender = {
  send(recipient: VerifiedRecipient, email: TransactionalEmail, idempotencyKey: string): Promise<void>;
};

const MAX_SUBJECT_LENGTH = 200;
const MAX_TEXT_LENGTH = 20_000;

/**
 * The one outbound-mail transport. Every caller supplies its own body but shares the same verified
 * recipient rule, the same configuration failure, and the same provider idempotency key — so a
 * retry after a timeout cannot become a second delivery.
 */
export function createTransactionalEmailSender({
  env = process.env,
  fetchImpl = fetch,
}: {
  env?: Environment;
  fetchImpl?: typeof fetch;
} = {}): TransactionalEmailSender {
  const { apiKey, from } = readEmailConfiguration(env);

  return {
    async send(recipient, email, idempotencyKey) {
      if (!validEmail(recipient.email)) configurationError();
      if (!IDEMPOTENCY_KEY_PATTERN.test(idempotencyKey)) configurationError();
      if (
        email.subject.length === 0 ||
        email.subject.length > MAX_SUBJECT_LENGTH ||
        email.text.length === 0 ||
        email.text.length > MAX_TEXT_LENGTH
      ) {
        configurationError();
      }

      try {
        const response = await fetchImpl(RESEND_ENDPOINT, {
          method: "POST",
          headers: {
            authorization: "Bearer " + apiKey,
            "content-type": "application/json",
            "idempotency-key": idempotencyKey,
          },
          body: JSON.stringify({
            from,
            to: [recipient.email],
            subject: email.subject,
            text: email.text,
          }),
          cache: "no-store",
          signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
        });
        if (!response.ok) {
          throw new MonitoringEmailError("IKAS_MONITORING_EMAIL_DELIVERY_FAILED");
        }
      } catch (error) {
        if (
          error instanceof MonitoringEmailError &&
          error.code === "IKAS_MONITORING_EMAIL_DELIVERY_FAILED"
        ) {
          throw error;
        }
        throw new MonitoringEmailError("IKAS_MONITORING_EMAIL_DELIVERY_FAILED");
      }
    },
  };
}

export function createDailySummaryEmailSender(options: {
  env?: Environment;
  fetchImpl?: typeof fetch;
} = {}): DailySummaryEmailSender {
  const transport = createTransactionalEmailSender(options);

  return {
    async send(recipient, summary, idempotencyKey) {
      assertSummary(summary);
      await transport.send(
        recipient,
        { subject: "Ürün Sağlığı günlük özeti", text: textFor(summary) },
        idempotencyKey,
      );
    },
  };
}
