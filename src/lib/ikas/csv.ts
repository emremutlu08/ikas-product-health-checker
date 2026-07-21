import type { HealthIssue } from "./types";

function escapeCsv(value: unknown) {
  const raw = String(value ?? "");
  // Spreadsheet apps may execute cells beginning with formula sigils. Prefix every
  // upstream-controlled formula-like value with an apostrophe so exports remain text.
  // Leading spaces and control whitespace are included because spreadsheet parsers may trim
  // them before deciding whether a cell is a formula.
  const text = /^(?:[\t\r\n ]*[=+\-@]|[\t\r\n])/.test(raw) ? `'${raw}` : raw;
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
