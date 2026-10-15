# Maintaining public documentation

Public navigation is defined in `pages.json`. Guides live in `guides/`; the API, GitHub Actions and webhook pages reuse their existing Markdown files. Internal billing and operational notes are not public docs pages.

The browser renders the source Markdown. `docs-plugin.ts` emits `/docs/<slug>.md`, `/llms.txt` and `/llms-full.txt` from the same sources during the Vite build and serves them during development. The production control plane serves those generated files without authentication. Keep the plugin included in the Docker build.

When adding a page, add its manifest entry and source file. New guide files are picked up by the frontend automatically; reference files outside `guides/` also need an explicit import in `web/src/docs-content.ts`. Use absolute `/docs/<slug>` links for other guides and `/v1/openapi.yaml` for the contract. Second-level headings supply the page contents navigation.

Check claims against the implementation being released. Do not document an unpublished package as installable from npm, or a planned integration as available. Keep customer instructions separate from internal deployment procedures. Never include real credentials or private preview URLs.

Run `npm run check`, `npm run test:web` and `npm run build`. Inspect signed-out `/docs` and an article, search, mobile navigation, code copying, section links and Markdown downloads. Builds and docs checks do not prove that the described compute workflow works on a live host.

The AI skill download at `/docs/skills/driftverk-cli/SKILL.md` comes from `cli/skills/driftverk-cli/SKILL.md` at the repository root. The CLI embeds that same file. Keep it available to the web build, including the Docker build stage.
