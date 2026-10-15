# Secure GitHub pull request environments

This guide describes an integration you build in GitHub Actions; automatic GitHub pull request orchestration is not built into Driftverk. In this workflow, Actions builds the OCI image and a trusted job asks Driftverk to run its immutable digest. Trusted project prebuilds are a separate workflow.

## Required trust boundary

Use two jobs or workflows with different permissions:

1. The untrusted build job checks out pull request code and builds the image without Driftverk credentials, production credentials, registry passwords or repository secrets. If publication requires credentials, use a separate trusted publication step that never executes the image or pull request code.
2. A trusted orchestration job does not check out or execute pull request code. It receives only the resulting image digest and commit SHA, then calls the Driftverk API with a repository-scoped API key.

Never combine `pull_request_target` secrets with checkout or execution of pull request code. Do not pass secrets through artifacts, image build arguments, cache keys, logs, environment names, labels, or OCI metadata.

## Driftverk API key

Create a dedicated key with `read`, `write`, and `delete` scopes and this automation restriction:

```text
github:<numeric-repository-id>:pr:
```

Store it as a GitHub Actions secret. Do not reuse an administrator key or a key shared by several repositories. Revoke and replace it if a workflow log or pull request could have exposed it.

## Create or update a preview

Resolve the pushed image to its registry digest and send the digest, not a tag:

```json
{
  "name": "pr-123",
  "source_type": "image",
  "image": "ghcr.io/example/app@sha256:0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
  "code_trust": "untrusted",
  "automation_id": "github:123456789:pr:123",
  "source_revision": "0123456789abcdef0123456789abcdef01234567",
  "auto_delete_minutes": 360
}
```

Driftverk rejects moving tags for machine-created environments. It also rejects environment variables for `untrusted` code and limits a repository-scoped key to matching automation IDs. The default automatic deletion for untrusted environments is six hours.

Treat the tuple `(automation_id, source_revision)` as idempotent. If GitHub retries a run, query the existing environment instead of starting an unrelated duplicate.

## Preview links and cleanup

Request a preview grant for the known application HTTP port after checking that the application is ready. The returned URL is a short-lived bearer credential. Do not print it to Actions logs or post it in a public pull request. Link to the authenticated Driftverk environment page from public pull requests; expose the private preview only to authorized reviewers.

On `pull_request` activity `closed`, use the same repository-scoped key to delete the matching environment. Automatic deletion is a backstop, not the primary cleanup path.

## Runtime prerequisite

Driftverk defaults `ALLOW_UNTRUSTED_CODE` to `false`. Do not turn it on for a host that only uses the standard `runc` runtime. First verify the intended Sysbox runtime, kernel, nested-Docker boundary, outbound-network policy, instance metadata protection, resource limits, and teardown on the actual compute host. Enable the flag only after that evidence exists.
