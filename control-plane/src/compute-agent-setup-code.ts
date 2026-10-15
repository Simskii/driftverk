export function normalizeUserCode(value: unknown): string {
  const compact = typeof value === "string" ? value.toUpperCase().replace(/[^A-Z0-9]/g, "") : "";
  return compact.length === 8 ? `${compact.slice(0, 4)}-${compact.slice(4)}` : "";
}
