// Version this tag when changing the toolchain. Each compute host caches its own build.
export const developmentDockerfile = `FROM node:22-bookworm
RUN apt-get update && apt-get install -y --no-install-recommends git ca-certificates curl openssh-client python3 build-essential procps sudo tmux docker.io docker-compose && rm -rf /var/lib/apt/lists/*
LABEL driftverk.dev-image-version="3"
RUN corepack enable && npm install -g @openai/codex@0.154.0 @anthropic-ai/claude-code@2.1.263
WORKDIR /workspace
CMD ["sleep", "infinity"]
`;

import { spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LocalSnapshotStorage, localSnapshotRef } from "./snapshot-storage.mjs";
import { VolumeStorage } from "./volume-storage.mjs";
import { probeRuntime } from './runtime-probe.mjs';

const inheritedCommandEnvironmentNames = [
  "PATH", "HOME", "LANG", "LC_ALL", "TMPDIR", "DOCKER_HOST", "DOCKER_TLS_VERIFY", "DOCKER_CERT_PATH",
];

export function commandEnvironment(extra = {}) {
  const environment = {};
  for (const name of inheritedCommandEnvironmentNames) {
    if (process.env[name] !== undefined) environment[name] = process.env[name];
  }
  return { ...environment, ...extra };
}

export function runCommand(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      env: options.env ?? commandEnvironment(),
      stdio: [options.stdin ? "pipe" : "ignore", "pipe", "pipe"],
    });
    const outputLimit = Math.min(1048576, Math.max(65536, Number(options.maxOutputBytes) || 65536));
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => (stdout = (stdout + String(chunk)).slice(-outputLimit)));
    child.stderr.on("data", (chunk) => (stderr = (stderr + String(chunk)).slice(-outputLimit)));
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) return resolve({ stdout: stdout.trim(), stderr: stderr.trim() });
      reject(
        new Error(
          `${command} ${args[0] ?? ""} failed with code ${code}: ${stderr.trim() || stdout.trim()}`,
        ),
      );
    });
    if (options.stdin) child.stdin.end(options.stdin);
  });
}

function containerName(serverId) {
  return `driftverk-${serverId.toLowerCase().replace(/[^a-z0-9_.-]/g, "-")}`.slice(
    0,
    120,
  );
}

function containerHostname(sandbox) {
  return String(sandbox.name || sandbox.id)
    .toLowerCase()
    .replace(/[^a-z0-9-]/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 63) || "environment";
}

const byteMultipliers = {
  b: 1,
  kb: 1_000,
  kib: 1_024,
  mb: 1_000 ** 2,
  mib: 1_024 ** 2,
  gb: 1_000 ** 3,
  gib: 1_024 ** 3,
  tb: 1_000 ** 4,
  tib: 1_024 ** 4,
};

export function parseStatsBytes(value) {
  const match = String(value ?? "").trim().match(/^([0-9]+(?:\.[0-9]+)?)\s*([kmgt]?i?b)$/i);
  if (!match) return 0;
  const amount = Number(match[1]);
  const multiplier = byteMultipliers[match[2].toLowerCase()];
  return Number.isFinite(amount) && multiplier ? amount * multiplier : 0;
}

export class DockerSandboxRuntime {
  constructor({ runner = runCommand, runtime = "", network = "bridge", snapshotStorage = new LocalSnapshotStorage(), volumeStorage } = {}) {
    this.runner = runner;
    this.runtime = runtime;
    this.network = network;
    this.snapshotStorage = snapshotStorage;
    this.volumeStorage = volumeStorage ?? new VolumeStorage(process.env, { runner });
  }

  async loginAndPull(image, registry) {
    if (image === "driftverk-dev:1" && !registry) {
      let current = false;
      try {
        const result = await this.runner("docker", ["image", "inspect", "--format", "{{index .Config.Labels \"driftverk.dev-image-version\"}}", image]);
        current = result.stdout.trim() === "3";
      } catch { /* Build the development image below. */ }
      if (!current) {
        await this.runner("docker", ["build", "--tag", image, "-"], { stdin: developmentDockerfile });
      }
      return;
    }
    if (!registry) {
      await this.runner("docker", ["pull", image]);
      return;
    }
    const configDirectory = await mkdtemp(join(tmpdir(), "driftverk-docker-"));
    try {
      const environment = commandEnvironment({ DOCKER_CONFIG: configDirectory });
      await this.runner(
        "docker",
        ["login", registry.url, "--username", registry.username, "--password-stdin"],
        { env: environment, stdin: registry.password },
      );
      await this.runner("docker", ["pull", image], { env: environment });
    } finally {
      await rm(configDirectory, { recursive: true, force: true });
    }
  }

  async inspect(runtimeId) {
    if (!runtimeId) return null;
    try {
      const result = await this.runner("docker", [
        "inspect",
        "--format",
        "{{.Id}}",
        runtimeId,
      ]);
      return result.stdout || null;
    } catch {
      return null;
    }
  }

  async imageExposesPorts(image) {
    try {
      const result = await this.runner("docker", [
        "image",
        "inspect",
        "--format",
        "{{json .Config.ExposedPorts}}",
        image,
      ]);
      const ports = JSON.parse(result.stdout || "null");
      return Boolean(ports && typeof ports === "object" && Object.keys(ports).length);
    } catch {
      return false;
    }
  }

  async create(sandbox, progress = async () => {}) {
    if (!sandbox.source.image)
      throw new Error("The source does not resolve to an OCI image");
    const volumes = await this.volumeStorage.prepare(sandbox.volumes ?? []);
    const existing = await this.inspect(
      sandbox.runtime_id ?? containerName(sandbox.id),
    );
    if (existing) {
      await this.updateResources(existing, sandbox.resources);
      await this.runner("docker", ["start", existing]);
      await progress("booting", existing);
      await this.prepareDevelopment(existing, sandbox, progress);
      await this.initializeProject(existing, sandbox, progress);
      await this.startProject(existing, sandbox, progress);
      return existing;
    }

    await progress("restoring");
    const sourceImage = sandbox.source.type === "snapshot"
      ? await this.snapshotStorage.restore({
        snapshotId: sandbox.source.snapshot_id,
        artifactRef: sandbox.source.image,
        runner: this.runner,
      })
      : sandbox.source.image;
    if (sandbox.source.type === "image") await this.loginAndPull(sourceImage, sandbox.source.registry);
    const useImageCommand = sandbox.purpose === "prebuild" || sandbox.development?.repository || sandbox.development?.setup_command || sandbox.development?.initialization_command || sandbox.development?.startup_command ? false : await this.imageExposesPorts(sourceImage);
    const environment = commandEnvironment(sandbox.environment);
    const args = [
      "create",
      "--name",
      containerName(sandbox.id),
      "--hostname",
      containerHostname(sandbox),
      "--label",
      `driftverk.server-id=${sandbox.id}`,
      "--label",
      "driftverk.managed=true",
      "--label",
      `driftverk.start-mode=${useImageCommand ? "image" : "idle"}`,
      "--cpus",
      String(sandbox.resources.cpu),
      "--memory",
      `${sandbox.resources.memory_mb}m`,
      "--network",
      this.network,
      "--restart",
      "unless-stopped",
      "--init",
    ];
    if (this.runtime) args.push("--runtime", this.runtime);
    for (const name of Object.keys(sandbox.environment)) args.push("--env", name);
    for (const volume of volumes) {
      const mount = `type=bind,source=${volume.source_path},target=${volume.mount_path},bind-propagation=rslave${volume.read_only ? ",readonly" : ""}`;
      args.push("--mount", mount);
    }
    if (!useImageCommand) args.push("--entrypoint", "/bin/sh");
    args.push(sourceImage);
    if (!useImageCommand) args.push("-lc", "exec sleep infinity");
    const created = await this.runner("docker", args, { env: environment });
    const runtimeId = created.stdout;
    if (!runtimeId) throw new Error("Docker did not return a container ID");
    await this.runner("docker", ["start", runtimeId]);
    await progress("booting", runtimeId);
    await this.prepareDevelopment(runtimeId, sandbox, progress);
    await this.initializeProject(runtimeId, sandbox, progress);
    await this.startProject(runtimeId, sandbox, progress);
    await progress("connecting");
    return runtimeId;
  }

  async prepareDevelopment(runtimeId, sandbox, progress) {
    const development = sandbox.development;
    if (development?.prebuilt || (!development?.repository && !development?.setup_command)) return;
    const { repository, branch, setup_command: setup, token, revision } = development;
    if (revision && !/^[a-f0-9]{40}$/.test(revision)) throw new Error("Invalid repository revision");
    if (repository && !/^[A-Za-z0-9][A-Za-z0-9-]*\/[A-Za-z0-9_.-]+$/.test(repository)) throw new Error("Invalid repository");
    const workspace = repository ? `/workspaces/${repository.split("/")[1]}` : "/workspace";
    // A marker belongs to this environment, so snapshots cannot skip a new environment's setup.
    const marker = `/var/lib/driftverk/setup-${sandbox.id.replace(/[^a-zA-Z0-9_-]/g, "")}`;
    const execute = (script, args = [], stdin = "") => this.runner("docker", ["exec", "-i", "--user", "0", runtimeId, "timeout", "-k", "5", "900", "sh", "-c", script, "driftverk-setup", ...args], { stdin });
    try {
      await execute('test -f "$1/ready"', [marker]);
      return;
    } catch { /* Setup is incomplete. */ }
    if (repository) {
      await progress("cloning", runtimeId);
      try {
        // Token arrives over stdin, never as an argument, URL, file, or container environment.
        await execute(`set -eu
IFS= read -r token
workspace="$1"; marker="$2"; repository="$3"; branch="$4"; revision="$5"
mkdir -p "$marker" /workspaces
if [ -f "$marker/cloned" ]; then exit 0; fi
if [ -e "$workspace" ]; then echo "Workspace already exists; choose a snapshot without repository setup to keep its checkout" >&2; exit 1; fi
command -v git >/dev/null || { echo "The selected image needs Git. Use the development image." >&2; exit 1; }
tmp=$(mktemp -d /workspaces/.driftverk-clone.XXXXXX)
trap 'rm -rf "$tmp"' EXIT HUP INT TERM
export GIT_TERMINAL_PROMPT=0 GIT_CONFIG_NOSYSTEM=1 GIT_CONFIG_GLOBAL=/dev/null
export GIT_CONFIG_COUNT=2 GIT_CONFIG_KEY_0=credential.helper GIT_CONFIG_VALUE_0=
export GIT_CONFIG_KEY_1=http.https://github.com/.extraheader GIT_CONFIG_VALUE_1=
if [ -n "$token" ]; then GIT_CONFIG_VALUE_1="Authorization: Basic $(printf 'x-access-token:%s' "$token" | base64 | tr -d '\n')"; export GIT_CONFIG_VALUE_1; fi
if [ -n "$revision" ]; then
  git init "$tmp/repository"
  git -C "$tmp/repository" remote add origin "https://github.com/$repository.git"
  git -C "$tmp/repository" fetch --depth=1 origin "$revision"
  git -C "$tmp/repository" checkout --detach FETCH_HEAD
elif [ -n "$branch" ]; then git clone --single-branch --branch "$branch" -- "https://github.com/$repository.git" "$tmp/repository"; else git clone -- "https://github.com/$repository.git" "$tmp/repository"; fi
unset token GIT_CONFIG_VALUE_1
mv "$tmp/repository" "$workspace"
touch "$marker/cloned"
`, [workspace, marker, repository, branch || "", revision || ""], `${token || ""}\n`);
      } catch {
        // Git or a custom image can echo credentials. Do not forward command output.
        throw new Error("Repository setup failed. Check GitHub access, branch, Git in the image, and that the workspace path is empty.");
      }
    }
    if (setup) {
      await progress("setting-up", runtimeId);
      try {
        await execute('set -eu; mkdir -p "$1" "$2"; cd "$1"; sh -c "$3" >"$2/setup.log" 2>&1', [workspace, marker, setup]);
      } catch {
        throw new Error(`Setup command failed or exceeded 15 minutes. Open Terminal and inspect ${marker}/setup.log, fix the checkout, then retry setup.`);
      }
    }
    await execute('mkdir -p "$1"; touch "$1/ready"', [marker]);
  }

  async initializeProject(runtimeId, sandbox, progress) {
    const command = sandbox.development?.initialization_command;
    if (!command) return;
    await progress("initializing", runtimeId);
    const workspace = sandbox.development.workspace_path || "/workspace";
    const marker = `/var/lib/driftverk/setup-${sandbox.id.replace(/[^a-zA-Z0-9_-]/g, "")}`;
    try {
      await this.runner("docker", ["exec", runtimeId, "timeout", "-k", "5", "900", "sh", "-c",
        'set -eu; mkdir -p "$1" "$2"; test ! -f "$2/initialized" || exit 0; cd "$1"; sh -c "$3" >"$2/initialize.log" 2>&1; touch "$2/initialized"',
        "driftverk-initialize", workspace, marker, command]);
    } catch { throw new Error(`Development data initialization failed. Inspect ${marker}/initialize.log, fix the project, and retry.`); }
  }

  async startProject(runtimeId, sandbox, progress) {
    // Resume only an explicitly configured node. Fresh images remain logged out.
    if (sandbox.tailscale_configured) await this.runner("docker", ["exec", "--user", "0", runtimeId, "sh", "-c", `
if [ -f /var/lib/driftverk/tailscale-enabled ] && command -v tailscaled >/dev/null 2>&1; then
  if ! tailscale status --json >/dev/null 2>&1; then
    mkdir -p /var/run/tailscale
    nohup tailscaled --tun=userspace-networking --state=/var/lib/tailscale/tailscaled.state </dev/null >/dev/null 2>&1 &
  fi
fi`]);
    let { startup_command: startup, readiness_command: readiness } = sandbox.development || {};
    let composeStartup = false;
    let detectedComposeFile = "";
    const workspace = sandbox.development?.workspace_path || (sandbox.development?.repository ? `/workspaces/${sandbox.development.repository.split("/")[1]}` : "/workspace");
    if (!startup && (sandbox.development?.repository || sandbox.development?.workspace_path)) {
      const detected = await this.runner("docker", ["exec", "--user", "0", runtimeId, "sh", "-c",
        'cd "$1"; for file in compose.yaml compose.yml docker-compose.yaml docker-compose.yml; do if [ -f "$file" ]; then printf "%s" "$file"; break; fi; done',
        "driftverk-detect-compose", workspace]);
      const composeFile = detected.stdout.trim();
      if (composeFile) {
        composeStartup = true;
        detectedComposeFile = composeFile;
        startup = `if ! docker info >/dev/null 2>&1; then
  dockerd > /var/log/driftverk-dockerd.log 2>&1 &
  attempts=0
  until docker info >/dev/null 2>&1; do
    attempts=$((attempts + 1))
    if [ "$attempts" -ge 30 ]; then echo "Docker did not start. Inspect /var/log/driftverk-dockerd.log" >&2; exit 1; fi
    sleep 1
  done
fi
if docker compose version >/dev/null 2>&1; then docker compose -f ${composeFile} up -d --build; else docker-compose -f ${composeFile} up -d --build; fi`;
        readiness ||= `test -f "$2/startup.exit" && test "$(cat "$2/startup.exit")" = 0 || exit 1
if docker compose version >/dev/null 2>&1; then ids=$(docker compose -f ${composeFile} ps -a -q); else ids=$(docker-compose -f ${composeFile} ps -a -q); fi
test -n "$ids" || exit 1
for id in $ids; do
  state=$(docker inspect --format '{{.State.Status}}' "$id")
  if [ "$state" = exited ]; then
    test "$(docker inspect --format '{{.State.ExitCode}}' "$id")" = 0 || exit 1
  elif [ "$state" = running ]; then
    health=$(docker inspect --format '{{if .State.Health}}{{.State.Health.Status}}{{else}}none{{end}}' "$id")
    [ "$health" = healthy ] || [ "$health" = none ] || exit 1
  else
    exit 1
  fi
done`;
      }
    }
    if (!startup && !readiness) return;
    const marker = `/var/lib/driftverk/setup-${sandbox.id.replace(/[^a-zA-Z0-9_-]/g, "")}`;
    const readinessSeconds = composeStartup ? 900 : 120;
    const execute = (script, args = []) => this.runner("docker", ["exec", "--user", "0", runtimeId, "timeout", "-k", "5", String(readinessSeconds + 10), "sh", "-c", script, "driftverk-project", ...args]);
    if (composeStartup) await execute('mkdir -p "$1"; printf "%s\\n" "$2" > "$1/compose.workspace"; printf "%s\\n" "$3" > "$1/compose.file"', [marker, workspace, detectedComposeFile]);
    if (startup) {
      await progress("starting-services", runtimeId);
      try {
        // A supervisor keeps foreground development servers alive. Its process start time
        // prevents a stale PID file from suppressing startup after a container restart.
        await execute(`set -eu
mkdir -p "$1" "$2"
rm -f "$2/startup.exit"
cat >"$2/start.sh.next" <<'DRIFTVERK_START'
#!/bin/sh
set -eu
marker="$1"; workspace="$2"; command="$3"
if [ -f "$marker/start.pid" ]; then
  read -r pid started <"$marker/start.pid" || true
  current=$(awk '{print $22}' "/proc/\${pid:-0}/stat" 2>/dev/null || true)
  if [ -n "$current" ] && [ "$current" = "\${started:-}" ]; then exit 0; fi
fi
printf '%s %s\\n' "$$" "$(awk '{print $22}' /proc/$$/stat)" >"$marker/start.pid"
trap 'code=$?; printf "%s\\n" "$code" >"$marker/startup.exit"; rm -f "$marker/start.pid"' EXIT
cd "$workspace"
sh -c "$command" >"$marker/startup.log" 2>&1
DRIFTVERK_START
mv "$2/start.sh.next" "$2/start.sh"
`, [workspace, marker]);
        await this.runner("docker", ["exec", "-d", "--user", "0", runtimeId, "sh", `${marker}/start.sh`, marker, workspace, startup]);
        await execute(`set -eu
sleep 1
if [ -f "$1/startup.exit" ]; then test "$(cat "$1/startup.exit")" = 0; else test -s "$1/start.pid"; fi
`, [marker]);
      } catch {
        throw new Error(`Could not start project services. Open Terminal and inspect ${marker}/startup.log, then retry setup.`);
      }
    }
    if (readiness) {
      await progress("checking-app", runtimeId);
      try {
        // The check runs inside the sandbox. Never fetch a customer-supplied URL on the host.
        await execute(`set -eu
mkdir -p "$1" "$2"
cd "$1"
timeout -k 5 ${readinessSeconds} sh -c '
while :; do
  if [ -f "$2/startup.exit" ] && [ "$(cat "$2/startup.exit")" != 0 ]; then exit 1; fi
  if timeout -k 2 10 sh -c "$1" driftverk-ready "$3" "$2" >"$2/readiness.log" 2>&1; then break; fi
  sleep 2
done' driftverk-check "$3" "$2" "$1"
`, [workspace, marker, readiness]);
      } catch {
        throw new Error(`Project readiness check failed or did not pass within ${readinessSeconds / 60} minutes. Open Terminal and inspect ${marker}/readiness.log and startup.log, fix the app, then retry setup.`);
      }
    }
  }

  async updateResources(runtimeId, resources) {
    await this.runner("docker", ["update", "--cpus", String(resources.cpu),
      "--memory", `${resources.memory_mb}m`, "--memory-swap", `${resources.memory_mb * 2}m`, runtimeId]);
  }

  async start(sandbox, progress = async () => {}) {
    if (!sandbox.runtime_id) throw new Error("Sandbox has no runtime ID");
    if (sandbox.runtime_recovery) {
      const status = await probeRuntime(this.runner, sandbox.runtime_id);
      // A retried job must not restart an already recovered environment.
      if (status === 'sysbox-failed') {
        if (sandbox.runtime_recovery_retry) throw new Error('Recovery was already attempted; refusing another automatic restart.');
        const configuration = await this.runner('docker', ['inspect', '--format', '{{.HostConfig.Runtime}}', sandbox.runtime_id]);
        if (configuration.stdout.trim() !== 'sysbox-runc') throw new Error('Automatic runtime recovery requires Sysbox.');
        await this.stop(sandbox);
      }
      else if (status !== 'healthy') {
        const inspected = await this.runner('docker', ['inspect', '--format', '{{.State.Status}}', sandbox.runtime_id]);
        if (inspected.stdout.trim() !== 'exited') throw new Error('Runtime probe failed without a confirmed Sysbox fault; recovery stopped.');
      }
    }
    await this.volumeStorage.prepare(sandbox.volumes ?? []);
    await this.updateResources(sandbox.runtime_id, sandbox.resources);
    await this.runner("docker", ["start", sandbox.runtime_id]);
    if (sandbox.runtime_recovery && await probeRuntime(this.runner, sandbox.runtime_id) !== 'healthy')
      throw new Error('Environment command execution is still unavailable after recovery. Administrator action required.');
    await progress("booting", sandbox.runtime_id);
    await this.startProject(sandbox.runtime_id, sandbox, progress);
    await progress("connecting");
    return sandbox.runtime_id;
  }

  async stop(sandbox) {
    if (!sandbox.runtime_id) throw new Error("Sandbox has no runtime ID");
    await this.runner("docker", ["stop", "--signal", "SIGTERM", "--time", "30", sandbox.runtime_id]);
    return sandbox.runtime_id;
  }

  async delete(sandbox) {
    if (sandbox.runtime_id && (await this.inspect(sandbox.runtime_id)))
      await this.runner("docker", ["rm", "--force", sandbox.runtime_id]);
    return sandbox.runtime_id;
  }

  async snapshot(sandbox, snapshot) {
    if (!sandbox.runtime_id) throw new Error("Environment has no runtime ID");
    if (this.runtime === "sysbox-runc") {
      const state = await this.runner("docker", ["inspect", "--format", "{{.State.Status}}", sandbox.runtime_id]);
      if (state.stdout.trim() === "running" && sandbox.purpose === "prebuild") {
        await this.stop(sandbox);
      } else if (state.stdout.trim() !== "exited") {
        throw new Error("Stop the environment before creating a snapshot so all filesystem changes are captured.");
      }
    }
    const imageRef = localSnapshotRef(snapshot.id);
    const snapshotLabel = String(snapshot.id).replace(/[^A-Za-z0-9_.-]/g, "-");
    const changes = [];
    if (sandbox.purpose === "prebuild") {
      // The builder suppresses image services. Restore the original image command in its reusable artifact.
      const original = await this.runner("docker", ["inspect", "--format", "{{.Image}}", sandbox.runtime_id]);
      const metadata = JSON.parse((await this.runner("docker", ["image", "inspect", "--format", "{{json .Config}}", original.stdout])).stdout);
      changes.push("--change", `ENTRYPOINT ${JSON.stringify(metadata.Entrypoint || [])}`, "--change", `CMD ${JSON.stringify(metadata.Cmd || [])}`);
    }
    await this.runner("docker", [
      "commit",
      "--pause=true",
      "--change",
      "LABEL driftverk.managed=true",
      "--change",
      "LABEL driftverk.resource=snapshot",
      "--change",
      `LABEL driftverk.snapshot-id=${snapshotLabel}`,
      ...changes,
      sandbox.runtime_id,
      imageRef,
    ]);
    const inspected = await this.runner("docker", ["image", "inspect", "--format", "{{.Size}}", imageRef]);
    const sizeBytes = Number(inspected.stdout || 0);
    const stored = await this.snapshotStorage.publish({
      snapshotId: snapshot.id,
      imageRef,
      sizeBytes,
      runner: this.runner,
    });
    return { artifactRef: stored.artifactRef, snapshotSizeGb: stored.sizeBytes / 1_000_000_000 };
  }

  async telemetry() {
    const listed = await this.runner("docker", ["ps", "--filter", "label=driftverk.managed=true", "--format", "{{.ID}} {{.Label \"driftverk.server-id\"}}"]).catch(() => ({ stdout: "" }));
    const samples = [];
    for (const row of listed.stdout.split("\n").filter(Boolean)) {
      const [runtimeId, sandboxId] = row.trim().split(/\s+/, 2);
      if (!runtimeId || !sandboxId) continue;
      const runtimeProbe = await probeRuntime(this.runner, runtimeId);
      if (runtimeProbe !== 'healthy') {
        samples.push({ sandbox_id: sandboxId, runtime_id: runtimeId, runtime_probe: runtimeProbe,
          logs: ['Environment command execution health check failed.'] });
        continue;
      }
      const [stats, disk, logs, inspected, projectLogs, applicationSample] = await Promise.all([
        this.runner("docker", ["stats", "--no-stream", "--format", "{{json .}}", runtimeId]).catch(() => ({ stdout: "{}" })),
        this.runner("docker", ["exec", runtimeId, "df", "-Pk", "/"]).catch(() => ({ stdout: "" })),
        this.runner("docker", ["logs", "--timestamps", "--tail", "100", runtimeId]).catch(() => ({ stdout: "" })),
        this.runner("docker", ["inspect", "--format", "{{.State.Pid}}", runtimeId]).catch(() => ({ stdout: "" })),
        this.runner("docker", ["exec", runtimeId, "timeout", "15", "sh", "-c", `
marker="$1"
for name in setup initialize startup readiness; do
  if [ -f "$marker/$name.log" ]; then
    tail -n 8 "$marker/$name.log" | while IFS= read -r line; do printf '[%s] %s\\n' "$name" "$line"; done
  fi
done
if command -v docker >/dev/null 2>&1; then
  docker ps -a --filter label=com.docker.compose.service --format '{{.ID}} {{.Label "com.docker.compose.service"}}' 2>/dev/null | head -n 8 |
  while read -r id service; do
    docker logs --timestamps --tail 8 "$id" 2>&1 | while IFS= read -r line; do printf '[compose:%s] %s\\n' "$service" "$line"; done
  done
fi
`, "driftverk-project-logs", `/var/lib/driftverk/setup-${sandboxId.replace(/[^a-zA-Z0-9_-]/g, "")}`]).catch(() => ({ stdout: "" })),
        this.runner("docker", ["exec", runtimeId, "timeout", "15", "sh", "-c", `
marker="$1"
if [ -f "$marker/compose.file" ]; then
  printf 'configured\\n'
  if [ -f "$marker/startup.exit" ]; then printf 'startup:%s\\n' "$(cat "$marker/startup.exit")"; else printf 'startup:pending\\n'; fi
  cd "$(cat "$marker/compose.workspace")" || exit 1
  file=$(cat "$marker/compose.file")
  if docker compose version >/dev/null 2>&1; then
    expected=$(docker compose -f "$file" config --services) || exit 1
    printf '%s\\n' "$expected" | sed 's/^/expected:/'
    ids=$(docker compose -f "$file" ps -a -q) || exit 1
  else
    expected=$(docker-compose -f "$file" config --services) || exit 1
    printf '%s\\n' "$expected" | sed 's/^/expected:/'
    ids=$(docker-compose -f "$file" ps -a -q) || exit 1
  fi
else
  ids=$(docker ps -a --filter label=com.docker.compose.service -q 2>/dev/null) || exit 1
fi
for id in $ids; do
  docker inspect --format '{{json (index .Config.Labels "com.docker.compose.service")}} {{json .State.Status}} {{if .State.Health}}{{json .State.Health.Status}}{{else}}"none"{{end}} {{.State.ExitCode}}' "$id" || exit 1
done
`, "driftverk-app-status", `/var/lib/driftverk/setup-${sandboxId.replace(/[^a-zA-Z0-9_-]/g, "")}`]).catch(() => null),
      ]);
      let parsed = {};
      try { parsed = JSON.parse(stats.stdout); } catch { parsed = {}; }
      const memoryUsage = String(parsed.MemUsage ?? "0").split("/")[0].trim();
      const memoryUsageMb = parseMemoryMb(memoryUsage);
      const diskRow = disk.stdout.split("\n").filter(Boolean).at(-1) ?? "";
      const filesystemPercent = Number((diskRow.match(/(\d+)%/)?.[1]) ?? 0);
      const logOutput = [logs.stdout, logs.stderr, projectLogs.stdout].filter(Boolean).join("\n");
      const pid = Number(inspected.stdout);
      let ports = [];
      if (Number.isInteger(pid) && pid > 1) {
        const listening = await this.runner("nsenter", ["--target", String(pid), "--net", "ss", "-lntH"]).catch(() => ({ stdout: "" }));
        ports = parseListeningPorts(listening.stdout);
      }
      samples.push({ sandbox_id: sandboxId, runtime_id: runtimeId, runtime_probe: runtimeProbe, metric: {
        cpu_percent: parsePercent(parsed.CPUPerc),
        memory_usage_mb: memoryUsageMb,
        memory_percent: parsePercent(parsed.MemPerc),
        filesystem_percent: filesystemPercent,
      }, ...(applicationSample ? { application: parseApplicationStatus(applicationSample.stdout) } : {}), ports, logs: ["Runtime telemetry connected.", ...(logOutput ? logOutput.split("\n") : [])] });
    }
    return samples;
  }
}

function parsePercent(value) { return Number(String(value ?? "0").replace("%", "")) || 0; }
export function parseListeningPorts(output) {
  return [...new Set(String(output).split("\n").flatMap((line) => {
    const address = line.trim().split(/\s+/)[3] ?? "";
    const match = address.match(/^(.+):(\d+)$/);
    if (!match) return [];
    const host = match[1].replace(/^\[|\]$/g, "");
    const port = Number(match[2]);
    if (host === "::1" || host.startsWith("127.") || !Number.isInteger(port) || port < 1 || port > 65535) return [];
    return [port];
  }))];
}
function parseMemoryMb(value) {
  const match = String(value).match(/^([0-9.]+)\s*([KMG]i?B)$/i);
  if (!match) return 0;
  const amount = Number(match[1]);
  const unit = match[2].toUpperCase();
  if (unit.startsWith("G")) return amount * 1024;
  if (unit.startsWith("K")) return amount / 1024;
  return amount;
}

// Only inspect service names and state; never transmit container configuration or secrets.
export function parseApplicationStatus(output) {
  const lines = output.trim().split("\n");
  const expected = lines.filter(line => line.startsWith("expected:")).map(line => line.slice(9));
  const services = lines.filter(line => line.startsWith('"')).flatMap(line => {
    try {
      const [name, state, health, exit_code] = JSON.parse(`[${line.replace(/" /g, '",')}]`);
      return [{ name, state, health, exit_code }];
    } catch { return []; }
  }).slice(0, 100);
  if (!services.length && !lines.includes("configured")) return null;
  let status = "ready", message = "All Compose services are ready.";
  const failed = services.find(service => service.health === "unhealthy" || ["dead", "restarting"].includes(service.state) || (service.state === "exited" && service.exit_code !== 0));
  const allReady = services.length > 0 && expected.every(name => services.some(service => service.name === name)) && services.every(service => (service.state === "exited" && service.exit_code === 0) || (service.state === "running" && ["healthy", "none"].includes(service.health)));
  const missing = expected.find(name => !services.some(service => service.name === name));
  if (missing && lines.includes("startup:0")) {
    status = "failed"; message = `${missing} is missing. Open logs for details.`;
  } else if (failed || (!allReady && lines.some(line => /^startup:(?!0$|pending$)/.test(line)))) {
    status = "failed"; message = failed ? `${failed.name} failed. Open logs for details.` : "Compose startup failed. Open logs for details.";
  } else if (lines.includes("startup:pending") || !services.length || expected.some(name => !services.some(service => service.name === name)) || services.some(service => !(service.state === "exited" && service.exit_code === 0) && !(service.state === "running" && ["healthy", "none"].includes(service.health)))) {
    status = "starting"; message = "Waiting for Compose services to become ready.";
  }
  return { status, message, services };
}
