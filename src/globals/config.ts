export const config = {
  graphApiUrl: process.env.NEXT_PUBLIC_GRAPH_API_URL ?? "https://api.myikas.com/api/v2/admin/graphql",
  adminUrl: process.env.NEXT_PUBLIC_ADMIN_URL ?? "https://{storeName}.myikas.com/admin",
  deployUrl: process.env.NEXT_PUBLIC_DEPLOY_URL ?? "http://localhost:3000",
  cookiePassword: process.env.SECRET_COOKIE_PASSWORD,
  oauth: {
    // Partner-approved scopes for tenant-bound product and inventory operations.
    scope:
      "read_products,read_inventories,write_products,write_inventories",
    clientId: process.env.NEXT_PUBLIC_CLIENT_ID,
    clientSecret: process.env.CLIENT_SECRET,
  },
};
