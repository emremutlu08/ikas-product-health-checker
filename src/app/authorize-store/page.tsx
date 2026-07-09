import { AuthorizeStoreForm } from "@/components/AuthorizeStoreForm";
import { IkasAppBridgeReady } from "@/components/IkasAppBridgeReady";
import { normalizeStoreNameInput } from "@/lib/ikas/store-name";

export default function AuthorizeStorePage({ searchParams }: { searchParams?: Promise<{ status?: string; storeName?: string }> }) {
  return <AuthorizeStoreContent searchParams={searchParams} />;
}

async function AuthorizeStoreContent({ searchParams }: { searchParams?: Promise<{ status?: string; storeName?: string }> }) {
  const params = (await searchParams) ?? {};
  const failed = params.status === "fail";
  const storeName = normalizeStoreNameInput(params.storeName);

  return (
    <main className="flex min-h-screen items-center justify-center bg-slate-950 px-6 text-white">
      <IkasAppBridgeReady />
      <AuthorizeStoreForm failed={failed} initialStoreName={storeName} />
    </main>
  );
}
