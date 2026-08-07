"use client";

import { useId, useState } from "react";
import type { FormEvent } from "react";
import { ProductImagePreview } from "./ProductImagePreview";
import {
  BULK_SELECTION_LIMIT,
  CORRECTION_FIELD_LABEL,
  CORRECTION_KIND_LABEL,
  bulkErrorMessage,
  bulkItemReasonMessage,
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

type Phase = "idle" | "previewing" | "confirming" | "planning" | "executing" | "cancelling";

/** One planned correction the server accepted, paired back with the row it came from. */
type BulkReadyItem = {
  index: number;
  target: CorrectableTarget;
  fieldLabel: string;
  previousValue: string;
  proposedValue: string;
};

/** One the server refused at planning time, with the reason stated in the merchant's words. */
type BulkBlockedItem = { index: number; target: CorrectableTarget; message: string };

type BatchState = {
  batchId: string;
  planHash: string;
  ready: BulkReadyItem[];
  blocked: BulkBlockedItem[];
  /**
   * Set once execution stops early. A stopped batch is resumable by design — the server skips
   * everything already settled — so the merchant is offered that rather than a fresh plan, which
   * would re-attempt work that already succeeded.
   */
  resumable?: boolean;
};

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
  /**
   * Whether the merchant may run a batch at all, decided on the server from the plan grant and the
   * operator flag together. False hides the selection controls entirely rather than offering a
   * button the server would refuse.
   */
  bulkEnabled?: boolean;
};

export function CorrectionPanel({
  targets,
  selection,
  query,
  clearSearchHref,
  previousPageHref,
  nextPageHref,
  bulkEnabled = false,
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
  /**
   * Rows ticked for a batch, on this page.
   *
   * Deliberately not carried across pagination: a page holds `CORRECTION_PAGE_SIZE` rows and a
   * batch holds `BULK_SELECTION_LIMIT`, which are the same number, so one page is exactly one
   * batch. Remembering ticks through a navigation would let a merchant confirm a list whose
   * earlier half is no longer on screen.
   */
  const [chosen, setChosen] = useState<Record<string, true>>({});
  const [batch, setBatch] = useState<BatchState | undefined>();
  const dialogTitleId = useId();
  const batchTitleId = useId();
  const searchId = useId();
  const busy = phase !== "idle";

  function targetKey(target: CorrectableTarget) {
    return `${target.productId}:${target.variantId}:${target.kind}`;
  }

  /** The typed value for a row, trimmed; empty means the merchant has proposed nothing yet. */
  function typedValue(target: CorrectableTarget) {
    return (values[targetKey(target)] ?? "").trim();
  }

  function correctionBody(target: CorrectableTarget) {
    const body: Record<string, unknown> = {
      kind: target.kind,
      productId: target.productId,
      variantId: target.variantId,
    };
    const raw = typedValue(target);
    if (target.kind === "sku_change") body.proposedSku = raw;
    if (target.kind === "price_change") body.proposedSellPrice = raw;
    if (target.kind === "stock_change") body.proposedStockCount = Number(raw);
    return body;
  }

  /**
   * A row can join a batch only once it carries a value and has not already been written. Both
   * conditions are enforced again on the server; they are repeated here so the count beside the
   * button is the number that will actually be sent.
   */
  function isBatchable(target: CorrectableTarget) {
    return fixed[targetKey(target)] === undefined && typedValue(target) !== "";
  }

  const chosenTargets = targets.filter(
    (target) => chosen[targetKey(target)] === true && isBatchable(target),
  );

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

    try {
      const response = await fetch("/api/product-corrections/preview", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(correctionBody(target)),
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

  async function bulkPost(body: Record<string, unknown>) {
    const response = await fetch("/api/product-corrections/bulk", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    return { ok: response.ok, payload: (await response.json()) as Record<string, unknown> };
  }

  /**
   * Planning writes nothing. It asks the server to reserve one expiring confirmation per row and
   * hand back what each of them would change, so the merchant approves a list they have actually
   * read rather than a count.
   */
  async function planBulk() {
    if (busy || chosenTargets.length === 0) return;
    setPhase("planning");
    setResult(undefined);
    reset();

    // Index is the contract: the server answers by position, so the list sent is kept to map back.
    const sent = chosenTargets;
    try {
      const { ok, payload } = await bulkPost({
        action: "plan",
        items: sent.map(correctionBody),
      });
      if (!ok) {
        setResult({ tone: "warning", message: bulkErrorMessage(payload.error) });
        setPhase("idle");
        return;
      }

      const previewByIndex = new Map<number, Record<string, unknown>>();
      for (const entry of (payload.previews ?? []) as Array<Record<string, unknown>>) {
        previewByIndex.set(Number(entry.index), entry.preview as Record<string, unknown>);
      }

      const ready: BulkReadyItem[] = [];
      const blocked: BulkBlockedItem[] = [];
      for (const item of (payload.items ?? []) as Array<Record<string, unknown>>) {
        const index = Number(item.index);
        const target = sent[index];
        if (!target) continue;
        const shown = previewByIndex.get(index);
        if (item.state === "ready" && shown) {
          ready.push({
            index,
            target,
            fieldLabel: String(shown.fieldLabel),
            previousValue: displayValue(shown.previousValue),
            proposedValue: displayValue(shown.proposedValue),
          });
        } else {
          blocked.push({ index, target, message: bulkItemReasonMessage(item.reason) });
        }
      }

      setBatch({ batchId: String(payload.batchId), planHash: String(payload.planHash), ready, blocked });
    } catch {
      setResult({ tone: "warning", message: bulkErrorMessage(undefined) });
    }
    setPhase("idle");
  }

  async function executeBulk() {
    if (!batch || busy) return;
    setPhase("executing");
    try {
      const { ok, payload } = await bulkPost({
        action: "execute",
        batchId: batch.batchId,
        // Omitted on a resume: the server already holds the approved plan, and a second hash would
        // only be a chance to disagree with it.
        ...(batch.resumable ? {} : { planHash: batch.planHash }),
      });
      if (!ok) {
        setResult({ tone: "warning", message: bulkErrorMessage(payload.error) });
        setBatch(undefined);
        setPhase("idle");
        return;
      }

      const readyByIndex = new Map(batch.ready.map((item) => [item.index, item]));
      const verified: Record<string, string> = {};
      const settled = new Set<string>();
      for (const outcome of (payload.items ?? []) as Array<Record<string, unknown>>) {
        const item = readyByIndex.get(Number(outcome.index));
        if (!item) continue;
        settled.add(targetKey(item.target));
        // Only "succeeded" survived the server's read-back, so only it may be shown as fixed.
        if (outcome.status === "succeeded") verified[targetKey(item.target)] = item.proposedValue;
      }
      setFixed((current) => ({ ...current, ...verified }));
      setChosen((current) => {
        const next = { ...current };
        for (const key of settled) delete next[key];
        return next;
      });

      const succeeded = Number(payload.succeeded ?? 0);
      const rejected = Number(payload.rejected ?? 0);
      const failedUnknown = Number(payload.failedUnknown ?? 0);
      const skipped = Number(payload.skipped ?? 0);
      const stopped = payload.status === "stopped";

      const parts = [`${succeeded} düzeltme uygulandı ve ikas'tan okunarak doğrulandı`];
      if (rejected > 0) parts.push(`${rejected} tanesi reddedildi ve yazılmadı`);
      if (failedUnknown > 0) parts.push(`${failedUnknown} tanesinin sonucu doğrulanamadı`);
      if (skipped > 0) parts.push(`${skipped} tanesi atlandı`);
      if (stopped) {
        parts.push("toplu işlem güvenlik gereği erken durduruldu ve kaldığı yerden sürdürülebilir");
      }

      setResult({
        // Anything the app could not verify outranks the successes beside it: a merchant who reads
        // a green banner will not go and check their catalog, which is exactly what an unknown
        // outcome requires them to do.
        tone: failedUnknown > 0 || stopped ? "warning" : "success",
        message: `${parts.join(", ")}.`,
      });

      if (stopped) {
        setBatch((current) => (current ? { ...current, resumable: true } : current));
      } else {
        setBatch(undefined);
      }
    } catch {
      setResult({ tone: "warning", message: bulkErrorMessage(undefined) });
      setBatch(undefined);
    }
    setPhase("idle");
  }

  async function cancelBulk() {
    if (!batch || busy) return;
    setPhase("cancelling");
    try {
      await bulkPost({ action: "cancel", batchId: batch.batchId });
    } catch {
      // A cancel that never reached the server leaves an unconfirmed plan, which expires on its
      // own and can write nothing in the meantime. Nothing here needs to be reported as a failure.
    }
    setBatch(undefined);
    setPhase("idle");
  }

  const fixedCount = Object.keys(fixed).length;
  const batchableOnPage = targets.filter(isBatchable);
  const allChosen =
    batchableOnPage.length > 0 &&
    batchableOnPage.every((target) => chosen[targetKey(target)] === true);

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

      {/*
        The batch controls sit above the list rather than at its foot, because the merchant decides
        to batch before working through fifty rows, not after scrolling past them.
      */}
      {bulkEnabled && !batch ? (
        <div className="flex flex-col gap-3 rounded-lg border border-border bg-surface-sunken p-4 sm:flex-row sm:items-center sm:justify-between">
          <div className="flex min-w-0 flex-col gap-1">
            <label className="flex items-center gap-2 text-sm font-medium text-text">
              <input
                aria-label="Bu sayfadaki uygun düzeltmelerin tümünü seç"
                checked={allChosen}
                className="size-4 accent-accent"
                disabled={busy || batchableOnPage.length === 0}
                onChange={(event) =>
                  setChosen((current) => {
                    const next = { ...current };
                    for (const target of batchableOnPage) {
                      if (event.target.checked) next[targetKey(target)] = true;
                      else delete next[targetKey(target)];
                    }
                    return next;
                  })
                }
                type="checkbox"
              />
              {chosenTargets.length > 0
                ? `${chosenTargets.length} düzeltme toplu işleme seçildi`
                : "Toplu düzeltme"}
            </label>
            <p className="text-sm text-text-muted">
              {batchableOnPage.length === 0
                ? "Toplu işleme almak için önce düzeltmek istediğiniz satırlara yeni değeri yazın."
                : `Değer yazdığınız satırları işaretleyip tek onayla uygulayın. Tek seferde en fazla ${BULK_SELECTION_LIMIT} düzeltme.`}
            </p>
          </div>
          <button
            className="inline-flex min-h-11 shrink-0 items-center justify-center rounded-md bg-accent px-5 text-sm font-semibold text-accent-contrast transition hover:bg-accent-hover disabled:cursor-not-allowed disabled:bg-border-strong"
            disabled={busy || chosenTargets.length === 0}
            onClick={planBulk}
            type="button"
          >
            {phase === "planning" ? "Önizleme hazırlanıyor" : "Toplu önizleme oluştur"}
          </button>
        </div>
      ) : null}

      {/*
        One approval for the whole list, so the list itself has to be readable: every change is
        named with its product, its field and both values. Nothing here has been written yet.
      */}
      {batch ? (
        <div
          aria-labelledby={batchTitleId}
          className="rounded-lg border border-accent bg-surface p-4"
          role="dialog"
        >
          <h3 className="text-title font-semibold text-text" id={batchTitleId}>
            {batch.resumable
              ? "Toplu düzeltme yarıda kaldı"
              : `Toplu düzeltme onayı — ${batch.ready.length} değişiklik`}
          </h3>

          {batch.resumable ? (
            <p className="mt-2 text-sm leading-6 text-text-muted">
              İşlem güvenlik gereği erken durduruldu. Devam ederseniz yalnızca henüz uygulanmamış
              satırlar denenir; tamamlanmış bir düzeltme ikinci kez çalıştırılmaz.
            </p>
          ) : null}

          {batch.ready.length > 0 ? (
            <ul className="mt-3 flex flex-col divide-y divide-border rounded-md border border-border">
              {batch.ready.map((item) => (
                <li className="flex flex-col gap-1 px-4 py-3 text-sm" key={targetKey(item.target)}>
                  <span className="font-medium text-text">
                    {item.target.productName}
                    {item.target.variantLabel ? ` — ${item.target.variantLabel}` : ""}
                  </span>
                  <span className="text-text-muted">
                    {item.fieldLabel}: {item.previousValue} → {item.proposedValue}
                  </span>
                </li>
              ))}
            </ul>
          ) : null}

          {batch.blocked.length > 0 ? (
            <div className="mt-3 rounded-md border border-warning bg-warning-surface px-4 py-3">
              <p className="text-sm font-medium text-warning">
                {batch.blocked.length} düzeltme bu listeye alınamadı ve uygulanmayacak
              </p>
              <ul className="mt-2 flex flex-col gap-1 text-sm text-warning">
                {batch.blocked.map((item) => (
                  <li key={targetKey(item.target)}>
                    {item.target.productName}
                    {item.target.variantLabel ? ` — ${item.target.variantLabel}` : ""}:{" "}
                    {item.message}
                  </li>
                ))}
              </ul>
            </div>
          ) : null}

          {/*
            One expression rather than JSX text with `{batch.ready.length}` embedded in it.
            Written the ordinary way this rendered "yukarıdaki 2değişiklik" in the browser — the
            space after the count vanished.

            The trigger is the combination: an interpolated value *and* an HTML entity in the same
            run of JSX text. Two other counts in this file are written the ordinary way and compile
            correctly (`[blocked.length," düzeltme…"]`, `[kindLabel," onayı"]`); this paragraph is
            the only one that also carried `&apos;`. Worse, the compiler the unit tests use keeps
            the space where the build's drops it, so no assertion in this repository could have
            caught it — it was found by reading the rendered page. A single template literal has
            neither hazard and takes a real apostrophe.
          */}
          <p className="mt-3 rounded-md border border-border bg-surface-sunken px-4 py-3 text-sm leading-6 text-text">
            {`Onayladığınızda yukarıdaki ${batch.ready.length} değişiklik ikas kataloğunuzda ` +
              `kalıcı olarak uygulanır. Her satır ayrı ayrı yazılır, yazma sonrası ikas'tan ` +
              `yeniden okunarak doğrulanır ve diğer alanların değişmediği kontrol edilir. ` +
              `Bu onay yalnızca bir kez kullanılabilir.`}
          </p>

          <div className="mt-4 flex flex-wrap gap-2">
            <button
              className="inline-flex min-h-11 items-center justify-center rounded-md bg-accent px-5 text-sm font-semibold text-accent-contrast transition hover:bg-accent-hover disabled:cursor-not-allowed disabled:bg-border-strong"
              disabled={busy || batch.ready.length === 0}
              onClick={executeBulk}
              type="button"
            >
              {phase === "executing"
                ? "Uygulanıyor"
                : batch.resumable
                  ? "Kaldığı yerden devam et"
                  : `Onayla ve ${batch.ready.length} düzeltmeyi uygula`}
            </button>
            <button
              className="inline-flex min-h-11 items-center justify-center rounded-md border border-border-strong bg-surface px-4 text-sm font-medium text-text transition hover:bg-surface-sunken disabled:cursor-not-allowed disabled:opacity-60"
              disabled={busy}
              onClick={cancelBulk}
              type="button"
            >
              {phase === "cancelling" ? "Vazgeçiliyor" : "Vazgeç"}
            </button>
          </div>
        </div>
      ) : null}

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
                {/*
                  The tick is offered only once the row carries a value, because a batch item with
                  nothing proposed is not a correction. Disabled rather than hidden so the reason
                  is visible: the merchant can see the control and read why it is not available yet.
                */}
                {bulkEnabled ? (
                  <label className="flex items-center gap-2 text-sm text-text">
                    <input
                      checked={chosen[targetKey(target)] === true && isBatchable(target)}
                      className="size-4 accent-accent"
                      disabled={busy || !isBatchable(target)}
                      onChange={(event) =>
                        setChosen((current) => {
                          const next = { ...current };
                          if (event.target.checked) next[targetKey(target)] = true;
                          else delete next[targetKey(target)];
                          return next;
                        })
                      }
                      type="checkbox"
                    />
                    {isBatchable(target)
                      ? "Toplu işleme ekle"
                      : "Toplu işleme eklemek için önce bir değer yazın"}
                  </label>
                ) : null}
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
