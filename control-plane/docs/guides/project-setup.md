# Project setup

A repository supplies your project files. An OCI image supplies its operating system and tools. A saved project setup combines those choices with commands and resource defaults.

## Choose a source

Use a repository for normal development. Choose an image for a blank environment or custom toolchain. Choose a ready snapshot to restore a captured filesystem into a new environment.

Private repositories require a GitHub connection with access to the repository. Private images require organization registry credentials. Repository authentication and registry authentication are separate.

## Command order

| Command | When it runs | Typical use |
| --- | --- | --- |
| Setup | While preparing the checkout | Install dependencies with `npm ci` |
| Initialization | Once in each new environment, before startup | Seed that environment's database |
| Startup | On creation and resume | Start application services |
| Readiness | After startup | Exit with code 0 when the app is ready |

Initialization must tolerate retry if interrupted before its completion marker is written. It does not isolate an external shared database: provision a separate database or namespace for each environment when needed.

A readiness command is retried for up to two minutes. Without one, application readiness is unverified. It is a startup check, not continuous monitoring or proof that the external preview works.

## Root Compose files

Driftverk checks the repository root in this order:

1. `compose.yaml`
2. `compose.yml`
3. `docker-compose.yaml`
4. `docker-compose.yml`

The first matching project builds and starts automatically when no explicit startup command is configured. An explicit startup command overrides this behavior.

Compose uses Docker inside the environment. Use the Driftverk development image or a compatible image containing Docker and Compose, on a supported Sysbox host. Customer containers do not receive the host Docker socket.

For a repository with a Dockerfile that serves HTTP on port 3000:

```yaml
services:
  app:
    build: .
    ports:
      - "3000:3000"
```

Configure the app to bind to `0.0.0.0`. Add service health checks for applications and databases that need warm-up time. Automatic Compose readiness accepts running services without health checks, so a running service alone does not prove application readiness.

## Saved setups and prebuilds

Save repository, image, commands and resource defaults with **Save as project setup**. In Project setups, choose **Build prebuild**, wait for it to become ready, then choose **Start from prebuild**.

A clean prebuild resolves the repository to a commit, installs dependencies and captures the filesystem. It excludes runtime variables, volume mounts, initialization commands and startup services. Clone and registry authentication still apply; never embed credentials in images or commands.

Each new environment receives a separate writable filesystem. Add runtime variables and volumes when creating it. Prebuilds run on demand and do not rebuild automatically on push.

Updating a saved setup replaces its definition; existing prebuilds and environments keep their captured configuration. Deleting the definition also leaves those resources intact. Local prebuild storage constrains placement to its original host; S3 restores require compatible storage configuration.

## Organization secrets

An organization admin can add or replace encrypted secrets in **Settings → Organization secrets**. Only names are displayed after saving. In **Blueprints → Configure secrets**, select the names that each new environment should receive. You can also select secrets in the create-environment form.

Blueprints store references, never values. Creation copies the current values into the environment's encrypted variables. Missing references or a name shared with a direct variable reject creation. Updating a secret affects future environments; existing environments keep their copy. Existing prebuilds retain the secret references captured when built, which you can change in the create form. Secrets are not supplied to clean prebuild builds or untrusted environments.

For Example project previews, add `FONTAWESOME_AUTH_TOKEN` once and select it on the Example project blueprint. Use a credential intended to be shared with the organization.

## Application status

A Compose environment shows application status alongside its runtime status. **App starting** means services are still starting or the Compose build is incomplete. **App ready** means required services are running with passing health checks, or have completed successfully as one-shot jobs. **App failed** means startup failed, a service failed, or an expected service disappeared after startup. Services without health checks are assessed by process state; add health checks to verify the actual application.

The compute host continues checking after startup, so the status can recover or fail later. A report older than 90 seconds is shown as unavailable. Click the application status to open logs, which include startup output and named Compose container logs.

## Inspect a failure

Open Terminal, connect and choose **Show project output**. Fix the failed command and use **Retry setup**. If the image lacks required tools, choose a compatible image instead of extending automatic language detection.

See the [API guide](/docs/api#reuse-a-clean-project-setup) for defining and building setups programmatically.

## Automatic Compose startup

For a detected root Compose project, leave startup and readiness commands empty to use the compute host's automatic Compose workflow. It waits for startup completion, includes exited initialization services, and accepts only successful one-off jobs or running services with passing health checks when configured. A running service without a health check does not prove the HTTP application is ready.

Existing saved commands are preserved. If a project setup contains previously generated `docker-compose` commands, rerun **Detect project setup**, review the changes, and save to use automatic startup for new environments. Explicit custom commands still override automatic startup.

The environment shows the latest reported Compose application state and provides project logs, including initialization output. A standalone readiness command runs during startup; it is not continuous application monitoring.
