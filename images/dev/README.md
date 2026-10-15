# Driftverk Dev

Development image with Node.js, npm, pnpm, Bun, Python, uv, Codex, Claude Code,
Git, GitHub CLI, build tools, Docker Compose, Tailscale, and a shared Chromium desktop.

```sh
docker pull ghcr.io/simskii/dev:2026.09.4
```

Supports Linux on AMD64 and ARM64. Docker starts on demand.

Desktop tooling is included in the Dev image. See
[desktop development and verification](desktop/README.md).
Desktop services start on demand and stop after five minutes without viewers
or a managed prompt. Older environments need an image upgrade or recreation.

Tailscale is installed but logged out. In environment Settings, choose **Set up
Tailscale**, then **Authorize in Tailscale**. This enables Tailscale SSH using
your tailnet's access rules. It does not enable subnet routing, change DNS, or
disable the Driftverk SSH gateway.

Tailscale state belongs to the environment. Sign out through Settings before
capturing a snapshot. Direct Tailscale connections do not reset Driftverk's
auto-stop timer. Disable auto-stop if the environment must stay reachable.
