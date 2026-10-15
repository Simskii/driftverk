# Quickstart

Start with a repository you trust. Use the CLI from your terminal or create an environment in the web panel. Both paths give you the same SSH, terminal, and preview access.

## Before you start

[Sign in](/sign-in) and select your organization. Hybrid organizations need a connected, healthy [compute host](/docs/hybrid-installation). Cloud compute needs available capacity and sufficient balance. Check the rates and access shown in your organization's Billing page before starting.

## Start from your terminal

The native CLI supports macOS, Linux and Windows on Intel/AMD 64-bit and ARM64.
Python and WSL are not required. Connections use your system's OpenSSH client
(`ssh` and `ssh-keygen`).

On macOS or Linux, run this in your terminal. The installer requires `curl` and
`sha256sum` or `shasum`:

```bash
curl -fsSL https://app.driftverk.com/install/cli | sh
```

On Windows, run this in PowerShell:

```powershell
irm https://app.driftverk.com/install/cli.ps1 | iex
```

Windows installs into `%LOCALAPPDATA%\Driftverk\bin` and adds it to your user
PATH. Install the OpenSSH Client from Windows Optional Features if `ssh` or
`ssh-keygen` is missing. macOS and Linux install into `/usr/local/bin`, using
`sudo` when needed. Set `DRIFTVERK_BIN_DIR` to use another directory.

Run the CLI inside your GitHub checkout:

```sh
driftverk create
```

Sign in when prompted, then review the organization, repository, remote branch,
and image before confirming. The environment clones from GitHub; it does not
upload local files or unpushed commits. Creation waits for readiness and offers
Codex, an SSH shell, or editor setup.

For development tools without a repository, run `driftverk create my-dev --empty`.
Members can create one personal environment when enabled; its size is chosen by
an admin. To return to an existing environment, run `driftverk connect NAME`.

For a direct shell use `driftverk ssh NAME`. To add an SSH host for Codex or
T3 Code, use `driftverk ssh-config NAME`. Regular SSH works without the CLI too.
Follow [Codex and T3 Code over SSH](/docs/codex-and-t3-code) for both connection
paths, or see the [CLI commands](/docs/environments#cli-commands).

To let an AI agent use the CLI, [install the Driftverk skill](/docs/cli-skill).

## Create an environment in the web panel

1. Choose **Open a repository** on the empty Environments page, or open [Quickstart](/environments/new?quickstart=1).
2. Enter a public repository as `owner/repository`, or connect GitHub to choose a private repository. Leave the branch empty to use its default branch.
3. A standard root Compose file starts automatically unless you set an explicit startup command. For other projects, expand **Setup commands** to install dependencies and start the app, or run those commands in the terminal after creation.
4. Choose **Start environment**. Members use the size approved by their admin. Admins start with Small: 1 vCPU, 2 GB memory and auto-stop after 15 minutes of inactivity. The form shows the Cloud cost estimate. Use **Customize environment** for a different size, image, variables or other settings; your entered repository and commands stay in place.
5. Watch setup progress. Once the environment is running, choose **Open terminal** or **Connect your agent**. A running environment does not necessarily mean your web app has started; check its output and listening port before opening a preview.

No repository handy? Choose [Try an example app](/environments/example) to start a small web app you can edit and preview without connecting GitHub.

For a blank shell, snapshot or saved blueprint, use [Create environment](/environments/new). If setup fails, open its logs or the terminal's **Show project output** view before retrying.

## Run a command

Open the environment's web terminal and connect. Run:

```bash
pwd
printf 'Hello from Driftverk\n'
```

You should see the current working directory and the greeting. Run your project's test command here, such as `npm test` for a repository that defines it.

## Open your app

Configure your app to listen on `0.0.0.0`, not only `127.0.0.1`. Choose its detected HTTP port or enter the port manually, then open the private preview.

The preview URL contains a temporary access credential. Share it only with people who should have access. A valid preview can wake an environment stopped automatically after inactivity. If you explicitly stopped it, choose **Start** first.

For an editor connection, add your public SSH key in Settings, then use the SSH command displayed by the environment. Keep the private key on your computer.

To run an agent in the environment from your local desktop app, follow [Codex and T3 Code over SSH](/docs/codex-and-t3-code).

For a shared browser inside a desktop-enabled environment, use the **Desktop**
tab or `driftverk browser NAME`. See [Browser and desktop](/docs/desktop) to run
and record a browser task with an agent.

## Stop and clean up

Close the preview and terminal, then stop the environment. Wait for it to show as stopped. This ends its processes but preserves its writable files. An explicit stop keeps it stopped until you choose **Start** or run `driftverk start NAME`. Only environments stopped automatically can wake through preview, terminal or SSH access.

Delete the environment when you no longer need those files. Deletion is permanent for its writable filesystem; separately retained snapshots, volumes and execution results have their own lifecycle. See [Lifecycle and storage](/docs/environments).

## Repeat the setup

Save reusable repository and command settings as a project setup. Build a clean prebuild when you want new environments to reuse an installed checkout. Follow [Project setup](/docs/project-setup), or [connect an agent through MCP](/docs/mcp).
