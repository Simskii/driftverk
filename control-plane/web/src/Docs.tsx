import { ArrowLeft, ArrowRight, BookOpen, List, X } from "@phosphor-icons/react";
import { Children, isValidElement, useEffect, useRef, useState, type ReactNode } from "react";
import Markdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { Link, NavLink, useLocation } from "react-router-dom";
import { docsPages, headingId, sectionHeadings, type DocsPage } from "./docs-content";

function textContent(children: ReactNode): string {
  return Children.toArray(children).map((child): string => isValidElement<{ children?: ReactNode }>(child)
    ? textContent(child.props.children) : String(child)).join("");
}

function CopyButton({ text, label = "Copy" }: { text: string; label?: string }) {
  const [status, setStatus] = useState("");
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  useEffect(() => () => clearTimeout(timer.current), []);
  async function copy() {
    try { await navigator.clipboard.writeText(text); setStatus("Copied"); }
    catch { setStatus("Select text to copy"); }
    clearTimeout(timer.current);
    timer.current = setTimeout(() => setStatus(""), 2500);
  }
  return <button type="button" className="docs-copy" onClick={() => void copy()} aria-live="polite">{status || label}</button>;
}

function CodeBlock({ children }: { children?: ReactNode }) {
  const code = Children.toArray(children)[0];
  const language = isValidElement<{ className?: string }>(code) ? code.props.className?.replace("language-", "") : "text";
  return <div className="docs-code"><div className="docs-code-toolbar"><span>{language || "text"}</span><CopyButton text={textContent(children).replace(/\n$/, "")} /></div><pre>{children}</pre></div>;
}

export function Docs({ signedIn }: { signedIn: boolean }) {
  const location = useLocation();
  const [mobileNavigationOpen, setMobileNavigationOpen] = useState(false);
  const [query, setQuery] = useState("");
  const page = docsPages.find((candidate) => candidate.path === location.pathname.replace(/\/$/, ""));
  const home = /^\/docs\/?$/.test(location.pathname);
  const terms = query.trim().toLowerCase().split(/\s+/).filter(Boolean);
  const results = docsPages.filter((candidate) => terms.every((term) => `${candidate.title} ${candidate.description} ${candidate.markdown}`.toLowerCase().includes(term)));

  useEffect(() => {
    document.title = `${page?.title ?? (home ? "Documentation" : "Page not found")} · Driftverk`;
    setMobileNavigationOpen(false);
    setQuery("");
    if (location.hash) {
      let id = location.hash.slice(1);
      try { id = decodeURIComponent(id); } catch { /* Keep malformed fragments as text. */ }
      document.getElementById(id)?.scrollIntoView();
    } else {
      window.scrollTo(0, 0);
    }
    return () => { document.title = "Driftverk"; };
  }, [page?.title, home, location.pathname, location.hash]);

  useEffect(() => {
    function onKey(event: KeyboardEvent) { if (event.key === "Escape") setMobileNavigationOpen(false); }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  return <div className="docs-shell">
    <a className="docs-skip" href="#docs-content">Skip to content</a>
    <header className="docs-header">
      <Link className="docs-brand" to="/docs"><span>Driftverk</span><small>Docs</small></Link>
      <div className="docs-header-actions">
        <a href="mailto:hello@driftverk.com">Support</a>
        <Link className="button button-primary" to={signedIn ? "/environments" : "/sign-in"}>{signedIn ? "Open Driftverk" : "Sign in"}<ArrowRight /></Link>
        <button type="button" className="docs-menu-button" aria-label={mobileNavigationOpen ? "Close documentation navigation" : "Open documentation navigation"} aria-controls="docs-navigation" aria-expanded={mobileNavigationOpen} onClick={() => setMobileNavigationOpen(!mobileNavigationOpen)}>{mobileNavigationOpen ? <X /> : <List />}</button>
      </div>
    </header>
    <div className="docs-frame">
      <aside id="docs-navigation" className={`docs-sidebar${mobileNavigationOpen ? " open" : ""}`}>
        <label className="docs-search">Search documentation<input type="search" value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Search guides and reference" /></label>
        {terms.length > 0 ? <nav aria-label="Search results" className="docs-search-results"><p role="status">{results.length} {results.length === 1 ? "result" : "results"}</p>{results.map((result) => <Link key={result.path} to={result.path} onClick={() => { setQuery(""); setMobileNavigationOpen(false); }}><strong>{result.title}</strong><small>{result.description}</small></Link>)}</nav> : <nav aria-label="Documentation">
          <NavLink to="/docs" end className="docs-nav-home"><BookOpen />Documentation</NavLink>
          {["Start", "Use Driftverk", "Reference"].map((group) => <section key={group}><h2>{group}</h2>{docsPages.filter((item) => item.group === group).map((item) => <NavLink key={item.path} to={item.path} onClick={() => setMobileNavigationOpen(false)} className={({ isActive }) => isActive ? "active" : ""}>{item.title}</NavLink>)}</section>)}
        </nav>}
      </aside>
      <main className="docs-main" id="docs-content" tabIndex={-1}>
        {page ? <DocsArticle key={page.slug} page={page} /> : home ? <DocsHome /> : <div className="docs-home"><p className="docs-kicker">404</p><h1>Page not found</h1><p className="docs-home-lead">This documentation page does not exist.</p><Link to="/docs">Browse the documentation</Link></div>}
      </main>
    </div>
  </div>;
}

function DocsHome() {
  return <div className="docs-home">
    <p className="docs-kicker">Driftverk documentation</p>
    <h1>From repository to running environment.</h1>
    <p className="docs-home-lead">Set up your project, connect your agent and run it on isolated compute. Start with a working preview, then automate the same workflow.</p>
    <div className="docs-home-actions"><Link className="button button-primary" to="/docs/getting-started">Start the quickstart<ArrowRight /></Link><Link className="button button-secondary" to="/docs/mcp">Connect with MCP</Link></div>
    <div className="docs-card-grid">{docsPages.filter((page) => ["getting-started", "mcp", "project-setup", "environments", "hybrid-installation", "troubleshooting"].includes(page.slug)).map((page) => <Link className="docs-card" key={page.path} to={page.path}><span className="docs-card-icon"><BookOpen /></span><span><strong>{page.title}</strong><p>{page.description}</p></span><ArrowRight /></Link>)}</div>
    <div className="docs-resource-links"><Link to="/docs/api">API reference</Link><Link to="/docs/sdk">Node.js SDK</Link><a href="/v1/openapi.yaml">OpenAPI</a><a href="/llms.txt">llms.txt</a><a href="/llms-full.txt">All docs as text</a></div>
  </div>;
}

const referenceLinks: Record<string, string> = {
  "./webhooks.md": "/docs/webhooks", "./openapi.yaml": "/v1/openapi.yaml",
  "/v1/docs/github-actions": "/docs/preview-environments",
};

function DocsArticle({ page }: { page: DocsPage }) {
  const index = docsPages.indexOf(page);
  const previous = docsPages[index - 1];
  const next = docsPages[index + 1];
  const headings = sectionHeadings(page.markdown);
  return <article className="docs-article">
    <div className="docs-article-heading"><p className="docs-kicker">{page.group}</p><h1>{page.title}</h1><p>{page.description}</p><div className="docs-resource-links"><CopyButton text={page.markdown} label="Copy for an agent" /><a href={`${page.path}.md`}>View Markdown</a></div></div>
    {headings.length > 0 && <details className="docs-contents" open><summary>On this page</summary><nav aria-label="On this page">{headings.map((heading) => <a key={heading.id} href={`#${heading.id}`}>{heading.title}</a>)}</nav></details>}
    <div className="docs-prose"><Markdown remarkPlugins={[remarkGfm]} components={{
      h1: () => null,
      h2: ({ children }) => <h2 id={headingId(textContent(children))}>{children}</h2>,
      h3: ({ children }) => <h3 id={headingId(textContent(children))}>{children}</h3>,
      pre: CodeBlock,
      table: ({ children }) => <div className="docs-table-scroll" tabIndex={0} role="region" aria-label="Reference table"><table>{children}</table></div>,
      a: ({ href, children }) => { const target = referenceLinks[href ?? ""] ?? href ?? "#"; return target.startsWith("/docs/") && !target.endsWith(".md") ? <Link to={target}>{children}</Link> : <a href={target} download={target === "/docs/skills/driftverk-cli/SKILL.md" ? "SKILL.md" : undefined}>{children}</a>; },
    }}>{page.markdown}</Markdown></div>
    <nav className="docs-pagination" aria-label="Previous and next documentation pages">
      {previous ? <Link to={previous.path}><ArrowLeft /><span><small>Previous</small><strong>{previous.title}</strong></span></Link> : <span />}
      {next ? <Link to={next.path}><span><small>Next</small><strong>{next.title}</strong></span><ArrowRight /></Link> : <span />}
    </nav>
  </article>;
}
