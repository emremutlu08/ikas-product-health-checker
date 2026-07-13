import { AuthorizeStoreForm } from "@/components/AuthorizeStoreForm";
import { IkasAppBridgeReady } from "@/components/IkasAppBridgeReady";
import { normalizeOAuthSupportId, parseOAuthFailureReason } from "@/lib/ikas/oauth-failure";
import { normalizeStoreNameInput } from "@/lib/ikas/store-name";

type AuthorizeStoreSearchParams = {
  status?: string;
  storeName?: string;
  reason?: string;
  errorId?: string;
};

export default function AuthorizeStorePage({ searchParams }: { searchParams?: Promise<AuthorizeStoreSearchParams> }) {
  return <AuthorizeStoreContent searchParams={searchParams} />;
}

async function AuthorizeStoreContent({ searchParams }: { searchParams?: Promise<AuthorizeStoreSearchParams> }) {
  const params = (await searchParams) ?? {};
  const failed = params.status === "fail";
  const storeName = normalizeStoreNameInput(params.storeName);
  const failureReason = failed ? parseOAuthFailureReason(params.reason) : undefined;
  const supportId = failed ? normalizeOAuthSupportId(params.errorId) : "";

  return (
    <main className="flex min-h-screen items-center justify-center bg-slate-950 px-6 text-white">
      <IkasAppBridgeReady />
      <AuthorizeStoreForm failureReason={failureReason} initialStoreName={storeName} supportId={supportId} />
    </main>
  );
}
