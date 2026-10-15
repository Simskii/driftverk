import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const root = new URL("../../docs/", import.meta.url);
const pages = JSON.parse(readFileSync(new URL("pages.json", root), "utf8")) as Array<{ slug: string; source: string }>;
const documents = new Map(pages.map((page) => [page.slug, readFileSync(new URL(page.source, root), "utf8")]));
const slugify = (text: string) => text.toLowerCase().replace(/[^a-z0-9\s-]/g, "").trim().replace(/\s+/g, "-");

test("published documentation has unique routes and working guide links", () => {
  assert.equal(documents.size, pages.length, "Duplicate documentation route");
  for (const [slug, markdown] of documents) {
    assert.match(markdown, /^# .+/);
    for (const match of markdown.matchAll(/\]\(\/docs\/([^\s)#]+)(?:#([^\s)]+))?\)/g)) {
      if (match[1] === "skills/driftverk-cli/SKILL.md") {
        assert.ok(readFileSync(new URL("../../cli/skills/driftverk-cli/SKILL.md", root), "utf8"));
        continue;
      }
      const target = documents.get(match[1]!);
      assert.ok(target, `${slug}: missing page ${match[1]}`);
      if (match[2]) {
        const headings = Array.from(target.matchAll(/^#{2,3} (.+)$/gm), (heading) => slugify(heading[1]!));
        assert.ok(headings.includes(match[2]), `${slug}: missing section ${match[0]}`);
      }
    }
  }
});
