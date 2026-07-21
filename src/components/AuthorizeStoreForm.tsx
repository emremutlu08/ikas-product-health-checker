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
      className="w-full max-w-xl rounded-3xl border border-slate-200 bg-white p-6 shadow-sm sm:p-8"
      onSubmit={handleSubmit}
    >
      <p className="text-sm font-semibold uppercase tracking-[0.18em] text-orange-700">Ürün Sağlığı</p>
      <h1 className="mt-3 text-3xl font-bold tracking-tight text-slate-950">Mağazanı bağla</h1>
      <p className="mt-3 text-sm leading-6 text-slate-600 sm:text-base">
        ikas mağaza adresinde <strong className="font-semibold text-slate-950">.myikas.com</strong> öncesinde bulunan kısmı gir.
      </p>

      <label className="mt-6 block text-sm font-semibold text-slate-800" htmlFor="storeName">
        Mağaza adı
      </label>
      <div className="mt-2 flex rounded-xl border border-slate-300 bg-white shadow-sm focus-within:border-orange-600 focus-within:ring-2 focus-within:ring-orange-600/20">
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
          className="min-w-0 flex-1 rounded-l-xl bg-transparent px-4 py-3 text-slate-950 outline-none placeholder:text-slate-400"
          placeholder="dev-emre2"
        />
        <span aria-hidden="true" className="flex items-center rounded-r-xl border-l border-slate-200 bg-slate-50 px-3 text-sm text-slate-500">
          .myikas.com
        </span>
      </div>
      <p className="mt-2 text-sm leading-6 text-slate-500" id="storeName-help">
        Tam adresi yapıştırırsan mağaza adını otomatik olarak ayıklarız.
      </p>

      <section className="mt-5 rounded-2xl border border-slate-200 bg-slate-50 p-4" id="authorization-trust">
        <h2 className="text-sm font-semibold text-slate-950">Güvenli ve salt okunur bağlantı</h2>
        <ul className="mt-2 space-y-1 text-sm leading-6 text-slate-600">
          <li>Yalnızca ürün ve stok bilgilerini okur.</li>
          <li>Ürün veya stok bilgileri değiştirilmez.</li>
          <li>Bağlantıdan sonra ilk sağlık raporun açılır.</li>
        </ul>
      </section>

      {failureMessage ? (
        <div
          className="mt-4 rounded-2xl border border-red-200 bg-red-50 p-4 text-sm leading-6 text-red-900"
          id="authorization-error"
          role="alert"
        >
          <p className="font-semibold text-red-950">{failureMessage.title}</p>
          <p className="mt-1">{failureMessage.detail}</p>
          <p className="mt-1">{failureMessage.action}</p>
          {supportId ? (
            <div className="mt-3 rounded-xl border border-red-200 bg-white p-3">
              <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
                <p className="break-all text-xs text-red-950">
                  Destek kodu:{" "}
                  <code
                    className="select-all font-mono focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-orange-600"
                    tabIndex={0}
                  >
                    {supportId}
                  </code>
                </p>
                <button
                  className="shrink-0 rounded-lg border border-red-300 px-3 py-2 text-xs font-semibold text-red-900 transition hover:bg-red-50 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-orange-600"
                  onClick={copySupportCode}
                  type="button"
                >
                  {copyStatus === "copied" ? "Kopyalandı" : "Kopyala"}
                </button>
              </div>
              <p aria-live="polite" className="mt-2 text-xs text-red-800">
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
        className="mt-6 inline-flex min-h-11 w-full items-center justify-center rounded-xl bg-orange-600 px-5 py-3 text-sm font-bold text-white transition hover:bg-orange-700 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-orange-600"
        type="submit"
      >
        ikas ile güvenli şekilde bağlan
      </button>
      <p className="mt-3 text-center text-xs leading-5 text-slate-500">
        Yetkilendirmeyi ikas ekranında onaylayacaksın.
      </p>
    </form>
  );
}
