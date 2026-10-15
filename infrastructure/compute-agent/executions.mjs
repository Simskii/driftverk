import { readFile } from "node:fs/promises";
import { runCommand } from "./docker-runtime.mjs";
const source = await readFile(new URL("./execution-worker.py", import.meta.url), "utf8");

export class ExecutionRuntime {
  constructor(runner = runCommand) { this.runner = runner; }
  async call(execution, action) {
    if (!/^exec_[a-f0-9-]{36}$/.test(execution.id)) throw new Error("Invalid execution ID");
    const { environment_variables, ...metadata } = execution;
    const result = await this.runner("docker", ["exec", "-i", "--user", "0", execution.runtime_id, "python3", "-c", source], {
      maxOutputBytes: 1000000,
      stdin: JSON.stringify({ ...metadata, action, ...(action === "start" ? { _source: source, environment_variables: environment_variables || {} } : {}) }),
    });
    return JSON.parse(result.stdout);
  }
  start(execution) { return this.call(execution, "start"); }
  status(execution) { return this.call(execution, "status"); }
  async unavailable(execution, error) {
    if (/exec: "python3": executable file not found/.test(error.message)) return true;
    // A failed transport is not evidence of a lost execution. Confirm the container state with Docker.
    try {
      const result = await this.runner("docker", ["ps", "--all", "--no-trunc", "--filter", `id=${execution.runtime_id}`, "--format", "{{.State}}"]);
      return result.stdout.trim() !== "running";
    } catch { return false; }
  }
}

export async function processExecutions(api, runtime = new ExecutionRuntime()) {
  const payload = await api("/api/compute/executions/poll", {});
  await Promise.all((payload?.executions || []).map(async execution => {
    if (execution.environment_state !== "running" || !execution.runtime_id) {
      await api(`/api/compute/executions/${execution.id}/report`, { status: "lost", exit_code: null, artifacts: [] });
      return;
    }
    // start is idempotent inside the container. An existing record is inspected, never rerun.
    let result;
    try {
      await runtime.start(execution);
      result = await runtime.status(execution);
    } catch (error) {
      if (!await runtime.unavailable(execution, error)) throw error;
      result = { status: "lost", exit_code: null, artifacts: [] };
    }
    await api(`/api/compute/executions/${execution.id}/report`, result);
  }));
}
