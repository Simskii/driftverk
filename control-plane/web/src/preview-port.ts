// Telemetry reports listeners, not HTTP detection. Use conventional web ports
// as a fallback and ask the user when there is no likely web service.
export function defaultPreviewPort(configured: number | null | undefined, ports: Array<{ port: number }>): number | null {
  if (configured) return configured;
  return [3000, 5173, 8080, 8000, 80, 4200, 5000, 8888, 9000].find(port => ports.some(entry => entry.port === port)) ?? null;
}
