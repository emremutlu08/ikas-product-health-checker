const MYIKAS_SUFFIX = ".myikas.com";
const STORE_NAME_PATTERN = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;
const HOSTILE_URL_CHARACTER_PATTERN = /[%@\\\u0000-\u001f\u007f-\u009f]/;

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
  return !HOSTILE_URL_CHARACTER_PATTERN.test(value) && STORE_NAME_PATTERN.test(value);
}
