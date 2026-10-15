import assert from "node:assert/strict";
import test from "node:test";

process.env.DATABASE_URL ??= "postgres://test:test@localhost:5432/test";
process.env.BETTER_AUTH_URL ??= "http://localhost:3000";
process.env.BETTER_AUTH_SECRET ??= "test-better-auth-secret-000000000";
process.env.SECRET_ENCRYPTION_KEYS ??= "test=AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=";
process.env.PREVIEW_TOKEN_SECRET ??= "test-preview-secret-0000000000000";
process.env.TERMINAL_TOKEN_SECRET ??= "test-terminal-secret-000000000000";
process.env.SSH_TOKEN_SECRET ??= "test-ssh-secret-000000000000000000";
process.env.COMPUTE_AGENT_TOKEN ??= "test-compute-secret-0000000000000";

const { createEnvironmentForActor, EnvironmentServiceError } = await import("./environment-service.js");

const actor = {
  organizationId: "org_test",
  organizationName: "Test",
  organizationSlug: "test",
  actorUserId: "user_test",
  automationIdPrefix: null,
};

const digest = `ghcr.io/example/app@sha256:${"a".repeat(64)}`;

test("fails closed for untrusted code until the operator enables it", async () => {
  await assert.rejects(
    createEnvironmentForActor(actor, { image: digest, code_trust: "untrusted" }),
    (error: unknown) => error instanceof EnvironmentServiceError && error.status === 503,
  );
});

test("repository-scoped keys cannot elevate an automation environment to trusted", async () => {
  await assert.rejects(
    createEnvironmentForActor({ ...actor, automationIdPrefix: "github:123:pr:" }, {
      image: digest,
      code_trust: "trusted",
      automation_id: "github:123:pr:7",
      source_revision: "b".repeat(40),
    }),
    (error: unknown) => error instanceof EnvironmentServiceError && error.status === 403,
  );
});
