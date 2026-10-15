import { Driftverk } from "../index.mjs";

const client = new Driftverk({ baseUrl: process.env.DRIFTVERK_URL, apiKey: process.env.DRIFTVERK_API_KEY });
const repository = process.env.DRIFTVERK_REPOSITORY;
const runId = process.env.DRIFTVERK_RUN_ID;
if (!repository || !runId) throw new Error("Set DRIFTVERK_REPOSITORY (owner/repository) and a stable DRIFTVERK_RUN_ID for retries");

const setup = await client.createProjectSetup({
  name: process.env.DRIFTVERK_SETUP_NAME || repository,
  configuration: {
    image: "driftverk-dev:1",
    repository,
    repository_branch: process.env.DRIFTVERK_BRANCH || "main",
    setup_command: "npm ci",
    cpu: 2,
    memory_mb: 4096,
  },
}, { idempotencyKey: `${runId}:setup` });
const build = await client.buildPrebuild({ template_id: setup.id }, { idempotencyKey: `${runId}:build` });
console.log("Project setup:", setup.id, "Prebuild:", build.id);
const ready = await client.waitForPrebuild(build.id);
console.log("Ready. Use DRIFTVERK_PREBUILD_ID=" + ready.id + " with examples/project-agent.mjs");
