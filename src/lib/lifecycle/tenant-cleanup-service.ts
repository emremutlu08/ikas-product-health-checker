import type { TokenStore } from "@/lib/ikas/token-store";
import type { InterestStore } from "@/lib/interest/interest-store";
import type { MonitoringScheduleStore } from "@/lib/monitoring/schedule-store";
import type { InstallationRegistryStore } from "@/lib/registry/installation-registry-store";
import type { SnapshotStore } from "@/lib/scans/snapshot-store";
import type { MonitoringSettingsStore } from "@/lib/settings/settings-store";
import type { MutationOperationStore } from "@/lib/mutations/mutation-operation-store";
import type { AlertOutboxStore, LowStockAlertStore } from "@/lib/alerts/alert-store";
import type {
  MarkTenantDeletedResult,
  TenantDeletionStore,
} from "./tenant-deletion-store";
import {
  TenantIdentityError,
  validateTenantIdentity,
  type DeleteResult,
  type TenantIdentity,
} from "./tenant-identity";

export type TenantCleanupComponent =
  | "deletion_barrier"
  | "registry"
  | "token"
  | "mutation_operations"
  | "monitoring_schedule"
  | "snapshots"
  | "monitoring_settings"
  | "low_stock_alerts"
  | "alert_outbox"
  | "interest_records";

export type TenantCleanupFailureCode =
  | "backend_failure"
  | "corrupt_data"
  | "identity_mismatch"
  | "invalid_configuration"
  | "cleanup_failed";

export type TenantCleanupStep =
  | {
      component: TenantCleanupComponent;
      status: DeleteResult | MarkTenantDeletedResult;
    }
  | {
      component: TenantCleanupComponent;
      status: "failed";
      code: TenantCleanupFailureCode;
    };

export type TenantCleanupResult = {
  complete: boolean;
  steps: TenantCleanupStep[];
};

export type TenantCleanupDependencies = {
  deletionBarrier: Pick<TenantDeletionStore, "markDeleted">;
  registry: Pick<InstallationRegistryStore, "unregister">;
  token: Pick<TokenStore, "deleteTenant">;
  mutationOperations: Pick<MutationOperationStore, "deleteTenant">;
  monitoringSchedule: Pick<MonitoringScheduleStore, "deleteTenant">;
  snapshots: Pick<SnapshotStore, "deleteTenant">;
  monitoringSettings: Pick<MonitoringSettingsStore, "deleteTenant">;
  lowStockAlerts: Pick<LowStockAlertStore, "deleteTenant">;
  alertOutbox: Pick<AlertOutboxStore, "deleteTenant">;
  interest: Pick<InterestStore, "deleteTenant">;
};

export class TenantCleanupServiceError extends Error {
  readonly code = "invalid_tenant" as const;

  constructor() {
    super("IKAS_TENANT_CLEANUP_INVALID_TENANT");
    this.name = "TenantCleanupServiceError";
  }
}

function failureCode(error: unknown): TenantCleanupFailureCode {
  if (typeof error !== "object" || error === null || !("code" in error)) {
    return "cleanup_failed";
  }
  switch ((error as { code?: unknown }).code) {
    case "backend":
      return "backend_failure";
    case "corrupt_record":
    case "payload_too_large":
      return "corrupt_data";
    case "tenant_mismatch":
    case "identity_mismatch":
      return "identity_mismatch";
    case "configuration":
      return "invalid_configuration";
    default:
      return "cleanup_failed";
  }
}

/**
 * Store-agnostic uninstall cleanup. It deliberately has no HTTP/webhook concerns: a verified
 * caller must supply the canonical identity once ikas publishes the missing authenticity and
 * replay contract.
 */
export class TenantCleanupService {
  constructor(private readonly stores: TenantCleanupDependencies) {}

  async cleanup(identity: TenantIdentity): Promise<TenantCleanupResult> {
    let tenant: TenantIdentity;
    try {
      tenant = validateTenantIdentity(identity);
    } catch (error) {
      if (error instanceof TenantIdentityError) throw new TenantCleanupServiceError();
      throw error;
    }

    let barrierStatus: MarkTenantDeletedResult;
    try {
      barrierStatus = await this.stores.deletionBarrier.markDeleted(tenant);
    } catch (error) {
      return {
        complete: false,
        steps: [
          {
            component: "deletion_barrier",
            status: "failed",
            code: failureCode(error),
          },
        ],
      };
    }

    const operations: ReadonlyArray<{
      component: TenantCleanupComponent;
      run: () => Promise<DeleteResult>;
    }> = [
      { component: "registry", run: () => this.stores.registry.unregister(tenant) },
      { component: "token", run: () => this.stores.token.deleteTenant(tenant) },
      {
        component: "mutation_operations",
        run: () => this.stores.mutationOperations.deleteTenant(tenant),
      },
      {
        component: "monitoring_schedule",
        run: () => this.stores.monitoringSchedule.deleteTenant(tenant),
      },
      { component: "snapshots", run: () => this.stores.snapshots.deleteTenant(tenant) },
      {
        component: "monitoring_settings",
        run: () => this.stores.monitoringSettings.deleteTenant(tenant),
      },
      {
        component: "low_stock_alerts",
        run: () => this.stores.lowStockAlerts.deleteTenant(tenant),
      },
      { component: "alert_outbox", run: () => this.stores.alertOutbox.deleteTenant(tenant) },
      { component: "interest_records", run: () => this.stores.interest.deleteTenant(tenant) },
    ];

    const steps: TenantCleanupStep[] = [
      { component: "deletion_barrier", status: barrierStatus },
    ];
    for (const operation of operations) {
      try {
        steps.push({ component: operation.component, status: await operation.run() });
      } catch (error) {
        steps.push({
          component: operation.component,
          status: "failed",
          code: failureCode(error),
        });
      }
    }

    return {
      complete: steps.every((step) => step.status !== "failed"),
      steps,
    };
  }
}
