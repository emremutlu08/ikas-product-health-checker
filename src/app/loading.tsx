export default function Loading() {
  return (
    <main className="min-h-screen bg-slate-50 px-4 py-12 text-slate-950 sm:px-6">
      <section
        aria-live="polite"
        className="mx-auto w-full max-w-3xl rounded-3xl border border-slate-200 bg-white p-6 shadow-sm sm:p-10"
        role="status"
      >
        <div aria-hidden="true" className="h-2 w-24 animate-pulse rounded-full bg-orange-500" />
        <p className="mt-6 text-sm font-semibold uppercase tracking-[0.18em] text-orange-700">
          Ürün Sağlığı
        </p>
        <h1 className="mt-3 text-2xl font-bold tracking-tight sm:text-3xl">Sayfa hazırlanıyor</h1>
        <p className="mt-3 max-w-xl text-sm leading-6 text-slate-600 sm:text-base">
          İstenen ekran güvenli biçimde yükleniyor. Bu işlem bağlantı hızına göre biraz sürebilir.
        </p>
        <div aria-hidden="true" className="mt-8 grid gap-3 sm:grid-cols-3">
          <div className="h-20 animate-pulse rounded-2xl bg-slate-100" />
          <div className="h-20 animate-pulse rounded-2xl bg-slate-100" />
          <div className="h-20 animate-pulse rounded-2xl bg-slate-100" />
        </div>
      </section>
    </main>
  );
}
