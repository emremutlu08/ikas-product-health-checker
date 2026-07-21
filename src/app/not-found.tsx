import Link from "next/link";

export default function NotFound() {
  return (
    <main className="min-h-screen bg-slate-50 px-4 py-12 text-slate-950 sm:px-6">
      <section className="mx-auto w-full max-w-2xl rounded-3xl border border-slate-200 bg-white p-6 shadow-sm sm:p-10">
        <p className="text-sm font-semibold uppercase tracking-[0.18em] text-orange-700">Ürün Sağlığı</p>
        <h1 className="mt-3 text-3xl font-bold tracking-tight">Sayfa bulunamadı</h1>
        <p className="mt-3 text-sm leading-6 text-slate-600 sm:text-base">
          Açmaya çalıştığınız adres artık kullanılmıyor veya hatalı olabilir.
        </p>
        <Link
          className="mt-7 inline-flex min-h-11 items-center justify-center rounded-xl bg-orange-600 px-5 py-3 text-sm font-semibold text-white transition hover:bg-orange-700 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-orange-600"
          href="/"
        >
          Ürün Sağlığına dön
        </Link>
      </section>
    </main>
  );
}
