import type { HealthIssue } from "./types";

function escapeCsv(value: unknown) {
  const text = String(value ?? "");
  if (/[",\n\r]/.test(text)) return `"${text.replaceAll('"', '""')}"`;
  return text;
}

export function issuesToCsv(issues: HealthIssue[]) {
  const header = ["severity", "code", "productName", "productId", "variantLabel", "variantId", "value", "message"];
  const rows = issues.map((issue) => [
    issue.severity,
    issue.code,
    issue.productName,
    issue.productId,
    issue.variantLabel ?? "",
    issue.variantId ?? "",
    issue.value ?? "",
    issue.message,
  ]);

  return [header, ...rows].map((row) => row.map(escapeCsv).join(",")).join("\n");
}
