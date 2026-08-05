"use client";

import { useId, useState } from "react";
import type { FormEvent } from "react";
import { ProductImagePreview } from "./ProductImagePreview";
import {
  CORRECTION_FIELD_LABEL,
  CORRECTION_KIND_LABEL,
  correctionErrorMessage,
} from "@/lib/mutations/correction-messages";
import type { MutationOperationKind } from "@/lib/mutations/mutation-operation";
import type { CorrectionQuery, CorrectionSelection } from "@/lib/mutations/correction-list";

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
  /** Initials shown when there is no usable image, so a row is never a blank square. */
  imageLabel: string;
  imageSrc?: string;
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

export type CorrectionPanelProps = {
  /** One server-selected page of targets. The component never filters or slices. */
  targets: CorrectableTarget[];
  selection: CorrectionSelection;
  query: CorrectionQuery;
  /**
   * Ready-made URLs rather than a builder function.
   *
   * This is a client component, and React refuses to serialize a function across that boundary —
   * passing one renders the whole screen as an error. The server knows every destination before
   * it renders, so it computes them here and hands over plain strings. Absent means "no such
   * page", which is what the disabled control below reflects.
   */
  clearSearchHref?: string;
  previousPageHref?: string;
  nextPageHref?: string;
};

export function CorrectionPanel({
  targets,
  selection,
  query,
  clearSearchHref,
  previousPageHref,
  nextPageHref,
}: CorrectionPanelProps) {
  const [selected, setSelected] = useState<CorrectableTarget | undefined>();
  /**
   * Targets this session has fixed, keyed the same way the list is, holding the value the server
   * read back from ikas.
   *
   * The list itself comes from the stored scan and cannot change until the next one, so without
   * this a merchant who just corrected a SKU still saw "Aktif varyantta SKU eksik — Mevcut değer:
   * — (boş)" under a message claiming the write was verified. They would either do it twice or
   * stop believing the message.
   */
  const [fixed, setFixed] = useState<Record<string, string>>({});
  /** One value per row, so typing in one correction never disturbs another. */
  const [values, setValues] = useState<Record<string, string>>({});
  const [preview, setPreview] = useState<PreviewState | undefined>();
  const [phase, setPhase] = useState<Phase>("idle");
  const [result, setResult] = useState<ResultState | undefined>();
  const dialogTitleId = useId();
  const searchId = useId();
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
        // Reachable only after the server proved the value with a source-of-truth read, so this
        // is the one place a target may be shown as fixed.
        const verified = displayValue(payload.verifiedValue);
        setResult({
          tone: "success",
          message: `Düzeltme uygulandı ve ikas'tan okunarak doğrulandı. Yeni değer: ${verified}`,
        });
        if (selected) {
          setFixed((current) => ({ ...current, [targetKey(selected)]: verified }));
        }
      }
    } catch {
      setResult({ tone: "warning", message: correctionErrorMessage(undefined) });
    }
    reset();
  }

  const fixedCount = Object.keys(fixed).length;

  if (selection.unfilteredTargets === 0) {
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

      {/*
        A GET form, not client state: the server does the filtering, so the result is a real URL
        that survives a reload and can be linked. Submitting always returns to page one, because
        page 4 of the previous result set is almost never a page of the new one.
      */}
      <form action="/corrections" className="flex flex-wrap items-end gap-2" method="get">
        <div className="flex flex-col gap-1">
          <label className="text-sm font-medium text-text" htmlFor={`${searchId}-search`}>
            Ürün ara
          </label>
          <input
            className="min-h-11 w-full min-w-0 rounded-md border border-border-strong bg-surface px-3 text-sm text-text placeholder:text-text-muted focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent sm:w-72"
            defaultValue={query.search}
            id={`${searchId}-search`}
            name="q"
            placeholder="Ürün veya varyant adı"
            type="search"
          />
        </div>
        <button
          className="inline-flex min-h-11 items-center justify-center rounded-md bg-accent px-4 text-sm font-semibold text-accent-contrast transition hover:bg-accent-hover"
          type="submit"
        >
          Ara
        </button>
        {query.search && clearSearchHref ? (
          <a
            className="inline-flex min-h-11 items-center justify-center rounded-md border border-border-strong px-4 text-sm font-medium text-text transition hover:bg-surface-sunken"
            href={clearSearchHref}
          >
            Temizle
          </a>
        ) : null}
      </form>

      <p className="text-sm text-text-muted">
        {selection.totalTargets === 0
          ? "Aramanızla eşleşen düzeltme yok."
          : `${selection.rangeStart}–${selection.rangeEnd} / ${selection.totalTargets} düzeltme` +
            (query.search ? ` (toplam ${selection.unfilteredTargets})` : "")}
        {/*
          Progress, not inventory. The range above says how long the list is; this says how far the
          merchant has got. It counts only writes the server verified against ikas, and it is
          scoped to this session because the stored scan has no idea any of it happened.
        */}
        {fixedCount > 0 ? (
          <span className="font-medium text-success">
            {" "}
            · Bu oturumda {fixedCount} düzeltme uygulandı.
          </span>
        ) : null}
      </p>

      <ul className="flex flex-col gap-3">
        {targets.map((target) => {
          const isSelected = selected ? targetKey(selected) === targetKey(target) : false;
          const fixedValue = fixed[targetKey(target)];

          return (
          <li
            className={`rounded-lg border bg-surface p-4 ${
              fixedValue !== undefined
                ? "border-success"
                : isSelected
                  ? "border-accent"
                  : "border-border"
            }`}
            key={targetKey(target)}
          >
            {/*
              What the merchant is looking at sits on the left, what they do about it on the right,
              so a long list scans as two columns instead of a stack of near-identical blocks. The
              split collapses below `sm` because the field and its button need the full width on a
              phone; `min-w-0` on the left keeps a long product name from pushing the form off the
              card instead of wrapping.
            */}
            <div className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
              <div className="flex min-w-0 items-start gap-3">
                <ProductImagePreview
                  alt={target.productName}
                  label={target.imageLabel}
                  src={target.imageSrc}
                />
                <div className="min-w-0">
                  <p className="font-medium text-text">
                    {target.productName}
                    {target.variantLabel ? ` — ${target.variantLabel}` : ""}
                  </p>
                  <p className="mt-1 text-sm text-text-muted">{target.issueMessage}</p>
                  <p className="mt-1 text-sm text-text-muted">
                    Mevcut değer: {displayValue(target.currentValue)}
                  </p>
                </div>
              </div>

              {fixedValue === undefined ? (
              <form
                className="flex flex-col gap-2 sm:w-72 sm:shrink-0"
                onSubmit={(event) => requestPreview(event, target)}
              >
                <div className="flex flex-wrap items-end gap-3">
                  <div className="flex flex-col gap-1">
                    <label
                      className="text-sm font-medium text-text"
                      htmlFor={`correction-${target.variantId}-${target.kind}`}
                    >
                      {CORRECTION_FIELD_LABEL[target.kind]}
                    </label>
                    <input
                      className="min-h-11 w-full min-w-0 rounded-md border border-border-strong bg-surface px-3 text-sm text-text focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent sm:w-44"
                      disabled={busy}
                      id={`correction-${target.variantId}-${target.kind}`}
                      inputMode={target.kind === "sku_change" ? "text" : "decimal"}
                      name="value"
                      onChange={(event) =>
                        setValues((current) => ({
                          ...current,
                          [targetKey(target)]: event.target.value,
                        }))
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
                </div>
                <p className="text-sm text-text-muted">
                  Önizleme hiçbir şey değiştirmez. Değişiklik yalnızca açık onayınızdan sonra
                  uygulanır.
                </p>
              </form>
              ) : null}
            </div>
            {/*
              The confirmation opens under the card it belongs to, not at the foot of the list.
              With fifty corrections on a page, a panel at the bottom means scrolling away from the
              row being confirmed and reading "Şu anki değer" with no sight of the product it
              belongs to. `aria-modal` is deliberately absent: nothing outside this block is inert,
              and claiming otherwise would tell a screen reader the rest of the page is unavailable.
            */}
            {isSelected && preview ? (
              <div
                aria-labelledby={dialogTitleId}
                className="mt-4 rounded-md border border-accent bg-surface-sunken p-4"
                role="dialog"
              >
                <h3 className="text-title font-semibold text-text" id={dialogTitleId}>
                  {CORRECTION_KIND_LABEL[target.kind]} onayı
                </h3>
                <p className="mt-2 text-sm text-text-muted">
                  {target.productName}
                  {target.variantLabel ? ` — ${target.variantLabel}` : ""}
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

                <p className="mt-3 rounded-md border border-border bg-surface px-4 py-3 text-sm leading-6 text-text">
                  Onayladığınızda bu tek alan ikas kataloğunuzda kalıcı olarak değiştirilir.
                  Değişiklik uygulandıktan sonra ikas&apos;tan yeniden okunarak doğrulanır ve diğer
                  alanların değişmediği kontrol edilir. Bu onay yalnızca bir kez kullanılabilir.
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
          </li>
          );
        })}
      </ul>

      {selection.pageCount > 1 ? (
        <nav aria-label="Sayfalama" className="flex flex-wrap items-center gap-2">
          {previousPageHref ? (
            <a
              className="inline-flex min-h-11 items-center rounded-md border border-border-strong px-4 text-sm font-medium text-text transition hover:bg-surface-sunken"
              href={previousPageHref}
            >
              Önceki
            </a>
          ) : (
            <span
              aria-disabled="true"
              className="inline-flex min-h-11 items-center rounded-md border border-border px-4 text-sm font-medium text-text-muted"
            >
              Önceki
            </span>
          )}
          <span className="text-sm text-text-muted">
            Sayfa {selection.page} / {selection.pageCount}
          </span>
          {nextPageHref ? (
            <a
              className="inline-flex min-h-11 items-center rounded-md border border-border-strong px-4 text-sm font-medium text-text transition hover:bg-surface-sunken"
              href={nextPageHref}
            >
              Sonraki
            </a>
          ) : (
            <span
              aria-disabled="true"
              className="inline-flex min-h-11 items-center rounded-md border border-border px-4 text-sm font-medium text-text-muted"
            >
              Sonraki
            </span>
          )}
        </nav>
      ) : null}

    </div>
  );
}
