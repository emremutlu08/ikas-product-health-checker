"use client";

import { normalizeStoreNameInput } from "@/lib/ikas/store-name";
import { useState } from "react";
import type { FormEvent } from "react";

type AuthorizeStoreFormProps = {
  initialStoreName: string;
  failed: boolean;
};

export function AuthorizeStoreForm({ initialStoreName, failed }: AuthorizeStoreFormProps) {
  const [storeName, setStoreName] = useState(initialStoreName);

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

  return (
    <form action="/api/oauth/authorize/ikas" className="w-full max-w-xl rounded-3xl border border-white/10 bg-white/[0.04] p-8 shadow-2xl" onSubmit={handleSubmit}>
      <p className="text-sm font-semibold uppercase tracking-[0.25em] text-emerald-300">ikas Ürün Sağlığı</p>
      <h1 className="mt-3 text-3xl font-bold">Mağazanı bağla</h1>
      <p className="mt-3 text-sm leading-6 text-slate-300">
        ikas admin adresin <strong className="font-semibold text-white">{"{storeName}.myikas.com/admin"}</strong> ise aşağıya sadece{" "}
        <strong className="font-semibold text-white">{"{storeName}"}</strong> kısmını yaz. Örneğin <strong className="font-semibold text-white">foo.myikas.com/admin</strong>{" "}
        için <strong className="font-semibold text-white">foo</strong> girilir.
      </p>

      <label className="mt-6 block text-sm font-medium text-slate-200" htmlFor="storeName">
        Mağaza adı
      </label>
      <input
        id="storeName"
        name="storeName"
        value={storeName}
        onBlur={polishStoreName}
        onChange={(event) => setStoreName(event.target.value)}
        required
        autoFocus
        autoComplete="organization"
        className="mt-2 w-full rounded-2xl border border-white/10 bg-slate-900 px-4 py-3 text-white outline-none ring-0 placeholder:text-slate-500 focus:border-emerald-300"
        placeholder="foo"
      />

      {failed ? (
        <div className="mt-4 rounded-2xl border border-red-300/30 bg-red-500/10 p-4 text-sm leading-6 text-red-100">
          <p className="font-semibold text-red-50">ikas yetkilendirmesi tamamlanamadı.</p>
          <p className="mt-1">
            Mağaza adını kontrol edip tekrar dene. Alan adı veya admin adresinin tamamını yapıştırdıysan sorun değil; gönderirken{" "}
            <strong className="font-semibold">foo.myikas.com/admin</strong> değeri <strong className="font-semibold">foo</strong> olarak düzenlenir.
          </p>
          <p className="mt-1">Devam edemezsen ikas admin panelindeki mağaza alt alan adını kopyalayıp bu alana yalnızca o kısmı yaz.</p>
        </div>
      ) : null}

      <button className="mt-6 w-full rounded-full bg-emerald-400 px-5 py-3 text-sm font-bold text-slate-950 hover:bg-emerald-300" type="submit">
        Mağazama bağla
      </button>
    </form>
  );
}
