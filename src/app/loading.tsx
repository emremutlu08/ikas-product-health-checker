/**
 * The fallback Next renders while a route resolves. A merchant sees it inside the same iframe
 * as the dashboard, so it uses the same tokens, radius and type scale rather than a second
 * visual system that makes every navigation look like a jump between two products.
 */
export default function Loading() {
  return (
    <main className="min-h-screen bg-canvas px-4 py-12 text-text sm:px-6">
      <section
        aria-live="polite"
        className="mx-auto w-full max-w-3xl rounded-lg border border-border bg-surface p-6 shadow-card sm:p-10"
        role="status"
      >
        <div aria-hidden="true" className="h-2 w-24 animate-pulse rounded-sm bg-accent" />
        <p className="mt-6 text-label font-semibold uppercase text-accent">Ürün Sağlığı</p>
        <h1 className="mt-2 text-title font-semibold tracking-tight text-text">
          Sayfa hazırlanıyor
        </h1>
        <p className="mt-3 max-w-xl text-sm leading-6 text-text-muted">
          İstenen ekran güvenli biçimde yükleniyor. Bu işlem bağlantı hızına göre biraz sürebilir.
        </p>
        <div aria-hidden="true" className="mt-8 grid gap-3 sm:grid-cols-3">
          <div className="h-20 animate-pulse rounded-md bg-surface-sunken" />
          <div className="h-20 animate-pulse rounded-md bg-surface-sunken" />
          <div className="h-20 animate-pulse rounded-md bg-surface-sunken" />
        </div>
      </section>
    </main>
  );
}
