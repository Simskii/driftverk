# Driftverk CLI

Native Go client for the Driftverk control plane, with system OpenSSH for terminal
connections. It replaces the Python CLI and preserves its commands, device login,
creation review, repository/branch detection, member limits, SSH configuration,
and guided agent connection.

## Install

macOS and Linux, Intel/AMD 64-bit or ARM64:

```sh
curl -fsSL https://app.driftverk.com/install/cli | sh
```

Windows, Intel/AMD 64-bit or ARM64, in PowerShell:

```powershell
irm https://app.driftverk.com/install/cli.ps1 | iex
```

Then run `driftverk create`. Run the installer again to update. No Python, Go
installation, or WSL is needed. `ssh` and `ssh-keygen` must be installed for setup
and connections. Windows users can enable the OpenSSH Client optional feature.
Git is optional; it is used to detect the current repository and its remote branch.
Unix installation requires curl and either sha256sum or shasum.

The Unix installer defaults to `/usr/local/bin` and uses sudo when needed. Set
`DRIFTVERK_BIN_DIR` to use a writable directory already on PATH. Windows installs
under `%LOCALAPPDATA%\Driftverk\bin` and adds it to the user and current shell PATH.
Both installers verify the binary against its SHA-256 checksum before replacing
an existing installation. Downloads are served by the control-plane deployment.

## Compatibility

| Target | Architectures | Connection dependency |
| --- | --- | --- |
| macOS | amd64, arm64 | OpenSSH client |
| Linux | amd64, arm64 | OpenSSH client |
| Windows | amd64, arm64 | Windows OpenSSH Client |

The release build produces all six targets with `CGO_ENABLED=0`. CI runs Go tests
and a native version smoke test on macOS, Linux and Windows. Cross-compilation and
mock API tests do not prove real device login, terminal behavior, credential-store
access, or production SSH. Before releasing a new platform, run install → login →
create → connect → disconnect/reconnect → logout on that OS, including a user
profile path with spaces. Check the installer update path as well.

### Existing credentials

On macOS/Linux, configuration stays in `$XDG_CONFIG_HOME/driftverk` or
`~/.config/driftverk`. Windows reuses that legacy directory if it exists; otherwise
it uses `%APPDATA%\driftverk`. The CLI preserves the origin-hashed `.token` filename
and `id_ed25519` private key. It derives the public key from the private key before
registering it and refuses to overwrite an orphan public key.

Tokens use the OS credential store when available, with a private file fallback.
The service name remains `driftverk-cli`; the account is the control-plane origin.
An existing token file takes precedence, so an unavailable credential store cannot
cause a newer login to be shadowed by an older token. An empty file can represent
logout when the credential store is unavailable. Windows files use a DACL limited
to the current user; Unix uses directory mode 0700 and file mode 0600.

## Development

```sh
cd cli
go test -race ./...
go vet ./...
go run . help
```

From the repository root, `sh cli/build.sh` writes binaries and individual
checksums under `control-plane/installer/bin/`. Artifacts are ignored by Git.
The control-plane Dockerfile builds these artifacts and includes them in the
runtime image, so `/install/bin/<filename>` works after deploying that image.
The `.github/workflows/cli.yml` workflow also uploads them as CI artifacts.

`DRIFTVERK_CONTROL_PLANE_URL` selects a different API origin. HTTPS is required,
except for localhost and 127.0.0.1 development. `DRIFTVERK_SSH_HOST` and
`DRIFTVERK_SSH_PORT` override the SSH gateway, which defaults to
`ssh.app.driftverk.com:2222`.

The installers and landing-page commands require the new control-plane image to
be deployed first. They are not made live by a source change or local build.

## AI skill

Run `driftverk skill install` to install the bundled skill into
`~/.agents/skills/driftverk-cli/SKILL.md`, without login or network access.
Use `--agent claude` for `~/.claude/skills/driftverk-cli/SKILL.md`, or
`--path <skills-directory>` for a project or another agent. The command
leaves identical files alone and refuses to overwrite different contents.

The docs download and CLI embed both use `skills/driftverk-cli/SKILL.md`.

## Browser, desktop and recordings

With a new Driftverk Dev image containing desktop support:

```sh
driftverk browser my-environment
driftverk desktop my-environment
driftverk prompt my-environment "Test checkout in the open browser" --record --output checkout.mp4
```

The viewers share the environment's desktop over the private preview gateway.
The web environment page also has a Desktop tab. `prompt` currently uses Codex's
in-environment CLI credentials, and records only when `--record` is supplied.
The CLI refuses to overwrite a local output file and attempts to download a
finalized video even after task failure or Ctrl+C.

See [the desktop guide](../control-plane/docs/guides/desktop.md) for requirements,
flags, recovery and PR evidence. [Driftverk Dev](../images/dev/desktop/README.md)
contains the desktop services and recording helper. After the last viewer leaves,
the desktop stops after five minutes unless a managed prompt or recording is active.
Use `driftverk desktop my-environment --stop` to stop immediately after tasks finish.
