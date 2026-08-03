import { describe, expect, it, vi } from "vitest";
import { IkasAuthenticationError, IkasUpstreamError } from "./errors";
import {
  HttpIkasLicenceAdapter,
  LICENCE_GRAPHQL_TIMEOUT_MS,
  MAX_IDENTIFIER_LENGTH,
  MAX_PLAN_KEY_LENGTH,
} from "./licence-adapter";

const licencePayload = {
  data: {
    getMerchantLicence: {
      merchantId: "merchant-1",
      appSubscriptions: [
        {
          id: "sub-1",
          authorizedAppId: "app-install-1",
          storeAppId: "store-app-1",
          storeAppListingSubscriptionKey: "productHealthPro",
          status: "ACTIVE",
          deleted: false,
        },
      ],
    },
  },
};

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status });
}

function adapter(fetchImpl: typeof fetch) {
  return new HttpIkasLicenceAdapter("https://example.test/graphql", "token", "store-app-1", fetchImpl);
}

describe("HttpIkasLicenceAdapter", () => {
  it("reads the merchant licence with an argument-free query and bearer token", async () => {
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(jsonResponse(licencePayload));

    const licence = await adapter(fetchMock).getMerchantLicence("app-install-1");

    expect(licence).toEqual({
      merchantId: "merchant-1",
      reportedSubscriptionCount: 1,
      appSubscriptions: [
        {
          id: "sub-1",
          authorizedAppId: "app-install-1",
          storeAppId: "store-app-1",
          storeAppListingSubscriptionKey: "productHealthPro",
          status: "ACTIVE",
          deleted: false,
        },
      ],
    });

    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe("https://example.test/graphql");
    expect((init?.headers as Record<string, string>).authorization).toBe("Bearer token");
    const body = JSON.parse(String(init?.body));
    expect(body.query).toContain("getMerchantLicence");
    expect(body.query).toContain("storeAppListingSubscriptionKey");
    expect(body.variables).toBeUndefined();
    expect(LICENCE_GRAPHQL_TIMEOUT_MS).toBeGreaterThan(0);
  });

  it("preserves a nullable authorizedAppId for fail-closed installation matching", async () => {
    const payload = structuredClone(licencePayload);
    payload.data.getMerchantLicence.appSubscriptions[0]!.authorizedAppId = null as unknown as string;
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(jsonResponse(payload));

    const licence = await adapter(fetchMock).getMerchantLicence("app-install-1");

    // Preserved, not dropped: ikas leaves this null on a plan bought through "Planı Yönet",
    // and deciding whether it is ours belongs to the entitlement resolver, not the transport.
    expect(licence.appSubscriptions).toHaveLength(1);
    expect(licence.appSubscriptions[0]!.authorizedAppId).toBeNull();
  });

  it("skips a malformed subscription instead of failing the whole licence", async () => {
    const payload = structuredClone(licencePayload);
    payload.data.getMerchantLicence.appSubscriptions.unshift({
      id: "foreign-subscription",
      authorizedAppId: "foreign-installation",
      storeAppId: "foreign-store-app",
      storeAppListingSubscriptionKey: "x".repeat(MAX_PLAN_KEY_LENGTH + 1),
      status: "FUTURE_STATUS",
      deleted: false,
    });
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(jsonResponse(payload));

    // Most subscriptions in a merchant's licence belong to other apps. One of them drifting from
    // the documented shape must not deny this app's merchant their own subscription.
    await expect(adapter(fetchMock).getMerchantLicence("app-install-1")).resolves.toEqual({
      merchantId: "merchant-1",
      appSubscriptions: licencePayload.data.getMerchantLicence.appSubscriptions,
      reportedSubscriptionCount: 2,
    });
  });

  it("skips a record whose own listing id is unusable, since it cannot be claimed as ours", async () => {
    const overLong = "x".repeat(MAX_IDENTIFIER_LENGTH + 1);

    for (const storeAppId of ["", overLong, "another-app"]) {
      const payload = structuredClone(licencePayload);
      payload.data.getMerchantLicence.appSubscriptions[0]!.storeAppId = storeAppId;
      const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(jsonResponse(payload));

      const licence = await adapter(fetchMock).getMerchantLicence("app-install-1");
      // Still counted, so the entitlement warning shows a record was seen and not understood.
      expect(licence.reportedSubscriptionCount, storeAppId).toBe(1);
    }
  });

  /**
   * The payload ikas actually returns for a plan bought through "Planı Yönet", captured from a
   * live response on 2026-08-03 and frozen here verbatim.
   *
   * Every other fixture in this file was written from the schema and populated `authorizedAppId`,
   * which the real response leaves null. That is why nothing here failed while production refused
   * every paying merchant: the tests only ever described a shape we imagined. A fixture taken
   * from the wire is the only kind that can contradict us.
   */
  it("accepts the shape a real 'Planı Yönet' purchase produces", async () => {
    const live = {
      data: {
        getMerchantLicence: {
          merchantId: "merchant-1",
          appSubscriptions: [
            {
              id: "31f7362b-cb64-4d18-a6e0-3443abf3939e",
              name: "Product Health Pro",
              // Null on a listing purchase: no merchant app payment is involved.
              authorizedAppId: null,
              appPaymentKey: null,
              storeAppId: "store-app-1",
              storeAppListingSubscriptionKey: "productHealthPro",
              status: "ACTIVE",
              deleted: false,
              currencyCode: "TRY",
              lastPaymentPeriod: "YEARLY",
              lastPaymentPrice: 0.94,
            },
          ],
        },
      },
    };
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(jsonResponse(live));

    const licence = await adapter(fetchMock).getMerchantLicence("app-install-1");

    expect(licence.reportedSubscriptionCount).toBe(1);
    expect(licence.appSubscriptions).toHaveLength(1);
    expect(licence.appSubscriptions[0]).toMatchObject({
      authorizedAppId: null,
      storeAppId: "store-app-1",
      storeAppListingSubscriptionKey: "productHealthPro",
      status: "ACTIVE",
    });
  });

  // A status outside the live enum is malformed upstream data, not a fourth business state.
  // Reading it as "not ACTIVE" would silently downgrade a merchant on an ikas schema change,
  // so the whole licence is rejected and the caller resolves it as unknown instead.
  it("rejects a status outside the live MerchantSubscriptionStatusEnum", async () => {
    for (const status of ["active", "SOME_FUTURE_STATUS", "PAUSED", "", null, 7]) {
      const payload = structuredClone(licencePayload);
      payload.data.getMerchantLicence.appSubscriptions[0]!.status = status as string;
      const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(jsonResponse(payload));

      await expect(adapter(fetchMock).getMerchantLicence("app-install-1"), String(status)).rejects.toThrow(
        new IkasUpstreamError("IKAS_UPSTREAM_INVALID_RESPONSE"),
      );
    }
  });

  it("accepts every status the live enum declares", async () => {
    for (const status of ["ACTIVE", "REMOVED", "WILL_BE_REMOVED"]) {
      const payload = structuredClone(licencePayload);
      payload.data.getMerchantLicence.appSubscriptions[0]!.status = status;
      const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(jsonResponse(payload));

      const licence = await adapter(fetchMock).getMerchantLicence("app-install-1");

      expect(licence.appSubscriptions[0]!.status, status).toBe(status);
    }
  });

  // Empty and unbounded fields on this app's own record are malformed, not data: reading them
  // leniently would downgrade a paying merchant instead of raising the unknown state that earns
  // grace. Records belonging to other apps are skipped instead, so their data cannot poison ours.
  it("rejects a malformed record that is identifiably this app's", async () => {
    const cases: Array<Record<string, unknown>> = [
      { storeAppListingSubscriptionKey: "" },
      { storeAppListingSubscriptionKey: "k".repeat(MAX_PLAN_KEY_LENGTH + 1) },
      { status: "FUTURE_STATUS" },
    ];

    for (const overrides of cases) {
      const payload = structuredClone(licencePayload);
      Object.assign(payload.data.getMerchantLicence.appSubscriptions[0]!, overrides);
      const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(jsonResponse(payload));

      await expect(
        adapter(fetchMock).getMerchantLicence("app-install-1"),
        JSON.stringify(overrides).slice(0, 60),
      ).rejects.toThrow(new IkasUpstreamError("IKAS_UPSTREAM_INVALID_RESPONSE"));
    }
  });

  it("rejects an empty or over-long merchantId", async () => {
    for (const merchantId of ["", "m".repeat(MAX_IDENTIFIER_LENGTH + 1)]) {
      const payload = structuredClone(licencePayload);
      payload.data.getMerchantLicence.merchantId = merchantId;
      const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(jsonResponse(payload));

      await expect(adapter(fetchMock).getMerchantLicence("app-install-1"), merchantId.length.toString()).rejects.toThrow(
        new IkasUpstreamError("IKAS_UPSTREAM_INVALID_RESPONSE"),
      );
    }
  });

  it("maps HTTP 401 and 403 to a typed authentication error", async () => {
    for (const status of [401, 403]) {
      const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(new Response("", { status }));

      await expect(adapter(fetchMock).getMerchantLicence("app-install-1"), String(status)).rejects.toThrow(
        new IkasAuthenticationError("IKAS_AUTHENTICATION_FAILED"),
      );
    }
  });

  it("rejects invalid installation ids before making a network request", async () => {
    const fetchMock = vi.fn<typeof fetch>();

    for (const authorizedAppId of ["", "   ", "x".repeat(MAX_IDENTIFIER_LENGTH + 1)]) {
      await expect(adapter(fetchMock).getMerchantLicence(authorizedAppId)).rejects.toThrow(
        new IkasUpstreamError("IKAS_UPSTREAM_INVALID_RESPONSE"),
      );
    }
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("maps an authentication GraphQL error code to a typed authentication error", async () => {
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValue(
        jsonResponse({ errors: [{ message: "nope", extensions: { code: "UNAUTHENTICATED" } }] }),
      );

    await expect(adapter(fetchMock).getMerchantLicence("app-install-1")).rejects.toThrow(
      new IkasAuthenticationError("IKAS_AUTHENTICATION_FAILED"),
    );
  });

  it("sanitizes business GraphQL errors", async () => {
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValue(jsonResponse({ errors: [{ message: "PROVIDER_DETAIL_SENTINEL" }] }));

    const promise = adapter(fetchMock).getMerchantLicence("app-install-1");

    await expect(promise).rejects.toThrow(new IkasUpstreamError("IKAS_UPSTREAM_GRAPHQL_ERROR"));
    await expect(promise).rejects.not.toThrow(/PROVIDER_DETAIL_SENTINEL/);
  });

  it("maps transport failures to a typed upstream error", async () => {
    const fetchMock = vi.fn<typeof fetch>().mockRejectedValue(new Error("socket hang up"));

    await expect(adapter(fetchMock).getMerchantLicence("app-install-1")).rejects.toThrow(
      new IkasUpstreamError("IKAS_UPSTREAM_HTTP_ERROR"),
    );
  });

  it("maps only retryable HTTP statuses to the grace-eligible upstream error", async () => {
    for (const status of [408, 429, 500, 503]) {
      const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(new Response("", { status }));

      await expect(adapter(fetchMock).getMerchantLicence("app-install-1"), String(status)).rejects.toThrow(
        new IkasUpstreamError("IKAS_UPSTREAM_HTTP_ERROR"),
      );
    }
  });

  it("maps durable non-auth client responses to a non-grace-eligible invalid response", async () => {
    for (const status of [400, 404, 410, 422]) {
      const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(new Response("", { status }));

      await expect(adapter(fetchMock).getMerchantLicence("app-install-1"), String(status)).rejects.toThrow(
        new IkasUpstreamError("IKAS_UPSTREAM_INVALID_RESPONSE"),
      );
    }
  });

  // The signal is the only thing bounding a hung ikas call, so assert it actually fires and
  // carries a timeout reason — not merely that some signal object was passed.
  it("passes a signal that really aborts the request on timeout", async () => {
    let captured: AbortSignal | undefined;
    const fetchMock = vi.fn<typeof fetch>().mockImplementation((_url, init) => {
      captured = init?.signal as AbortSignal;
      return new Promise((_resolve, reject) => {
        captured!.addEventListener("abort", () => reject(captured!.reason));
      });
    });

    await expect(
      new HttpIkasLicenceAdapter("https://example.test/graphql", "token", "store-app-1", fetchMock, 5).getMerchantLicence("app-install-1"),
    ).rejects.toThrow(new IkasUpstreamError("IKAS_UPSTREAM_HTTP_ERROR"));

    expect(captured).toBeInstanceOf(AbortSignal);
    expect(captured!.aborted).toBe(true);
    expect((captured!.reason as Error).name).toBe("TimeoutError");
  });

  // A body that stops arriving mid-read is a transport failure, not a schema failure. Calling
  // it INVALID_RESPONSE would blame ikas for malformed data during our own timeout.
  it("maps an aborted body read to a transport error, not an invalid response", async () => {
    for (const reason of [
      new DOMException("The operation was aborted.", "AbortError"),
      new DOMException("The operation timed out.", "TimeoutError"),
    ]) {
      const response = new Response("", { status: 200 });
      vi.spyOn(response, "json").mockRejectedValue(reason);
      const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(response);

      await expect(adapter(fetchMock).getMerchantLicence("app-install-1"), reason.name).rejects.toThrow(
        new IkasUpstreamError("IKAS_UPSTREAM_HTTP_ERROR"),
      );
    }
  });

  it("still reports genuinely malformed JSON as an invalid response", async () => {
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValue(new Response("{ not json", { status: 200 }));

    await expect(adapter(fetchMock).getMerchantLicence("app-install-1")).rejects.toThrow(
      new IkasUpstreamError("IKAS_UPSTREAM_INVALID_RESPONSE"),
    );
  });

  it("rejects malformed licence payloads, including a null appSubscriptions list", async () => {
    const malformed = [
      "not json",
      JSON.stringify({ data: {} }),
      JSON.stringify({ data: { getMerchantLicence: null } }),
      // MCP cannot establish what a null list means, so it is unknown — never an empty Free result.
      JSON.stringify({ data: { getMerchantLicence: { merchantId: "m1", appSubscriptions: null } } }),
      JSON.stringify({ data: { getMerchantLicence: { appSubscriptions: [] } } }),
      JSON.stringify({
        data: {
          getMerchantLicence: {
            merchantId: "m1",
            appSubscriptions: [
              {
                authorizedAppId: "app-install-1",
                // This app's own listing, so a malformed payload here must reject rather than skip.
                storeAppId: "store-app-1",
                storeAppListingSubscriptionKey: "k",
                status: "ACTIVE",
                deleted: "false",
              },
            ],
          },
        },
      }),
    ];

    for (const body of malformed) {
      const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(new Response(body, { status: 200 }));

      await expect(adapter(fetchMock).getMerchantLicence("app-install-1"), body).rejects.toThrow(
        new IkasUpstreamError("IKAS_UPSTREAM_INVALID_RESPONSE"),
      );
    }
  });
});
