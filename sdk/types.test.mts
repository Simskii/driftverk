import { Driftverk, type ProjectSetup, type Prebuild, type Operation } from "@driftverk/sdk";

// Compile-only package consumer: verify declarations through the package exports.
async function workflow(client: Driftverk) {
  const setup: ProjectSetup = await client.createProjectSetup({
    name: "project",
    configuration: { image: "driftverk-dev:1", cpu: 1, memory_mb: 1024, auto_stop_minutes: null },
  });
  await client.updateProjectSetup(setup.id, { name: setup.name, configuration: setup.configuration });
  const build = await client.buildPrebuild({ template_id: setup.id });
  const ready: Prebuild = await client.waitForPrebuild(build.id);
  const created: Operation = await client.createEnvironment({ prebuild_id: ready.id, code_trust: "trusted", auto_delete_minutes: 60 });
  await client.waitForOperation(created.operation_id);
  const environment = await client.getEnvironment(created.environment_id);
  const sshUsername: string = environment.ssh_username;
  const preview: { url: string; expires_at: string } = await client.createPreview(environment.id, 3000);
  await client.stopEnvironment(environment.id);
  await client.startEnvironment(environment.id);
  await client.deleteEnvironment(environment.id);
  await client.deleteProjectSetup(setup.id);
  // @ts-expect-error unsupported template memory size
  await client.createProjectSetup({ name: "bad", configuration: { memory_mb: 3 } });
  return { sshUsername, preview };
}
void workflow;
