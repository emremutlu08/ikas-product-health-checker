"use client";

import Link from "next/link";

type ErrorBoundaryProps = {
  error: Error & { digest?: string };
  reset: () => void;
  unstable_retry: () => void;
};

function normalizeDigest(digest?: string) {
  if (!digest || !/^[A-Za-z0-9_-]{1,128}$/.test(digest)) return "";
  return digest;
}

export default function ErrorBoundary({ error, unstable_retry }: ErrorBoundaryProps) {
  const supportCode = normalizeDigest(error.digest);

  return (
    <main className="min-h-screen bg-slate-50 px-4 py-12 text-slate-950 sm:px-6">
      <section className="mx-auto w-full max-w-2xl rounded-3xl border border-slate-200 bg-white p-6 shadow-sm sm:p-10">
        <p className="text-sm font-semibold uppercase tracking-[0.18em] text-orange-700">Ürün Sağlığı</p>
        <h1 className="mt-3 text-3xl font-bold tracking-tight">Rapor şu anda açılamıyor</h1>
        <p className="mt-3 text-sm leading-6 text-slate-600 sm:text-base">
          Rapor güvenli biçimde tamamlanamadı. Sonuçları kısmi göstermeden işlemi durdurduk.
        </p>
        {supportCode ? (
          <code className="mt-5 block select-all rounded-xl bg-slate-100 px-3 py-2 font-mono text-xs text-slate-700">
            Destek kodu: {supportCode}
          </code>
        ) : null}
        <div className="mt-7 flex flex-wrap gap-3">
          <button
            className="inline-flex min-h-11 items-center justify-center rounded-xl bg-orange-600 px-5 py-3 text-sm font-semibold text-white transition hover:bg-orange-700 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-orange-600"
            onClick={unstable_retry}
            type="button"
          >
            Yeniden dene
          </button>
          <Link
            className="inline-flex min-h-11 items-center justify-center rounded-xl border border-slate-300 bg-white px-5 py-3 text-sm font-semibold text-slate-700 transition hover:bg-slate-50 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-orange-600"
            href="/authorize-store"
          >
            Bağlantı ayarlarına dön
          </Link>
        </div>
      </section>
    </main>
  );
}
