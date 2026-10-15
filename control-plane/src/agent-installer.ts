// Bind downloaded installers to the installation that served them. Keep the
// explicit environment override and saved host registration working as before.
export function renderAgentInstaller(script: string, publicUrl: string): string {
  const quoted = `'${publicUrl.replace(/\/$/, "").replaceAll("'", "'\\''")}'`;
  return script.replace(/^DEFAULT_CONTROL_PLANE_URL=.*$/m, () => `DEFAULT_CONTROL_PLANE_URL=${quoted}`);
}
