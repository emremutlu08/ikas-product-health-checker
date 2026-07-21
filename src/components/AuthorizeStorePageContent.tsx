import { AuthorizeStoreForm } from "@/components/AuthorizeStoreForm";
import { IkasAppBridgeReady } from "@/components/IkasAppBridgeReady";
import { normalizeOAuthSupportId, parseOAuthFailureReason } from "@/lib/ikas/oauth-failure";
import { normalizeStoreNameInput } from "@/lib/ikas/store-name";

export type AuthorizeStoreSearchParams = {
  status?: string;
  storeName?: string;
  reason?: string;
  errorId?: string;
};

export async function AuthorizeStorePageContent({
  searchParams,
}: {
  searchParams?: Promise<AuthorizeStoreSearchParams>;
}) {
  const params = (await searchParams) ?? {};
  const failed = params.status === "fail";
  const storeName = normalizeStoreNameInput(params.storeName);
  const failureReason = failed ? parseOAuthFailureReason(params.reason) : undefined;
  const supportId = failed ? normalizeOAuthSupportId(params.errorId) : "";

  return (
    <main className="flex min-h-screen items-center justify-center bg-slate-50 px-4 py-10 text-slate-950 sm:px-6">
      <IkasAppBridgeReady />
      <AuthorizeStoreForm failureReason={failureReason} initialStoreName={storeName} supportId={supportId} />
    </main>
  );
}
