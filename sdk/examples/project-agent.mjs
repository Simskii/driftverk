import { Driftverk } from "../index.mjs";
import { writeFile } from "node:fs/promises";

const client = new Driftverk({ baseUrl: process.env.DRIFTVERK_URL, apiKey: process.env.DRIFTVERK_API_KEY });
// Run define-project.mjs or build a setup in the panel, then reuse its ready prebuild ID.
const prebuildId = process.env.DRIFTVERK_PREBUILD_ID;
if (!prebuildId) throw new Error("Set DRIFTVERK_PREBUILD_ID to a ready project prebuild");
let environmentId, executionId;
try {
  const created = await client.createEnvironment({ prebuild_id: prebuildId, code_trust: "trusted", auto_delete_minutes: 60 });
  environmentId = created.environment_id;
  await client.waitForOperation(created.operation_id);
  const execution = await client.execute(environmentId, {
    command: "npm test > test-report.txt 2>&1; result=$?; cat test-report.txt; exit $result",
    artifacts: ["test-report.txt"], timeout_seconds: 900,
  });
  executionId = execution.id;
  for await (const event of client.events(execution.id)) {
    if (event.type === "output") (event.stream === "stdout" ? process.stdout : process.stderr).write(event.bytes);
    else process.exitCode = event.execution.status === "succeeded" ? 0 : 1;
  }
  await writeFile("test-report.txt", await client.artifact(execution.id, "test-report.txt"));
} finally {
  try {
  if (executionId) {
    await client.cancelExecution(executionId);
    await client.waitForExecution(executionId, { timeoutMs: 30000 });
  }
  } finally {
  if (environmentId) {
    const deleted = await client.deleteEnvironment(environmentId);
    await client.waitForOperation(deleted.operation_id);
  }
  }
}
