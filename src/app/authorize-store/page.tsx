export default function AuthorizeStorePage({ searchParams }: { searchParams?: Promise<{ status?: string; storeName?: string }> }) {
  return <AuthorizeStoreContent searchParams={searchParams} />;
}

async function AuthorizeStoreContent({ searchParams }: { searchParams?: Promise<{ status?: string; storeName?: string }> }) {
  const params = (await searchParams) ?? {};
  const failed = params.status === "fail";
  const storeName = params.storeName ?? "";

  return (
    <main className="flex min-h-screen items-center justify-center bg-slate-950 px-6 text-white">
      <form action="/api/oauth/authorize/ikas" className="w-full max-w-md rounded-3xl border border-white/10 bg-white/[0.04] p-8 shadow-2xl">
        <p className="text-sm font-semibold uppercase tracking-[0.25em] text-emerald-300">ikas Product Health</p>
        <h1 className="mt-3 text-3xl font-bold">Mağazanı bağla</h1>
        <p className="mt-3 text-sm leading-6 text-slate-300">Test mağaza adını gir; uygulama sadece read_products ve read_inventories izinleriyle OAuth başlatır.</p>
        <label className="mt-6 block text-sm font-medium text-slate-200" htmlFor="storeName">Store name</label>
        <input
          id="storeName"
          name="storeName"
          defaultValue={storeName}
          required
          autoFocus
          className="mt-2 w-full rounded-2xl border border-white/10 bg-slate-900 px-4 py-3 text-white outline-none ring-0 placeholder:text-slate-500 focus:border-emerald-300"
          placeholder="test-magaza"
        />
        {failed ? <p className="mt-3 text-sm text-red-300">OAuth başarısız oldu. Store name kontrol edip tekrar dene.</p> : null}
        <button className="mt-6 w-full rounded-full bg-emerald-400 px-5 py-3 text-sm font-bold text-slate-950 hover:bg-emerald-300" type="submit">
          Add to My Store
        </button>
      </form>
    </main>
  );
}
