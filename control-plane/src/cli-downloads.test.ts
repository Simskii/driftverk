import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { Hono } from "hono";
import { cliDownload } from "./cli-downloads.js";

test("CLI downloads allow only known platform artifacts and return 404 when absent", async () => {
  const root = await mkdtemp(join(tmpdir(), "driftverk-downloads-"));
  try {
    await mkdir(join(root, "bin"));
    await writeFile(join(root, "bin", "driftverk-windows-arm64.exe"), "binary");
    await writeFile(join(root, "bin", "driftverk-windows-arm64.exe.sha256"), "checksum");
    await writeFile(join(root, "bin", "secret"), "private");
    const app = new Hono();
    app.get("/install/bin/:file", cliDownload(pathToFileURL(`${root}/`)));
    const binary = await app.request("/install/bin/driftverk-windows-arm64.exe");
    assert.equal(binary.status, 200);
    assert.equal(binary.headers.get("content-type"), "application/octet-stream");
    assert.equal(binary.headers.get("cache-control"), "no-store");
    assert.equal(await binary.text(), "binary");
    const checksum = await app.request("/install/bin/driftverk-windows-arm64.exe.sha256");
    assert.equal(checksum.status, 200);
    assert.equal(await checksum.text(), "checksum");
    for (const file of ["secret", "driftverk-linux-386", "driftverk-linux-amd64", "..%2Fsecret", "driftverk-windows-arm64.exe%2Fextra"]) {
      assert.equal((await app.request(`/install/bin/${file}`)).status, 404, file);
    }
  } finally { await rm(root, { recursive: true, force: true }); }
});
