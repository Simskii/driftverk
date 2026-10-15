import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { promisify } from "node:util";
import test from "node:test";
import { ExecutionRuntime } from "./executions.mjs";

const exec = promisify(execFile);
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));

// Opt in against a local Docker engine with driftverk-dev:1 already present.
test("durable executions in a real isolated container", { skip: process.env.DRIFTVERK_RUNTIME_QA !== "1", timeout: 90000 }, async t => {
  const name = `driftverk-executions-qa-${process.pid}-${randomUUID().slice(0, 8)}`;
  let created = false;
  try {
    const { stdout } = await exec("docker", ["run", "-d", "--name", name, "--label", "driftverk.qa=executions", "--network", "none", "--env", "PREVIEW_GITHUB_TOKEN=fixture-old-token", "--init", "--entrypoint", "sh", "driftverk-dev:1", "-c", "exec sleep infinity"]);
    created = true;
    const runtimeId = stdout.trim();
    const runtime = new ExecutionRuntime();
    await exec("docker", ["exec", runtimeId, "mkdir", "-p", "/workspace"]);
    const execution = (command, extra = {}) => ({ id: `exec_${randomUUID()}`, runtime_id: runtimeId, command, cwd: "/workspace", timeout_seconds: 15, artifact_paths: [], stdout_bytes: 0, stderr_bytes: 0, ...extra });
    const drain = async (job, activeRuntime = runtime) => {
      const output = { stdout: [], stderr: [] };
      const cursor = { ...job };
      const deadline = Date.now() + 20000;
      while (Date.now() < deadline) {
        const result = await activeRuntime.status(cursor);
        for (const stream of ["stdout", "stderr"]) {
          if (!result[stream]) continue;
          assert.equal(result[stream].offset, cursor[`${stream}_bytes`]);
          const chunk = Buffer.from(result[stream].data, "base64");
          output[stream].push(chunk);
          cursor[`${stream}_bytes`] += chunk.length;
        }
        if (result.status !== "running") return { ...result, stdout: Buffer.concat(output.stdout), stderr: Buffer.concat(output.stderr), cursor };
        await pause(25);
      }
      assert.fail("Execution did not terminate within 20 seconds");
    };

    await t.test("streams both outputs, preserves nonzero exit and binary artifacts, and replays by byte cursor", async () => {
      const job = execution("printf hello; printf problem >&2; printf '\\000\\377x' > result.bin; exit 7", { artifact_paths: ["result.bin"] });
      assert.equal((await runtime.start(job)).started, true);
      const result = await drain(job);
      assert.equal(result.status, "failed");
      assert.equal(result.exit_code, 7);
      assert.equal(result.stdout.toString(), "hello");
      assert.equal(result.stderr.toString(), "problem");
      assert.deepEqual(Buffer.from(result.artifacts[0].data, "base64"), Buffer.from([0, 255, 120]));
      const replay = await runtime.status(job);
      assert.equal(Buffer.from(replay.stdout.data, "base64").toString(), "hello");
      const tail = await runtime.status(result.cursor);
      assert.equal(tail.stdout.data, "");
      assert.equal(tail.stderr.data, "");
    });

    await t.test("a fresh runtime reconnects without rerunning a command", async () => {
      const job = execution("printf x >> executions-count; printf before; sleep 0.3; printf after");
      assert.equal((await runtime.start(job)).started, true);
      const reconnected = new ExecutionRuntime();
      assert.equal((await reconnected.start(job)).started, false);
      const result = await drain(job, reconnected);
      assert.equal(result.status, "succeeded");
      assert.equal(result.stdout.toString(), "beforeafter");
      assert.equal((await reconnected.start(job)).started, false);
      assert.equal((await exec("docker", ["exec", runtimeId, "cat", "/workspace/executions-count"])).stdout, "x");
    });

    await t.test("execution secrets override expired container values without persisting or replaying", async () => {
      const first = "fixture-old-token", fresh = "fixture-fresh-token";
      const command = 'printf "%s" "$PREVIEW_GITHUB_TOKEN"; printf "%s" "$PREVIEW_GITHUB_TOKEN" >&2; printf "%s" "$PREVIEW_GITHUB_TOKEN" > token-artifact; printf x >> secret-count';
      const oldJob = execution(command, { environment_variables: { PREVIEW_GITHUB_TOKEN: first } });
      await runtime.start(oldJob);
      assert.equal((await drain(oldJob)).stdout.toString(), "[REDACTED]");
      const job = execution(command, { environment_variables: { PREVIEW_GITHUB_TOKEN: fresh }, artifact_paths: ["token-artifact"] });
      await runtime.start(job);
      const result = await drain(job);
      assert.equal(result.status, "succeeded");
      assert.equal(result.stdout.toString(), "[REDACTED]");
      assert.equal(result.stderr.toString(), "[REDACTED]");
      assert.equal(Buffer.from(result.artifacts[0].data, "base64").toString(), "[REDACTED]");
      assert.equal((await runtime.start(job)).started, false);
      const files = (await exec("docker", ["exec", runtimeId, "sh", "-c", `cat /var/lib/driftverk/executions/${job.id}/*`])).stdout;
      assert.equal(files.includes(fresh), false);
      assert.equal(files.includes(first), false);
      assert.equal((await exec("docker", ["exec", runtimeId, "cat", "/workspace/secret-count"])).stdout, "xx");
      assert.equal((await exec("docker", ["exec", runtimeId, "cat", "/workspace/token-artifact"])).stdout, fresh, "child received fresh value, never inherited the old execution value");
    });

    await t.test("secret output masking spans separate pipe reads", async () => {
      const job = execution('printf "%s" "$TOKEN" | head -c 8; sleep 0.2; printf "%s" "$TOKEN" | tail -c +9', { environment_variables: { TOKEN: "fixture-split-token" } });
      await runtime.start(job);
      const result = await drain(job);
      assert.equal(result.status, "succeeded");
      assert.equal(result.stdout.toString(), "[REDACTED]");
    });

    await t.test("artifacts reject symlink leaves, symlink directories, and FIFOs without hanging", async () => {
      const job = execution("mkdir artifact-dir; printf safe > artifact-dir/file; ln -s artifact-dir/file artifact-link; ln -s artifact-dir artifact-parent; mkfifo artifact-pipe", { artifact_paths: ["artifact-dir/file", "artifact-link", "artifact-parent/file", "artifact-pipe"] });
      await runtime.start(job);
      const result = await drain(job);
      assert.equal(result.status, "succeeded");
      assert.equal(Buffer.from(result.artifacts[0].data, "base64").toString(), "safe");
      for (const artifact of result.artifacts.slice(1)) {
        assert.match(artifact.error, /unsafe/);
        assert.equal(artifact.data, undefined);
      }
    });

    await t.test("oversize and missing artifacts produce per-file errors", async () => {
      const job = execution("python3 -c \"open('large-artifact', 'wb').write(b'x' * 131073)\"", { artifact_paths: ["large-artifact", "missing-artifact"] });
      await runtime.start(job);
      const result = await drain(job);
      assert.equal(result.status, "succeeded");
      assert.equal(result.artifacts.length, 2);
      for (const artifact of result.artifacts) assert.match(artifact.error, /unavailable/);
    });

    await t.test("removing the working directory preserves the command exit and reports unavailable artifacts", async () => {
      await exec("docker", ["exec", runtimeId, "mkdir", "/workspace/removed-cwd"]);
      const job = execution("cd /; rmdir /workspace/removed-cwd; exit 0", { cwd: "/workspace/removed-cwd", artifact_paths: ["result.txt"] });
      await runtime.start(job);
      const result = await drain(job);
      assert.equal(result.status, "succeeded");
      assert.equal(result.exit_code, 0);
      assert.equal(result.artifacts.length, 1);
      assert.match(result.artifacts[0].error, /unavailable/);
    });

    await t.test("timeout kills the command and its ordinary child processes", async () => {
      const job = execution("sleep 30 & echo $! > timeout-child; wait", { timeout_seconds: 1 });
      await runtime.start(job);
      const result = await drain(job);
      assert.equal(result.status, "timed_out");
      assert.equal(result.exit_code, -9);
      await exec("docker", ["exec", runtimeId, "sh", "-c", "pid=$(cat /workspace/timeout-child); ! kill -0 \"$pid\" 2>/dev/null"]);
    });

    await t.test("cancellation terminates a running command", async () => {
      const job = execution("printf started; exec sleep 30");
      await runtime.start(job);
      let ready = false;
      for (let i = 0; i < 30; i++) {
        const state = await runtime.status(job);
        if (Buffer.from(state.stdout.data, "base64").toString() === "started") { ready = true; break; }
        await pause(25);
      }
      assert.equal(ready, true);
      const result = await drain({ ...job, cancel_requested: true });
      assert.equal(result.status, "cancelled");
      assert.equal(result.exit_code, -9);
    });

    await t.test("a lost supervisor is reported without rerunning its command", async () => {
      const job = execution("printf x >> lost-count; echo $$ > lost-child; exec sleep 30");
      await runtime.start(job);
      await exec("docker", ["exec", runtimeId, "python3", "-c", "import json,os,signal,time\nfrom pathlib import Path\np=Path('/workspace/lost-child')\nfor _ in range(100):\n if p.exists(): break\n time.sleep(.01)\nworker=json.load(open('/var/lib/driftverk/executions/' + __import__('sys').argv[1] + '/worker.json'))\nos.kill(worker['pid'], signal.SIGKILL)\nos.killpg(int(p.read_text()), signal.SIGKILL)", job.id]);
      await pause(100);
      const reconnected = new ExecutionRuntime();
      assert.equal((await reconnected.start(job)).started, false);
      assert.equal((await reconnected.status(job)).status, "lost");
      assert.equal((await exec("docker", ["exec", runtimeId, "cat", "/workspace/lost-count"])).stdout, "x");
    });

    await t.test("output is capped and remaining pages drain before the terminal status", async () => {
      const job = execution("python3 -c \"import sys; sys.stdout.write('x' * 1200000)\"");
      await runtime.start(job);
      const result = await drain(job);
      assert.equal(result.status, "output_limit");
      assert.equal(result.stdout.length, 1048576);
      assert.equal(result.stdout.equals(Buffer.alloc(1048576, "x")), true);
      assert.equal((await runtime.status(result.cursor)).stdout.data, "");
    });
  } finally {
    if (created) await exec("docker", ["rm", "-f", name]);
  }
});
