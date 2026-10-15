# Codex and T3 Code over SSH

Use the Codex or T3 Code desktop app on your computer while the agent reads files, edits code and runs commands inside your Driftverk environment. The repository and development tools live in the environment. Your local app connects over SSH.

## Start with the Driftverk CLI

Install the native CLI for macOS, Linux or Windows. Intel/AMD 64-bit and ARM64
are supported, with no Python or WSL requirement. Follow the
[installation instructions](/docs/environments#connect-with-the-cli) for your
platform. SSH connections require `ssh` and `ssh-keygen` from OpenSSH.

From your project folder, create an environment:

```bash
driftverk create
```

The CLI signs you in when needed, prepares your SSH key, and detects the
GitHub `origin`. It checks your current branch on origin and shows the
organization, repository, branch, and image for confirmation. The environment
clones from GitHub; local files and unpushed changes are not uploaded.

For a blank environment with the maintained development tools:

```bash
driftverk create my-dev --empty
```

Members can create one personal environment when their workspace permits it.
Admins choose its size. See [Member access](/docs/environments#member-access).
Driftverk Dev includes Codex, Node.js, Git, and tmux. Custom images and older
environments may have different tools. No desktop app needs to be installed
inside the environment.

Once the environment is ready, interactive creation offers guided setup:

- **Codex** checks the remote tools, helps you sign in, and starts or reconnects
  to a persistent terminal session.
- **Just the environment** opens an SSH shell.
- **Finish setup for my editor** configures a local SSH alias, then returns
  you to your terminal so you can add it to your desktop app.

To return to this menu for an existing environment:

```bash
driftverk connect my-dev
```

Use `driftverk create my-dev --empty --no-connect` to create without opening
the menu. On a machine without a browser, add `--no-browser` and open the
printed login link on another device.

## Prepare your editor connection with the CLI

For an existing environment, configure SSH without entering the setup menu:

```bash
driftverk ssh-config my-dev
```

The command adds a managed entry to `~/.ssh/config`, using the CLI's dedicated
SSH key. It prints the exact alias, such as `driftverk-my-team.my-dev`, and
backs up existing SSH configuration before changes. Existing unrelated hosts
are preserved. Select the printed alias in Codex or T3 Code using the steps
below. The `driftverk-dev` alias used later in this guide is an example;
substitute your printed alias.

You can also use ordinary OpenSSH with this generated entry:

```bash
ssh driftverk-my-team.my-dev
```

For a direct shell or one remote command through the CLI:

```bash
driftverk ssh my-dev
driftverk ssh my-team/my-dev -- pwd
```

The CLI prepares the connection; your editor manages its own sessions.
A terminal Codex session started by `driftverk connect` is separate from a
Codex desktop or T3 Code thread.

## Connect with regular SSH

The Driftverk CLI is optional. Existing SSH commands and aliases continue to
work. You can create an environment in the [web panel](/environments/new),
register your own public key, and connect directly with OpenSSH or your editor.
Wait for repository setup to finish before opening the project.

### Add your SSH key

On your computer, use an existing SSH key pair or generate one:

```bash
ssh-keygen -t ed25519
```

Choose an unused filename if you already have a key. Keep the private key on your computer. Copy the contents of the matching `.pub` file into **Settings → SSH keys → Add public key** in Driftverk.

Open the environment's **Connect → Copy SSH command** action. This supplies the host, port and username, but assumes your local SSH client can find the matching private key.

### Save a local SSH alias

Add a block to `~/.ssh/config` on your computer. Replace the example username, host and port with the values from your environment's copied command. Set `IdentityFile` to your private key file, without `.pub`.

```sshconfig
Host driftverk-dev
  HostName ssh.app.driftverk.com
  Port 2222
  User YOUR_ORGANIZATION.YOUR_ENVIRONMENT
  IdentityFile ~/.ssh/id_ed25519
  IdentitiesOnly yes
```

Use a different alias for each environment. Test it from your computer:

```bash
ssh driftverk-dev
```

This opens a shell inside the environment, not on its underlying compute host. If this fails, fix SSH access before adding the connection to your app.

## Check tools and sign in

From your computer, check that the remote login shell can find the tools:

```bash
ssh driftverk-dev 'command -v codex && codex --version && node --version && git --version'
```

Use a Node.js version supported by your T3 Code release. Check its [installation requirements](https://github.com/pingdotgg/t3code/blob/main/docs/user/install.md#requirements) when updating.

If tools are missing, use Driftverk Dev for a new environment or install the missing tools in your custom image. Changing an image does not update an existing environment. Codex must be available on the remote login shell's `PATH`.

If guided CLI setup already verified your remote Codex login, you can skip this sign-in step. Otherwise, authenticate Codex inside the environment:

```bash
ssh -t driftverk-dev 'codex login --device-auth'
```

Open the printed link in your computer's browser and enter the one-time code. Device-code login must be enabled for your account or workspace. See [Codex authentication](https://learn.chatgpt.com/docs/auth#login-on-headless-devices) for alternatives.

Your computer's Codex login is not automatically inherited by the remote installation. Keep remote credentials personal. Do not bake them into an image or capture them in a reusable snapshot or prebuild.

## Connect the Codex desktop app

1. Open **Settings → Connections** in the local app.
2. Add or enable the `driftverk-dev` SSH host.
3. Select the repository folder inside the environment.
4. Start a chat in that remote project.

The app discovers concrete aliases in `~/.ssh/config` and starts the remote Codex app server through SSH. See the [official SSH connection guide](https://learn.chatgpt.com/docs/remote-connections#connect-to-an-ssh-host).

## Connect T3 Code

1. Open **Settings → Connections → Add environment** in T3 Code Desktop.
2. Choose **SSH** and enter `driftverk-dev`.
3. Wait for T3 Code to start or reuse its remote server and open the SSH tunnel.
4. Select the remote environment in **Settings → Providers** and enable Codex.
5. Open the remote repository and start a thread there.

The provider installation and credentials belong to the remote environment. You do not need to expose a T3 server through a Driftverk preview URL. See [T3 Code's SSH guide](https://github.com/pingdotgg/t3code/blob/main/docs/user/remote-access.md#desktop-managed-ssh).

## Verify where work runs

In your new remote chat, ask the agent to run:

```bash
pwd
hostname
git rev-parse --show-toplevel
```

Check that the paths identify your repository inside the environment. Then run the project's normal test command. A connected app alone does not prove that the intended repository and dependencies are ready.

## Reconnect and troubleshoot

- **Permission denied (publickey):** Check that `IdentityFile` exists locally and its matching public key is saved in your Driftverk account. Use the username from this environment's Connect menu.
- **SSH works, but the app cannot find Codex or Node:** Repeat the remote tool check above. Tools installed through a version manager may be missing from a non-interactive shell's `PATH`.
- **Codex asks you to sign in:** Authenticate inside the environment, even if your local app is already signed in.
- **Wrong files or local paths:** Select the remote connection and the repository folder inside it before starting the chat.
- **A long job stops:** A tmux session survives an SSH disconnect while the environment stays running. It does not prevent auto-stop. Ask an admin to adjust auto-stop for unattended work, then restore it afterwards.

Stopping preserves the environment's writable files but ends its processes. Reconnect through the app after restarting; do not assume an interrupted agent task resumes automatically. Deleting the environment removes its writable files. See [Lifecycle and storage](/docs/environments) and [Troubleshooting](/docs/troubleshooting).

## Update the CLI and manage your environment

Rerun the [installer for your platform](/docs/environments#connect-with-the-cli)
to update the local Driftverk CLI, then run `driftverk version`.

Your saved login and SSH key are preserved. If you installed into a custom
`DRIFTVERK_BIN_DIR`, use the same directory again. This updates the local
Driftverk command; it does not update Codex or other tools inside an existing
environment. There is currently no `driftverk update` command.

Useful commands while working:

```bash
driftverk ls
driftverk logs my-dev
driftverk preview my-dev --port 3000
driftverk stop my-dev
driftverk start my-dev
driftverk connect my-dev
```

Stopping and starting queue operations; use `driftverk ls` to check completion.
If you interrupt creation after submitting it, the environment may still exist.
Check the list and logs before retrying. See the [CLI command guide](/docs/environments#cli-commands)
for source options, member permissions, deletion, and noninteractive use.
