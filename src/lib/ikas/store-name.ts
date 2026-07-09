const MYIKAS_SUFFIX = ".myikas.com";
const STORE_NAME_PATTERN = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;

export function normalizeStoreNameInput(value?: string | null) {
  const trimmed = value?.trim() ?? "";
  if (!trimmed) return "";

  const withoutProtocol = trimmed.replace(/^https?:\/\//i, "").replace(/^\/\//, "");
  const hostLikeValue = withoutProtocol.split(/[/?#]/)[0]?.trim().toLowerCase() ?? "";
  if (!hostLikeValue) return "";

  if (hostLikeValue.endsWith(MYIKAS_SUFFIX)) {
    return hostLikeValue.slice(0, -MYIKAS_SUFFIX.length);
  }

  return hostLikeValue;
}

export function isValidStoreName(value: string) {
  return STORE_NAME_PATTERN.test(value);
}
