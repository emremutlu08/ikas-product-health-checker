import {
  HEALTH_METHODOLOGY_LINES,
  type HealthAssessment,
  type HealthState,
} from "@/lib/health/health-model";

/**
 * Compact health hierarchy: one state, one number, and the two counts that decide what a
 * merchant does next. No trend is shown, because only the latest snapshot is stored — a
 * change indicator here would have nothing truthful to compare against.
 *
 * The state is always rendered as words. Colour reinforces it and never carries it alone.
 */

export type HealthSummaryProps = {
  assessment: HealthAssessment;
};

const STATE_STYLES: Record<HealthState, string> = {
  unknown: "bg-surface-sunken text-text-muted",
  good: "bg-success-surface text-success",
  attention: "bg-warning-surface text-warning",
  critical: "bg-critical-surface text-critical",
};

function Metric({
  label,
  value,
  detail,
}: {
  label: string;
  value: string | number;
  detail?: string;
}) {
  return (
    <div className="flex flex-col gap-1">
      <p className="text-label font-medium uppercase text-text-muted">{label}</p>
      <p className="text-metric font-semibold tabular-nums text-text">{value}</p>
      {detail ? <p className="text-sm text-text-muted">{detail}</p> : null}
    </div>
  );
}

export function HealthSummary({ assessment }: HealthSummaryProps) {
  const { state, label, score, productCount, affectedProductCount, criticalCount } = assessment;

  return (
    <section
      aria-labelledby="health-summary-heading"
      className="rounded-lg border border-border bg-surface p-5 shadow-card"
    >
      <h2 className="sr-only" id="health-summary-heading">
        Mağaza sağlığı özeti
      </h2>

      <div className="grid gap-5 sm:grid-cols-3">
        <div className="flex flex-col gap-1">
          <p className="text-label font-medium uppercase text-text-muted">Sağlık durumu</p>
          <p
            className={`inline-flex w-fit items-center rounded-sm px-2 py-1 text-sm font-semibold ${STATE_STYLES[state]}`}
          >
            {label}
          </p>
          {score === null ? (
            <p className="text-sm text-text-muted">
              Skor yalnızca en az bir ürün tarandığında hesaplanır.
            </p>
          ) : (
            <p className="text-metric font-semibold tabular-nums text-text">
              <span>{score}</span>
              <span className="text-sm font-normal text-text-muted">/100</span>
            </p>
          )}
        </div>

        <Metric label="Kritik sorun" value={criticalCount} detail="Öncelikli olarak çözün." />

        <Metric
          label="Etkilenen ürün"
          value={affectedProductCount}
          detail={`Taranan ${productCount} ürün içinde.`}
        />
      </div>

      {/*
        The methodology travels with the number. A merchant who disagrees with the score can
        read exactly how it was produced, and nothing here claims it was calibrated against
        observed stores.
      */}
      <details className="mt-5 border-t border-border pt-4">
        <summary className="cursor-pointer text-sm font-medium text-accent">
          Skor nasıl hesaplanır?
        </summary>
        <ul className="mt-2 flex list-disc flex-col gap-1 pl-5 text-sm text-text-muted">
          {HEALTH_METHODOLOGY_LINES.map((line) => (
            <li key={line}>{line}</li>
          ))}
        </ul>
      </details>
    </section>
  );
}
