export type EnvironmentVariableInput = { name: string; value: string };

export function parseEnvironmentVariable(input: unknown): EnvironmentVariableInput | null {
  if (!input || typeof input !== "object") return null;
  const candidate = input as Record<string, unknown>;
  const name = String(candidate.name ?? "").trim();
  const value = String(candidate.value ?? "");
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name) || value.length > 32768) return null;
  return { name, value };
}
