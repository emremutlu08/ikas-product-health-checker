import {
  AuthorizeStorePageContent,
  type AuthorizeStoreSearchParams,
} from "@/components/AuthorizeStorePageContent";

export default async function AuthorizeStorePage({
  searchParams,
}: {
  searchParams?: Promise<AuthorizeStoreSearchParams>;
}) {
  return <AuthorizeStorePageContent searchParams={searchParams} />;
}
