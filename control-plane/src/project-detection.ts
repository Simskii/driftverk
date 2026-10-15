// Suggestions only. Repository code is never executed by the control plane.
export function suggestProjectSetup(files: string[], manifest: unknown) {
  const composeFile = ["compose.yaml", "compose.yml", "docker-compose.yaml", "docker-compose.yml"].find(name => files.includes(name));
  if (composeFile) return {
    compose_file: composeFile,
    setup_command: "",
    // Let the compute runtime own Compose startup and readiness, including one-off jobs.
    startup_command: "",
    readiness_command: "",
    notes: [
      `Detected ${composeFile} at the repository root. Driftverk will start the complete Compose project.`,
      "Published HTTP ports are detected automatically. Add Compose health checks when the application needs time to become ready.",
    ],
  };
  const pkg = manifest && typeof manifest === "object" && !Array.isArray(manifest) ? manifest as Record<string, unknown> : {};
  const scripts = pkg.scripts && typeof pkg.scripts === "object" ? pkg.scripts as Record<string, unknown> : {};
  const manager = files.includes("pnpm-lock.yaml") ? "pnpm" : files.includes("yarn.lock") ? "yarn" : "npm";
  const setup_command = files.includes("package.json") ? manager === "npm" ? files.includes("package-lock.json") ? "npm ci" : "npm install" : `corepack ${manager} install` : "";
  const script = typeof scripts.dev === "string" ? "dev" : typeof scripts.start === "string" ? "start" : null;
  return {
    setup_command,
    startup_command: script ? `${manager === "npm" ? "npm" : `corepack ${manager}`} run ${script}` : "",
    readiness_command: "",
    notes: [
      files.includes("package.json") ? `Detected a ${manager} project at the repository root. Review commands before creating.` : "No supported root package.json found. Enter the commands your project needs.",
      "Set services to listen on 0.0.0.0 for previews. Add a readiness check for your app's actual port.",
    ],
  };
}
