import api from "../../docs/api.md?raw";
import githubActions from "../../docs/github-actions.md?raw";
import webhooks from "../../docs/webhooks.md?raw";
import definitions from "../../docs/pages.json";

const guides = import.meta.glob("../../docs/guides/*.md", { query: "?raw", import: "default", eager: true }) as Record<string, string>;
const sources: Record<string, string> = {
  ...guides,
  "../../docs/api.md": api,
  "../../docs/github-actions.md": githubActions,
  "../../docs/webhooks.md": webhooks,
};

export const docsPages = definitions.map((page) => ({
  ...page,
  path: `/docs/${page.slug}`,
  markdown: sources[`../../docs/${page.source}`],
}));
export type DocsPage = typeof docsPages[number];

export function headingId(text: string) {
  return text.toLowerCase().replace(/[^a-z0-9\s-]/g, "").trim().replace(/\s+/g, "-");
}

export function sectionHeadings(markdown: string) {
  let fenced = false;
  return markdown.split("\n").flatMap((line) => {
    if (line.startsWith("```")) fenced = !fenced;
    const match = !fenced && /^## (.+)$/.exec(line);
    return match ? [{ title: match[1], id: headingId(match[1]) }] : [];
  });
}
