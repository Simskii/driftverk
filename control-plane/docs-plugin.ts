import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import type { Plugin } from "vite";
import pages from "./docs/pages.json";

// The same Markdown feeds the browser, plain-text downloads and agent index.
export function docsPlugin(): Plugin {
  function assets() {
    const documents = pages.map((page) => ({ ...page, content: readFileSync(resolve(import.meta.dirname, "docs", page.source), "utf8") }));
    return new Map([
      ["/docs/skills/driftverk-cli/SKILL.md", readFileSync(resolve(import.meta.dirname, "../cli/skills/driftverk-cli/SKILL.md"), "utf8")],
      ...documents.map((page): [string, string] => [`/docs/${page.slug}.md`, page.content]),
      ["/llms.txt", `# Driftverk documentation\n\nCreate and manage isolated development environments.\n\n${documents.map((page) => `- [${page.title}](https://app.driftverk.com/docs/${page.slug}.md): ${page.description}`).join("\n")}\n`],
      ["/llms-full.txt", documents.map((page) => `${page.content}\n`).join("\n---\n\n")],
    ]);
  }
  return {
    name: "driftverk-docs",
    configureServer(server) {
      server.middlewares.use((req, res, next) => {
        const path = req.url?.split("?")[0] ?? "";
        if (!path.endsWith(".md") && !["/llms.txt", "/llms-full.txt"].includes(path)) return next();
        const content = assets().get(path);
        if (content === undefined) return next();
        res.setHeader("Content-Type", `${path.endsWith(".md") ? "text/markdown" : "text/plain"}; charset=utf-8`);
        res.end(content);
      });
    },
    generateBundle() {
      for (const [path, source] of assets()) this.emitFile({ type: "asset", fileName: path.slice(1), source });
    },
  };
}
