"use client";

import { OAUTH_FAILURE_MESSAGES, type OAuthFailureReason } from "@/lib/ikas/oauth-failure";
import { normalizeStoreNameInput } from "@/lib/ikas/store-name";
import { useState } from "react";
import type { FormEvent } from "react";

type AuthorizeStoreFormProps = {
  initialStoreName: string;
  failureReason?: OAuthFailureReason;
  supportId: string;
};

export function AuthorizeStoreForm({ initialStoreName, failureReason, supportId }: AuthorizeStoreFormProps) {
  const [storeName, setStoreName] = useState(initialStoreName);
  const [copyStatus, setCopyStatus] = useState<"idle" | "copied" | "failed">("idle");
  const failureMessage = failureReason ? OAUTH_FAILURE_MESSAGES[failureReason] : undefined;
  const storeNameInvalid = failureReason === "invalid_store_name";
  const describedBy = storeNameInvalid ? "storeName-help authorization-error" : "storeName-help";

  function polishStoreName() {
    const normalized = normalizeStoreNameInput(storeName);
    if (normalized) setStoreName(normalized);
    return normalized;
  }

  function handleSubmit(event: FormEvent<HTMLFormElement>) {
    const normalized = polishStoreName();
    const input = event.currentTarget.elements.namedItem("storeName");
    if (input instanceof HTMLInputElement && normalized) {
      input.value = normalized;
    }
  }

  async function copySupportCode() {
    if (!supportId || !navigator.clipboard) {
      setCopyStatus("failed");
      return;
    }
    try {
      await navigator.clipboard.writeText(supportId);
      setCopyStatus("copied");
    } catch {
      setCopyStatus("failed");
    }
  }

  return (
    <form
      action="/api/oauth/authorize/ikas"
      className="w-full max-w-xl rounded-lg border border-border bg-surface p-6 shadow-card sm:p-8"
      onSubmit={handleSubmit}
    >
      <p className="text-label font-semibold uppercase text-accent">Ürün Sağlığı</p>
      <h1 className="mt-2 text-title font-semibold tracking-tight text-text">Mağazanı bağla</h1>
      <p className="mt-3 text-sm leading-6 text-text-muted">
        ikas mağaza adresinde <strong className="font-semibold text-text">.myikas.com</strong> öncesinde bulunan kısmı gir.
      </p>

      <label className="mt-6 block text-sm font-semibold text-text" htmlFor="storeName">
        Mağaza adı
      </label>
      <div className="mt-2 flex rounded-md border border-border-strong bg-surface focus-within:border-accent">
        <input
          id="storeName"
          name="storeName"
          value={storeName}
          onBlur={polishStoreName}
          onChange={(event) => setStoreName(event.target.value)}
          required
          autoFocus
          autoComplete="off"
          aria-describedby={describedBy}
          aria-invalid={storeNameInvalid || undefined}
          className="min-w-0 flex-1 rounded-l-md bg-transparent px-4 py-3 text-text outline-none placeholder:text-text-muted"
          placeholder="dev-emre2"
        />
        <span aria-hidden="true" className="flex items-center rounded-r-md border-l border-border bg-surface-sunken px-3 text-sm text-text-muted">
          .myikas.com
        </span>
      </div>
      <p className="mt-2 text-sm leading-6 text-text-muted" id="storeName-help">
        Tam adresi yapıştırırsan mağaza adını otomatik olarak ayıklarız.
      </p>

      <section className="mt-5 rounded-md border border-border bg-surface-sunken p-4" id="authorization-trust">
        <h2 className="text-sm font-semibold text-text">Güvenli ve salt okunur bağlantı</h2>
        <ul className="mt-2 space-y-1 text-sm leading-6 text-text-muted">
          <li>Yalnızca ürün ve stok bilgilerini okur.</li>
          <li>Ürün veya stok bilgileri değiştirilmez.</li>
          <li>Bağlantıdan sonra ilk sağlık raporun açılır.</li>
        </ul>
      </section>

      {failureMessage ? (
        <div
          className="mt-4 rounded-md border border-critical bg-critical-surface p-4 text-sm leading-6 text-critical"
          id="authorization-error"
          role="alert"
        >
          <p className="font-semibold">{failureMessage.title}</p>
          <p className="mt-1">{failureMessage.detail}</p>
          <p className="mt-1">{failureMessage.action}</p>
          {supportId ? (
            <div className="mt-3 rounded-md border border-critical bg-surface p-3">
              <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
                <p className="break-all text-xs text-critical">
                  Destek kodu:{" "}
                  {/* The shared focus style in globals.css covers this; no per-element ring. */}
                  <code className="select-all font-mono" tabIndex={0}>
                    {supportId}
                  </code>
                </p>
                <button
                  className="shrink-0 rounded-md border border-critical px-3 py-2 text-xs font-semibold text-critical transition hover:bg-critical-surface"
                  onClick={copySupportCode}
                  type="button"
                >
                  {copyStatus === "copied" ? "Kopyalandı" : "Kopyala"}
                </button>
              </div>
              <p aria-live="polite" className="mt-2 text-xs text-critical">
                {copyStatus === "copied"
                  ? "Destek kodu kopyalandı."
                  : copyStatus === "failed"
                    ? "Kod kopyalanamadı. Destek kodunu seçip elle kopyala."
                    : ""}
              </p>
            </div>
          ) : null}
        </div>
      ) : null}

      <button
        className="mt-6 inline-flex min-h-11 w-full items-center justify-center rounded-md bg-accent px-5 py-3 text-sm font-semibold text-accent-contrast transition hover:bg-accent-hover"
        type="submit"
      >
        ikas ile güvenli şekilde bağlan
      </button>
      <p className="mt-3 text-center text-xs leading-5 text-text-muted">
        Yetkilendirmeyi ikas ekranında onaylayacaksın.
      </p>
    </form>
  );
}
