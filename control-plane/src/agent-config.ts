export const agentDefinitions = {
  codex: { name: "Codex", secretName: "OPENAI_API_KEY" },
  claude: { name: "Claude Code", secretName: "ANTHROPIC_API_KEY" },
} as const;
export type AgentId = keyof typeof agentDefinitions;
export type AgentConfiguration = { id: AgentId; model: string | null; connection_id?: string; auth_method?: "api_key" | "subscription" };

export function parseAgentAuthMethod(value: unknown): "api_key" | "subscription" {
  if (value === undefined || value === null || value === "api_key") return "api_key";
  if (value === "subscription") return value;
  throw new Error("Choose subscription or API key authentication");
}

export function parseAgentId(value: unknown): AgentId | null {
  if (value === undefined || value === null || value === "") return null;
  if (value !== "codex" && value !== "claude") throw new Error("Choose Codex, Claude Code, or no agent");
  return value;
}

export function parseAgentModel(value: unknown): string | null {
  if (value === undefined || value === null || value === "") return null;
  if (typeof value !== "string" || !/^[a-zA-Z0-9][a-zA-Z0-9._:/-]{0,127}$/.test(value))
    throw new Error("Use a model ID of at most 128 characters without spaces");
  return value;
}
