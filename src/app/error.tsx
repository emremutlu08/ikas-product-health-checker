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
    <main className="min-h-screen bg-canvas px-4 py-12 text-text sm:px-6">
      <section className="mx-auto w-full max-w-2xl rounded-lg border border-border bg-surface p-6 shadow-card sm:p-10">
        <p className="text-label font-semibold uppercase text-accent">Ürün Sağlığı</p>
        <h1 className="mt-2 text-title font-semibold tracking-tight text-text">
          Rapor şu anda açılamıyor
        </h1>
        <p className="mt-3 text-sm leading-6 text-text-muted">
          Rapor güvenli biçimde tamamlanamadı. Sonuçları kısmi göstermeden işlemi durdurduk.
        </p>
        {supportCode ? (
          <code className="mt-5 block select-all rounded-md bg-surface-sunken px-3 py-2 font-mono text-xs text-text">
            Destek kodu: {supportCode}
          </code>
        ) : null}
        <div className="mt-7 flex flex-wrap gap-3">
          <button
            className="inline-flex min-h-11 items-center justify-center rounded-md bg-accent px-5 py-3 text-sm font-semibold text-accent-contrast transition hover:bg-accent-hover"
            onClick={unstable_retry}
            type="button"
          >
            Yeniden dene
          </button>
          <Link
            className="inline-flex min-h-11 items-center justify-center rounded-md border border-border-strong bg-surface px-5 py-3 text-sm font-semibold text-text transition hover:bg-surface-sunken"
            href="/authorize-store"
          >
            Bağlantı ayarlarına dön
          </Link>
        </div>
      </section>
    </main>
  );
}
