import { readFile } from "node:fs/promises";
import type { Context } from "hono";

const cliFiles = new Set(
  ["darwin", "linux", "windows"].flatMap(os =>
    ["amd64", "arm64"].flatMap(arch => {
      const file = `driftverk-${os}-${arch}${os === "windows" ? ".exe" : ""}`;
      return [file, `${file}.sha256`];
    }),
  ),
);

export function cliDownload(installerRoot: URL) {
  return async (c: Context) => {
    const file = c.req.param("file");
    if (!file || !cliFiles.has(file)) return c.notFound();
    try {
      return c.body(await readFile(new URL(`bin/${file}`, installerRoot)), 200, {
        "Content-Type": file.endsWith(".sha256") ? "text/plain; charset=utf-8" : "application/octet-stream",
        "Content-Disposition": `attachment; filename="${file}"`,
        "Cache-Control": "no-store",
      });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return c.notFound();
      throw error;
    }
  };
}
