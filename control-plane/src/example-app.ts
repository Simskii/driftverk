// Shared by the browser and CLI quickstart.
const page = `<!doctype html>
<html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>Your Driftverk example</title>
<style>body{margin:0;background:#f5f5f0;color:#202722;font:18px/1.6 system-ui}main{max-width:640px;margin:12vh auto;padding:24px}small{color:#526257}h1{font-size:clamp(32px,7vw,52px);line-height:1.1}button{background:#264d38;color:white;border:0;border-radius:8px;padding:14px 22px;font:inherit;cursor:pointer}button:focus-visible{outline:3px solid #718d38;outline-offset:4px}output{display:block;margin:16px 0;font-weight:600}</style>
<main><small>DRIFTVERK / EXAMPLE APP</small><h1>Your environment is live.</h1><p>This page is served by the app running in your environment. Try the button, then change the heading from Terminal.</p><button id="counter">Add one</button><output aria-live="polite">Count: 0</output><p>Return to Driftverk for the edit command. Refresh this page after running it.</p></main>
<script>let count=0;document.querySelector('button').onclick=()=>{document.querySelector('output').textContent='Count: '+(++count)}</script></html>`;

const server = `const http = require('node:http');
const fs = require('node:fs');
http.createServer((req, res) => {
  fs.readFile(__dirname + '/index.html', (error, page) => {
    res.writeHead(error ? 500 : 200, {'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store'});
    res.end(error ? 'Could not read index.html' : page);
  });
}).listen(Number(process.env.PORT || 3000), '0.0.0.0', function () { console.log('Example listening on ' + this.address().port); });`;

export const exampleApp = {
  source_type: "image",
  image: "node:22-bookworm-slim",
  cpu: 1,
  memory_mb: 1024,
  auto_stop_minutes: 15,
  auto_archive_minutes: null,
  auto_delete_minutes: null,
  preview_enabled: true,
  initialization_command: `mkdir -p driftverk-example\ncat > driftverk-example/index.html <<'DRIFTVERK_HTML'\n${page}\nDRIFTVERK_HTML\ncat > driftverk-example/server.cjs <<'DRIFTVERK_SERVER'\n${server}\nDRIFTVERK_SERVER`,
  startup_command: "node /workspace/driftverk-example/server.cjs",
  readiness_command: `node -e 'fetch("http://127.0.0.1:" + (process.env.PORT || 3000)).then(r => { if (!r.ok) process.exit(1) }).catch(() => process.exit(1))'`,
};

export const exampleEditCommand = `node -e 'const fs = require("node:fs"); const p = "/workspace/driftverk-example/index.html"; fs.writeFileSync(p, fs.readFileSync(p, "utf8").replace("Your environment is live.", "I changed this from my environment."))'`;

export function isExampleApp(environment: { startup_command?: string | null; readiness_command?: string | null }) {
  return environment.startup_command === exampleApp.startup_command && environment.readiness_command === exampleApp.readiness_command;
}
