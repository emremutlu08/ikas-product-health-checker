/**
 * ikas returns `updatedAt` as a `Timestamp` scalar — epoch milliseconds — while the stored health
 * report carries an ISO string. A stale-write guard that compares the two raw forms can never
 * match, so every comparison goes through this one canonical rendering instead.
 */
export function canonicalIkasTimestamp(value: string | number | null | undefined): string | undefined {
  if (value === null || value === undefined || value === "") return undefined;
  const date = typeof value === "number" ? new Date(value) : new Date(value);
  const time = date.getTime();
  if (!Number.isFinite(time)) return undefined;
  return date.toISOString();
}
