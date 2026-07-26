"use client";

import { useId, useState } from "react";
import type { FormEvent } from "react";
import {
  CORRECTION_FIELD_LABEL,
  CORRECTION_KIND_LABEL,
  correctionErrorMessage,
} from "@/lib/mutations/correction-messages";
import type { MutationOperationKind } from "@/lib/mutations/mutation-operation";

/**
 * The merchant-facing correction flow.
 *
 * Two deliberate rules shape this component. Nothing it does can write on its own — the preview
 * request only reserves a confirmation, and the write happens exclusively after an explicit
 * confirmation in the dialog. And a success message appears only when the server reports a
 * verified result, because only the server has read the catalog back; every other outcome, including
 * "we do not know", is shown as it is rather than softened into a success.
 *
 * While a request is in flight every control is disabled, so a double-click, an impatient second
 * submit, or a refresh cannot start a second mutation.
 */

export type CorrectableTarget = {
  productId: string;
  productName: string;
  variantId: string;
  variantLabel?: string;
  kind: MutationOperationKind;
  issueMessage: string;
  currentValue: string;
};

type PreviewState = {
  operationId: string;
  expiresAt: string;
  fieldLabel: string;
  previousValue: string;
  proposedValue: string;
  preservedFields: string[];
};

type ResultState = { tone: "success" | "warning"; message: string };

type Phase = "idle" | "previewing" | "confirming";

function displayValue(value: unknown) {
  if (value === null || value === undefined || value === "") return "— (boş)";
  return String(value);
}

export function CorrectionPanel({ targets }: { targets: CorrectableTarget[] }) {
  const [selected, setSelected] = useState<CorrectableTarget | undefined>();
  /** One value per row, so typing in one correction never disturbs another. */
  const [values, setValues] = useState<Record<string, string>>({});
  const [preview, setPreview] = useState<PreviewState | undefined>();
  const [phase, setPhase] = useState<Phase>("idle");
  const [result, setResult] = useState<ResultState | undefined>();
  const dialogTitleId = useId();
  const busy = phase !== "idle";

  function targetKey(target: CorrectableTarget) {
    return `${target.productId}:${target.variantId}:${target.kind}`;
  }

  function reset() {
    setSelected(undefined);
    setPreview(undefined);
    setPhase("idle");
  }

  async function requestPreview(event: FormEvent<HTMLFormElement>, target: CorrectableTarget) {
    event.preventDefault();
    if (busy) return;
    setPhase("previewing");
    setResult(undefined);

    const body: Record<string, unknown> = {
      kind: target.kind,
      productId: target.productId,
      variantId: target.variantId,
    };
    const raw = (values[targetKey(target)] ?? "").trim();
    if (target.kind === "sku_change") body.proposedSku = raw;
    if (target.kind === "price_change") body.proposedSellPrice = raw;
    if (target.kind === "stock_change") body.proposedStockCount = Number(raw);

    try {
      const response = await fetch("/api/product-corrections/preview", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      });
      const payload = (await response.json()) as Record<string, unknown>;
      if (!response.ok) {
        setResult({ tone: "warning", message: correctionErrorMessage(payload.error) });
        setPhase("idle");
        return;
      }
      const shown = payload.preview as Record<string, unknown>;
      setSelected(target);
      setPreview({
        operationId: String(payload.operationId),
        expiresAt: String(payload.expiresAt),
        fieldLabel: String(shown.fieldLabel),
        previousValue: displayValue(shown.previousValue),
        proposedValue: displayValue(shown.proposedValue),
        preservedFields: Array.isArray(shown.preservedFields)
          ? shown.preservedFields.map(String)
          : [],
      });
    } catch {
      setResult({ tone: "warning", message: correctionErrorMessage(undefined) });
    }
    setPhase("idle");
  }

  async function confirm() {
    if (!preview || busy) return;
    setPhase("confirming");
    try {
      const response = await fetch("/api/product-corrections/confirm", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ operationId: preview.operationId }),
      });
      const payload = (await response.json()) as Record<string, unknown>;
      if (!response.ok) {
        setResult({ tone: "warning", message: correctionErrorMessage(payload.error) });
      } else {
        // Reachable only after the server proved the value with a source-of-truth read.
        setResult({
          tone: "success",
          message: `Düzeltme uygulandı ve ikas'tan okunarak doğrulandı. Yeni değer: ${displayValue(payload.verifiedValue)}`,
        });
      }
    } catch {
      setResult({ tone: "warning", message: correctionErrorMessage(undefined) });
    }
    reset();
  }

  if (targets.length === 0) {
    return (
      <p className="rounded-md border border-border bg-surface-sunken px-4 py-3 text-sm text-text-muted">
        Son taramada düzeltilebilir bir sorun bulunmadı.
      </p>
    );
  }

  return (
    <div className="flex flex-col gap-4">
      {result ? (
        <p
          className={`rounded-md border px-4 py-3 text-sm font-medium ${
            result.tone === "success"
              ? "border-success bg-success-surface text-success"
              : "border-warning bg-warning-surface text-warning"
          }`}
          role={result.tone === "success" ? "status" : "alert"}
        >
          {result.message}
        </p>
      ) : null}

      <ul className="flex flex-col gap-3">
        {targets.map((target) => (
          <li
            className="rounded-lg border border-border bg-surface p-4"
            key={targetKey(target)}
          >
            <p className="font-medium text-text">
              {target.productName}
              {target.variantLabel ? ` — ${target.variantLabel}` : ""}
            </p>
            <p className="mt-1 text-sm text-text-muted">{target.issueMessage}</p>
            <p className="mt-1 text-sm text-text-muted">
              Mevcut değer: {displayValue(target.currentValue)}
            </p>

            <form
              className="mt-3 flex flex-wrap items-end gap-3"
              onSubmit={(event) => requestPreview(event, target)}
            >
              <div className="flex flex-col gap-1">
                <label
                  className="text-sm font-medium text-text"
                  htmlFor={`correction-${target.variantId}-${target.kind}`}
                >
                  {CORRECTION_FIELD_LABEL[target.kind]}
                </label>
                <input
                  className="min-h-11 w-56 rounded-md border border-border-strong bg-surface px-3 text-sm text-text focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent"
                  disabled={busy}
                  id={`correction-${target.variantId}-${target.kind}`}
                  inputMode={target.kind === "sku_change" ? "text" : "decimal"}
                  name="value"
                  onChange={(event) =>
                    setValues((current) => ({ ...current, [targetKey(target)]: event.target.value }))
                  }
                  value={values[targetKey(target)] ?? ""}
                />
              </div>
              <button
                className="inline-flex min-h-11 items-center justify-center rounded-md border border-border-strong bg-surface px-4 text-sm font-medium text-text transition hover:bg-surface-sunken disabled:cursor-not-allowed disabled:opacity-60"
                disabled={busy}
                type="submit"
              >
                {phase === "previewing" ? "Önizleme hazırlanıyor" : "Önizle"}
              </button>
              <p className="w-full text-sm text-text-muted">
                Önizleme hiçbir şey değiştirmez. Değişiklik yalnızca açık onayınızdan sonra uygulanır.
              </p>
            </form>
          </li>
        ))}
      </ul>

      {preview && selected ? (
        <div
          aria-labelledby={dialogTitleId}
          aria-modal="true"
          className="rounded-lg border border-accent bg-surface p-5 shadow-card"
          role="dialog"
        >
          <h3 className="text-title font-semibold text-text" id={dialogTitleId}>
            {CORRECTION_KIND_LABEL[selected.kind]} onayı
          </h3>
          <p className="mt-2 text-sm text-text-muted">
            {selected.productName}
            {selected.variantLabel ? ` — ${selected.variantLabel}` : ""}
          </p>

          <dl className="mt-3 grid gap-2 text-sm">
            <div className="flex gap-2">
              <dt className="font-medium text-text">Değişecek alan:</dt>
              <dd className="text-text-muted">{preview.fieldLabel}</dd>
            </div>
            <div className="flex gap-2">
              <dt className="font-medium text-text">Şu anki değer:</dt>
              <dd className="text-text-muted">{preview.previousValue}</dd>
            </div>
            <div className="flex gap-2">
              <dt className="font-medium text-text">Yeni değer:</dt>
              <dd className="text-text-muted">{preview.proposedValue}</dd>
            </div>
            <div className="flex gap-2">
              <dt className="font-medium text-text">Değişmeyecek:</dt>
              <dd className="text-text-muted">{preview.preservedFields.join(", ")}</dd>
            </div>
          </dl>

          <p className="mt-3 rounded-md border border-border bg-surface-sunken px-4 py-3 text-sm leading-6 text-text">
            Onayladığınızda bu tek alan ikas kataloğunuzda kalıcı olarak değiştirilir. Değişiklik
            uygulandıktan sonra ikas&apos;tan yeniden okunarak doğrulanır ve diğer alanların
            değişmediği kontrol edilir. Bu onay yalnızca bir kez kullanılabilir.
          </p>

          <div className="mt-4 flex flex-wrap gap-2">
            <button
              className="inline-flex min-h-11 items-center justify-center rounded-md bg-accent px-5 text-sm font-semibold text-accent-contrast transition hover:bg-accent-hover disabled:cursor-not-allowed disabled:bg-border-strong"
              disabled={busy}
              onClick={confirm}
              type="button"
            >
              {phase === "confirming" ? "Uygulanıyor" : "Onayla ve uygula"}
            </button>
            <button
              className="inline-flex min-h-11 items-center justify-center rounded-md border border-border-strong bg-surface px-4 text-sm font-medium text-text transition hover:bg-surface-sunken disabled:cursor-not-allowed disabled:opacity-60"
              disabled={busy}
              onClick={reset}
              type="button"
            >
              Vazgeç
            </button>
          </div>
        </div>
      ) : null}
    </div>
  );
}
