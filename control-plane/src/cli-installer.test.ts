import assert from "node:assert/strict";
import test from "node:test";
import { createServer } from "node:http";
import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const exec = promisify(execFile);
test("Unix installer verifies checksums and preserves the existing CLI on failure", { skip: process.platform === "win32" }, async () => {
  const root = await mkdtemp(join(tmpdir(), "driftverk-installer-"));
  const binary = "#!/bin/sh\nprintf 'test-cli\\n'\n";
  const digest = createHash("sha256").update(binary).digest("hex");
  let mode = "valid";
  const server = createServer((req, res) => {
    if (mode === "missing") { res.writeHead(404); res.end(); return; }
    res.end(req.url?.endsWith(".sha256") ? `${mode === "invalid" ? "0".repeat(64) : digest}  artifact\n` : binary);
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const address = server.address() as { port: number };
  const env = { ...process.env, DRIFTVERK_CONTROL_PLANE_URL: `http://127.0.0.1:${address.port}`, DRIFTVERK_BIN_DIR: root };
  const installer = fileURLToPath(new URL("../installer/cli.sh", import.meta.url));
  try {
    const installed = await exec("sh", [installer], { env });
    assert.equal(installed.stdout, "Installed Driftverk CLI\n");
    assert.equal(await readFile(join(root, "driftverk"), "utf8"), binary);
    for (mode of ["invalid", "missing"]) {
      await writeFile(join(root, "driftverk"), "existing-cli");
      await assert.rejects(exec("sh", [installer], { env }));
      assert.equal(await readFile(join(root, "driftverk"), "utf8"), "existing-cli");
    }
  } finally {
    server.close();
    await rm(root, { recursive: true, force: true });
  }
});
