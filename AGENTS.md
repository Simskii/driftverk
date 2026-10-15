# Driftverk repository guidance

## Scope and terminology

- This repository contains the Driftverk control plane, web application, Compute agent, gateways, installer, and infrastructure Compose files.
- Use **environment** in product copy. Internal code and database tables may still use **sandbox**.
- Repository checkout is project configuration layered on an OCI image. It is not another container runtime or snapshot format.

## Environment creation

- Keep creation repository-first and compact. The user-facing sources are Repository, Snapshot, and Image.
- Recognize standard root Compose files in this order: `compose.yaml`, `compose.yml`, `docker-compose.yaml`, `docker-compose.yml`.
- Do not require a Driftverk-specific Compose file or add Compose as another environment source.
- Start the root Compose project automatically only when no explicit startup command is configured. An explicit command is the override.
- Keep language detection small. Use explicit commands, compatible OCI images, and reusable project setups for project-specific requirements.
- Compose runs through nested Docker inside the environment. Never mount the compute host Docker socket into customer environments.

## Architecture and compatibility

- Production customer environments require a supported Sysbox host. Local `runc` tests verify orchestration but do not prove the production isolation boundary.
- The host Compose project and a repository's nested Compose project are separate layers. State which layer a command or compatibility claim applies to.
- Preserve forward migrations and compatibility with existing environments, snapshots, agents, and saved project setups.

## Verification

- Run `npm run check` from `control-plane` for TypeScript changes.
- Run `npm run build` from `control-plane` for web or server build changes.
- Run `npm test` from `control-plane` for control-plane behavior and `node --test infrastructure/compute-agent/*.test.mjs` for Compute agent behavior when relevant.
- Run `git diff --check` before handing work over.
- Report local checks, Docker runtime checks, deployment, and authenticated browser verification as separate proof levels.

## Deployment

- Do not treat a healthy control-plane endpoint as proof that a Hybrid environment, preview, terminal, SSH, or nested Compose project works end to end.
- Do not commit, push, or deploy unless the user requests it. Preserve unrelated worktree changes and stage requested files explicitly.
