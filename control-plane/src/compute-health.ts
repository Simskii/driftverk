export function parseComputeHealth(value: unknown) {
  const input = value as { checks?: unknown } | null;
  if (!input || !Array.isArray(input.checks) || !input.checks.length || input.checks.length > 16) return null;
  const checks: { service: string; status: string; message: string }[] = [];
  for (const check of input.checks) {
    if (!check || typeof check.service !== 'string' || !/^[a-z0-9-]{1,40}$/.test(check.service) || !['healthy', 'unhealthy', 'recovering'].includes(check.status)) return null;
    checks.push({ service: check.service, status: check.status, message: typeof check.message === 'string' ? check.message.slice(0, 300) : '' });
  }
  return { status: checks.every(check => check.status === 'healthy') ? 'healthy' : 'unhealthy', checks };
}

export function dockerIsHealthy(report: { checks: { service: string; status: string }[] }) {
  const checks = report.checks.filter(check => check.service === 'docker');
  return checks.length > 0 && checks.every(check => check.status === 'healthy');
}
