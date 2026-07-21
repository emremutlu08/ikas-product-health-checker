import Link from "next/link";

export default function NotFound() {
  return (
    <main className="min-h-screen bg-canvas px-4 py-12 text-text sm:px-6">
      <section className="mx-auto w-full max-w-2xl rounded-lg border border-border bg-surface p-6 shadow-card sm:p-10">
        <p className="text-label font-semibold uppercase text-accent">Ürün Sağlığı</p>
        <h1 className="mt-2 text-title font-semibold tracking-tight text-text">Sayfa bulunamadı</h1>
        <p className="mt-3 text-sm leading-6 text-text-muted">
          Açmaya çalıştığınız adres artık kullanılmıyor veya hatalı olabilir.
        </p>
        {/* Focus is drawn by the shared :focus-visible rule in globals.css. */}
        <Link
          className="mt-7 inline-flex min-h-11 items-center justify-center rounded-md bg-accent px-5 py-3 text-sm font-semibold text-accent-contrast transition hover:bg-accent-hover"
          href="/"
        >
          Ürün Sağlığına dön
        </Link>
      </section>
    </main>
  );
}
