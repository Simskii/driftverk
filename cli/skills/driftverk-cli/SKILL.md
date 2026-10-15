---
name: driftverk-cli
description: Use the Driftverk CLI to create and manage development environments, run remote commands over SSH, inspect logs, open shared browsers and desktops, and record agent tasks. Use when the user asks to work with Driftverk environments from a terminal.
---

# Driftverk CLI

Run `driftverk help` and `driftverk <command> --help` to check the installed command options. Do not assume an `exec` command or JSON output flags exist. The CLI requires shell access; SSH uses the local OpenSSH client.

## Account and target

Run `driftverk whoami` and `driftverk ls` before choosing an environment. API commands use the active organization. If sign-in is needed, run `driftverk login --no-browser` and let the user complete browser authorization. Never ask for their password or read stored tokens. Organization selection and SSH key registration can be prepared with `driftverk setup --no-browser`; this can require interactive input. If the agent cannot handle it, have the user run setup in their terminal.

Use the user's existing environment when appropriate. Do not switch organizations, create extra environments, or change billing to work around a permission or capacity error. Members may be limited to one personal environment with an admin-selected image and size.

## Create an environment

For an authorized creation, use an explicit name and source. Replace these example values with the user's repository and remote branch:

```sh
driftverk create task-dev --repository owner/repository --branch main --yes --no-connect --no-browser
```

`--yes` accepts the creation summary; it does not bypass authentication, organization selection, or key setup. Use it only after the intended organization and source are known. Creation can incur compute and storage charges.

Alternatively, `driftverk create task-dev --empty --yes --no-connect` creates a development environment without a repository. Source options `--repository`, `--empty`, `--example`, and `--snapshot` are mutually exclusive. Use `--image` only when a custom image is requested and supported by the account.

Creation clones GitHub. Local files and unpushed commits are not uploaded. Do not push code unless that is within the user's request. A root Compose file starts automatically unless an explicit startup command overrides it.

Creation waits for readiness. If it times out or the response is interrupted, run `driftverk ls` and `driftverk logs task-dev` before retrying. The environment may already exist. Do not create duplicates or delete a failed environment as an automatic retry strategy.

## Run remote work

Use SSH for commands, with the remote shell expression quoted locally:

```sh
driftverk ssh task-dev -- 'pwd; ls'
```

Inspect the remote checkout location before running project commands. Then use an explicit directory, for example `driftverk ssh task-dev -- 'cd /actual/checkout && npm test'`. Replace the path and test command with those found in the environment. Local edits are separate from the remote checkout.

SSH also accepts `organization-slug/environment-name`. Use that form when the name is ambiguous across organizations; SSH resolves the target separately from the active API organization. For a human's interactive agent or shell session, use `driftverk connect task-dev`. `driftverk ssh-config task-dev` modifies the local SSH configuration for editors.

## Inspect and preview

- `driftverk logs task-dev` shows setup and application logs.
- `driftverk ls` shows environment state and provisioning progress.
- `driftverk preview task-dev --port 3000` prints an access link for that port.
- `driftverk cost` shows organization usage and balance information.

Check that the app is listening on the intended port and on `0.0.0.0` before claiming its preview works. Environment readiness alone does not prove app behavior. Preview URLs contain access credentials; share only with the intended user, never commit them or publish them in logs or issues.

## Shared browser and desktop

First check the installed CLI's help. These commands require an environment image
with Driftverk desktop tooling; updating the CLI does not add it to an existing
image. Use a desktop-enabled environment supplied by the user or workspace admin.
Do not recreate an environment just to add these tools.

```sh
driftverk browser task-dev --no-browser
driftverk desktop task-dev --no-browser
driftverk prompt task-dev "Test the checkout flow in the open browser window"
driftverk prompt task-dev "Test the checkout flow in the open browser window" --record --output checkout.mp4
```

`browser` starts the desktop and opens/restores Chromium. `desktop` opens the same
full display without changing its focused window. Omit `--no-browser` to open the
viewer locally. Both require SSH and HTTP preview access. These viewers show the
browser inside the environment; `preview --port 3000` shows the application in
the local browser instead. Their expiring URLs grant desktop control, so do not
put them in a PR or other public evidence.

The web interface also has **Desktop → Open desktop** next to Terminal. It uses
the existing execution service and does not require SSH. Viewers start view-only;
**Take control** enables input but does not pause agents. Closing Chromium leaves
the desktop available. After the last viewer disconnects, all desktop services
stop after five minutes unless a managed prompt or recording is active. A
reconnect resets the timer; completed prompts get a fresh grace period.
Use `driftverk desktop task-dev --stop` or **Stop desktop** to stop immediately.
Finish or cancel a managed prompt first so its recording finalizes. Independently
launched agents are not tracked; keep a viewer connected while they need it.
Desktop tooling is included in new Driftverk Dev builds; older environments need
an image upgrade or recreation.

`prompt` delegates one task to Codex using its existing in-environment CLI login
or API credentials. It does not inherit the web agent tab's managed account
connection. Use `driftverk connect task-dev` for interactive CLI login when needed.
The working directory defaults to the configured workspace; `--cwd` overrides it.
Codex uses workspace-write permissions with network access and is instructed to
attach to the existing Chromium session. If operating the browser directly,
attach to `http://127.0.0.1:9222` inside the environment rather than launching a
separate browser. Do not recursively delegate a task you are already running.

Only one prompt can use the desktop at a time, with a 30-minute limit. Independent
agents and manual viewers are not paused. Do not assume recording makes their
concurrent actions belong to your task.

## Recording and PR evidence

When recording is requested, use `prompt --record`. The runner starts FFmpeg before
the agent and finalizes the MP4 after completion, failure or interruption; a skill
instruction alone does not start recording. `--output` requires `--record`, and
the CLI refuses to overwrite existing files. The default is `driftverk-RUN_ID.mp4`.

Verify the reported local file. A saved video does not mean the task succeeded;
check the agent's result and command exit status. The remote copy and `status.json`
remain under `~/.local/share/driftverk/runs/RUN_ID/`. If downloading failed, retrieve
it after reconnecting, using a local filename that does not already exist:

```sh
driftverk ssh task-dev -- driftverk-prompt export RUN_ID > recovered.mp4
```

For a requested PR attachment, verify the intended repository, branch, current
commit and PR before uploading. Describe what the recording actually demonstrates.
Relevant code changes make earlier evidence stale. Inspect the video for secrets
before sharing, and use available GitHub attachment tooling; check installed tool
support instead of assuming an upload flag exists. If upload is unavailable,
report the local file and remaining step. Do not claim the video is attached until
the target PR contains it. Do not commit MP4 files or publish preview credentials
as a substitute. Recording alone does not authorize creating a PR or posting a
comment.

## Lifecycle and cleanup

`driftverk start task-dev` and `driftverk stop task-dev` queue actions. Check `driftverk ls` for completion. Stopping ends processes and preserves writable files; storage charges may continue. SSH, terminals, or valid previews can wake an environment stopped automatically. An explicit stop requires an explicit start first.

`driftverk fork task-dev task-copy` captures and retains a snapshot before creating a new environment. Use it only when a copy is requested; snapshots can preserve credentials and other sensitive files.

Delete only with the user's authorization for the specific environment. `driftverk delete task-dev` requires its name to be entered and permanently removes its writable filesystem. Do not bypass that confirmation or use deletion for routine cleanup. Retained snapshots and other resources have separate lifecycles.

Report the environment, commands run, observed results, and what remains unverified. Distinguish a queued action from completion and a printed preview URL from a tested application.

For desktop setup, recording behavior and recovery, read https://app.driftverk.com/docs/desktop.md. For lifecycle details, read https://app.driftverk.com/docs/environments.md and https://app.driftverk.com/docs/troubleshooting.md.
