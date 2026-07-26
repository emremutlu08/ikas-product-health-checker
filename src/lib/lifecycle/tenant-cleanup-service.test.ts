import { describe, expect, it, vi } from "vitest";
import { TokenStoreError } from "@/lib/ikas/token-store";
import {
  TenantCleanupService,
  TenantCleanupServiceError,
  type TenantCleanupDependencies,
} from "./tenant-cleanup-service";

const tenant = {
  authorizedAppId: "authorized-app-1",
  merchantId: "merchant-1",
} as const;

function dependencies(
  operation: (component: string) => Promise<"deleted" | "absent"> = async () => "deleted",
) {
  const order: string[] = [];
  const cleanup = (component: string) =>
    vi.fn(async () => {
      order.push(component);
      return operation(component);
    });
  const markDeleted = vi.fn(async () => {
    order.push("deletion_barrier");
    return (await operation("deletion_barrier")) === "deleted" ? "marked" : "already_marked";
  });

  const stores = {
    deletionBarrier: { markDeleted },
    registry: { unregister: cleanup("registry") },
    token: { deleteTenant: cleanup("token") },
    mutationOperations: { deleteTenant: cleanup("mutation_operations") },
    monitoringSchedule: { deleteTenant: cleanup("monitoring_schedule") },
    snapshots: { deleteTenant: cleanup("snapshots") },
    monitoringSettings: { deleteTenant: cleanup("monitoring_settings") },
    lowStockAlerts: { deleteTenant: cleanup("low_stock_alerts") },
    alertOutbox: { deleteTenant: cleanup("alert_outbox") },
    interest: { deleteTenant: cleanup("interest_records") },
  } satisfies TenantCleanupDependencies;

  return { order, stores };
}

describe("TenantCleanupService", () => {
  it("runs every component in the deterministic safety order and returns no tenant data", async () => {
    const { order, stores } = dependencies();

    const result = await new TenantCleanupService(stores).cleanup(tenant);

    expect(order).toEqual([
      "deletion_barrier",
      "registry",
      "token",
      "mutation_operations",
      "monitoring_schedule",
      "snapshots",
      "monitoring_settings",
      "low_stock_alerts",
      "alert_outbox",
      "interest_records",
    ]);
    expect(result).toEqual({
      complete: true,
      steps: [
        { component: "deletion_barrier", status: "marked" },
        { component: "registry", status: "deleted" },
        { component: "token", status: "deleted" },
        { component: "mutation_operations", status: "deleted" },
        { component: "monitoring_schedule", status: "deleted" },
        { component: "snapshots", status: "deleted" },
        { component: "monitoring_settings", status: "deleted" },
        { component: "low_stock_alerts", status: "deleted" },
        { component: "alert_outbox", status: "deleted" },
        { component: "interest_records", status: "deleted" },
      ],
    });
    const serialized = JSON.stringify(result);
    expect(serialized).not.toContain(tenant.authorizedAppId);
    expect(serialized).not.toContain(tenant.merchantId);
    expect(serialized).not.toContain("secret-token");
  });

  it("continues after failures, sanitizes them, and is incomplete if any step failed", async () => {
    const { order, stores } = dependencies(async (component) => {
      if (component === "token") {
        throw new TokenStoreError("tenant_mismatch", "delete_tenant");
      }
      if (component === "snapshots") throw new Error("snapshot contained secret-token");
      return component === "monitoring_settings" ? "absent" : "deleted";
    });

    const result = await new TenantCleanupService(stores).cleanup(tenant);

    expect(order).toEqual([
      "deletion_barrier",
      "registry",
      "token",
      "mutation_operations",
      "monitoring_schedule",
      "snapshots",
      "monitoring_settings",
      "low_stock_alerts",
      "alert_outbox",
      "interest_records",
    ]);
    expect(result).toEqual({
      complete: false,
      steps: [
        { component: "deletion_barrier", status: "marked" },
        { component: "registry", status: "deleted" },
        { component: "token", status: "failed", code: "identity_mismatch" },
        { component: "mutation_operations", status: "deleted" },
        { component: "monitoring_schedule", status: "deleted" },
        { component: "snapshots", status: "failed", code: "cleanup_failed" },
        { component: "monitoring_settings", status: "absent" },
        { component: "low_stock_alerts", status: "deleted" },
        { component: "alert_outbox", status: "deleted" },
        { component: "interest_records", status: "deleted" },
      ],
    });
    expect(JSON.stringify(result)).not.toContain("secret-token");
  });

  it("is wholly idempotent when every component is retried", async () => {
    const attempts = new Map<string, number>();
    const { stores } = dependencies(async (component) => {
      const attempt = attempts.get(component) ?? 0;
      attempts.set(component, attempt + 1);
      return attempt === 0 ? "deleted" : "absent";
    });
    const service = new TenantCleanupService(stores);

    await expect(service.cleanup(tenant)).resolves.toMatchObject({ complete: true });
    await expect(service.cleanup(tenant)).resolves.toEqual({
      complete: true,
      steps: [
        { component: "deletion_barrier", status: "already_marked" },
        { component: "registry", status: "absent" },
        { component: "token", status: "absent" },
        { component: "mutation_operations", status: "absent" },
        { component: "monitoring_schedule", status: "absent" },
        { component: "snapshots", status: "absent" },
        { component: "monitoring_settings", status: "absent" },
        { component: "low_stock_alerts", status: "absent" },
        { component: "alert_outbox", status: "absent" },
        { component: "interest_records", status: "absent" },
      ],
    });
  });

  it("rejects an invalid tenant before invoking any component", async () => {
    const { stores } = dependencies();
    const service = new TenantCleanupService(stores);

    await expect(
      service.cleanup({ authorizedAppId: "", merchantId: tenant.merchantId }),
    ).rejects.toBeInstanceOf(TenantCleanupServiceError);
    for (const store of Object.values(stores)) {
      expect(Object.values(store)[0]).not.toHaveBeenCalled();
    }
  });

  it("does not delete any component when the durable barrier cannot be marked", async () => {
    const { order, stores } = dependencies();
    stores.deletionBarrier.markDeleted.mockRejectedValueOnce(
      new Error("backend included secret-token"),
    );

    await expect(new TenantCleanupService(stores).cleanup(tenant)).resolves.toEqual({
      complete: false,
      steps: [
        {
          component: "deletion_barrier",
          status: "failed",
          code: "cleanup_failed",
        },
      ],
    });
    expect(order).toEqual([]);
    for (const [name, store] of Object.entries(stores)) {
      if (name !== "deletionBarrier") {
        expect(Object.values(store)[0]).not.toHaveBeenCalled();
      }
    }
  });

  it("does not delete any component when the barrier identity does not match", async () => {
    const { order, stores } = dependencies();
    stores.deletionBarrier.markDeleted.mockRejectedValueOnce({
      code: "identity_mismatch",
    });

    await expect(new TenantCleanupService(stores).cleanup(tenant)).resolves.toEqual({
      complete: false,
      steps: [
        {
          component: "deletion_barrier",
          status: "failed",
          code: "identity_mismatch",
        },
      ],
    });
    expect(order).toEqual([]);
    for (const [name, store] of Object.entries(stores)) {
      if (name !== "deletionBarrier") {
        expect(Object.values(store)[0]).not.toHaveBeenCalled();
      }
    }
  });
});
