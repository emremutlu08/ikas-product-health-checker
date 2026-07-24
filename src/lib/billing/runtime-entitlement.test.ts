import { describe, expect, it, vi } from "vitest";
import { IkasUpstreamError } from "@/lib/ikas/errors";
import { MERCHANT_SUBSCRIPTION_STATUS, type IkasMerchantLicence } from "@/lib/ikas/licence-adapter";
import { PRO_PLAN_KEY } from "./plan-catalog";
import { resolveInstallationRetentionPolicy } from "./runtime-entitlement";

const installation = {
  authorizedAppId: "app-1",
  merchantId: "merchant-1",
  storeName: "store-1",
};

const token = {
  ...installation,
  accessToken: "access-token",
};

function licence(overrides: Partial<IkasMerchantLicence> = {}): IkasMerchantLicence {
  return {
    merchantId: installation.merchantId,
    appSubscriptions: [
      {
        id: "subscription-1",
        authorizedAppId: installation.authorizedAppId,
        storeAppId: "store-app-1",
        storeAppListingSubscriptionKey: PRO_PLAN_KEY,
        status: MERCHANT_SUBSCRIPTION_STATUS.active,
        deleted: false,
      },
    ],
    ...overrides,
  };
}

function dependencies(result: IkasMerchantLicence | Error = licence()) {
  const reader = {
    getMerchantLicence: vi.fn().mockImplementation(async () => {
      if (result instanceof Error) throw result;
      return result;
    }),
  };
  return {
    getToken: vi.fn().mockResolvedValue(token),
    createReader: vi.fn().mockReturnValue(reader),
    logger: { warn: vi.fn() },
    reader,
  };
}

describe("resolveInstallationRetentionPolicy", () => {
  it("retains history only for an active, known Pro subscription bound to the installation", async () => {
    const deps = dependencies();

    await expect(resolveInstallationRetentionPolicy(installation, deps)).resolves.toEqual({
      historyEnabled: true,
    });
    expect(deps.createReader).toHaveBeenCalledWith("access-token");
    expect(deps.reader.getMerchantLicence).toHaveBeenCalledWith(installation.authorizedAppId);
  });

  it.each([
    {
      name: "no matching subscription",
      value: licence({ appSubscriptions: [] }),
    },
    {
      name: "inactive subscription",
      value: licence({
        appSubscriptions: [
          {
            ...licence().appSubscriptions[0]!,
            status: MERCHANT_SUBSCRIPTION_STATUS.removed,
          },
        ],
      }),
    },
    {
      name: "another merchant",
      value: licence({ merchantId: "merchant-2" }),
    },
    {
      name: "unknown plan",
      value: licence({
        appSubscriptions: [
          {
            ...licence().appSubscriptions[0]!,
            storeAppListingSubscriptionKey: "unknown-plan",
          },
        ],
      }),
    },
  ])("defaults to latest-only for $name", async ({ value }) => {
    await expect(resolveInstallationRetentionPolicy(installation, dependencies(value))).resolves.toEqual({
      historyEnabled: false,
    });
  });

  it("defaults to latest-only when the durable token is absent or belongs to another tenant", async () => {
    const absent = dependencies();
    absent.getToken.mockResolvedValue(undefined);
    const crossed = dependencies();
    crossed.getToken.mockResolvedValue({ ...token, merchantId: "merchant-2" });

    await expect(resolveInstallationRetentionPolicy(installation, absent)).resolves.toEqual({
      historyEnabled: false,
    });
    await expect(resolveInstallationRetentionPolicy(installation, crossed)).resolves.toEqual({
      historyEnabled: false,
    });
    expect(absent.createReader).not.toHaveBeenCalled();
    expect(crossed.createReader).not.toHaveBeenCalled();
  });

  it("fails closed without blocking a Free scan when token or licence infrastructure is unavailable", async () => {
    const tokenFailure = dependencies();
    tokenFailure.getToken.mockRejectedValue(new Error("backend unavailable"));
    const licenceFailure = dependencies(new IkasUpstreamError("IKAS_UPSTREAM_HTTP_ERROR"));

    await expect(resolveInstallationRetentionPolicy(installation, tokenFailure)).resolves.toEqual({
      historyEnabled: false,
    });
    await expect(resolveInstallationRetentionPolicy(installation, licenceFailure)).resolves.toEqual({
      historyEnabled: false,
    });
  });

  it("emits the existing safe warning for an unknown live plan key", async () => {
    const deps = dependencies(
      licence({
        appSubscriptions: [
          {
            ...licence().appSubscriptions[0]!,
            storeAppListingSubscriptionKey: "unknown-plan",
          },
        ],
      }),
    );

    await resolveInstallationRetentionPolicy(installation, deps);

    expect(deps.logger.warn).toHaveBeenCalledWith({
      event: "billing.entitlement.unknown_plan_key",
      reason: "UNKNOWN_PLAN_KEY",
      authorizedAppId: installation.authorizedAppId,
      merchantId: installation.merchantId,
      planKey: "unknown-plan",
    });
  });
});
