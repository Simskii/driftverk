# AI skill

Give your AI agent instructions for using the Driftverk CLI. The skill covers creating environments, running commands over SSH, checking logs, opening previews, controlling shared desktops, recording agent tasks and cleaning up.

## Install with the CLI

After [installing the CLI](/docs/getting-started#start-from-your-terminal), run:

```sh
driftverk skill install
```

This installs `driftverk-cli/SKILL.md` into your home directory's `.agents/skills` folder, a [user skill location supported by Codex](https://learn.chatgpt.com/docs/build-skills). For Claude Code, run:

```sh
driftverk skill install --agent claude
```

This uses `~/.claude/skills/driftverk-cli/SKILL.md`, Claude Code's [personal skills directory](https://code.claude.com/docs/en/skills#choose-where-skills-load). Both locations are under your user home directory and make the skill available across projects on this computer.

Installation works offline and does not require a Driftverk account or change your agent's settings.

For a project-local installation, run this from your project root:

```sh
driftverk skill install --path .agents/skills
```

For another agent, pass its supported skills directory with `--path`. The command creates a `driftverk-cli` folder inside that directory. Existing identical files are left alone; a different file is preserved and the command explains where it is. To compare a newer bundled version with your edits, install it into a separate directory.

If your CLI does not recognize `skill`, run the CLI installer again to update it.

## Download the skill

[Download SKILL.md](/docs/skills/driftverk-cli/SKILL.md)

Save the file inside a folder named `driftverk-cli` in your agent's skills directory. This is the same skill bundled with the CLI in this release. You can read and adapt it before installing.

## Try it

In Claude Code, type `/driftverk-cli` followed by your request.

In Codex, select the skill by typing `$driftverk-cli`, then ask:

```text
Use $driftverk-cli to list my Driftverk environments and inspect the logs for my development environment.
```

Or, when you want to create an environment:

```text
Use $driftverk-cli to create an environment for owner/repository on branch main, run its tests, and show me the results.
```

For browser testing with evidence:

```text
Use $driftverk-cli to record a checkout test in my desktop-enabled shop environment and save checkout.mp4. Report the result and the commit tested.
```

The skill covers `browser`, `desktop` and `prompt --record`, including recovery
when a video download fails. Recording requires a desktop-enabled environment
image and an authenticated Codex CLI inside it. It does not attach a recording to
a PR automatically; request that separately when needed. See [Browser and
desktop](/docs/desktop) for commands and setup requirements.

Your agent needs terminal access and the Driftverk CLI on its PATH. First-time login requires you to approve access in your browser. The skill supplies instructions; it does not grant account access. Creation and starting environments use your organization's compute and may incur charges.

If the skill does not appear, restart your agent. For clients that connect through tools instead of a terminal, see [MCP](/docs/mcp).
