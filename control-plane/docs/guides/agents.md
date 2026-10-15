# Agents

Choose Codex or Claude Code and use your subscription or an organization API key.

## Use your subscription

For ChatGPT, open **Agents → Codex → Subscription → Connect ChatGPT**. Open the OpenAI link and enter the displayed code. Device-code login may need enabling in your ChatGPT security settings.

Your connection belongs to your Driftverk user. It becomes your default for new environments, across organizations. You can change that preference and the model under the connected account. Project setups store an agent choice, never a connection or credential; each person uses their own connection when creating an environment.

Driftverk encrypts the connection and refreshes it centrally. Codex requests a short-lived access token through a session grant scoped to the current environment, runtime, and user. Refresh tokens never enter the environment. The session grant lives in the environment's temporary memory filesystem and is excluded from filesystem snapshots. People with terminal access to the running environment can use its connection.

Disconnect stops subsequent token retrieval. Tokens already issued may remain valid until they expire. Reconnecting restores the connection for existing environments; reopen their agent pane. Reopen the pane after 24 hours to renew its session grant. Old environments that used terminal sign-in keep that flow; new ones use the connected account.

Claude subscription sign-in still takes place inside each environment. Choose **Set up Claude Code** and complete its login in the agent pane. That login remains on the environment's disk; sign out before sharing a snapshot.

## Connect an agent

1. Open **Agents** in the sidebar and expand Codex or Claude Code.
2. Choose **API key** and add an OpenAI or Anthropic API key. Only organization admins can change these settings.
3. Keep **Agent default** for the model, or enter a model ID available to your API key.
4. Optionally choose **Use as the organization default**, then save.

**Test connection** checks whether the provider accepts the saved key for listing models. It does not run a prompt or confirm that a particular model or sufficient credit is available.

API keys use your provider's API billing. Your personal ChatGPT default takes precedence over the organization's default.

## Start working

Create an environment and choose an agent. Your personal default, or otherwise the organization default, is selected initially; choose **None** to create it without adding an agent key. A blueprint can remember which agent to use.

After a successful creation, this browser remembers the repository, branch, agent, and sign-in method for your user and organization. Explicit agent links and blueprints take precedence. A saved default agent takes precedence over the browser’s last agent selection. Resources, commands, networking, variables, and volumes are available under **Advanced**.

Opening a configured environment opens its agent in the project's working directory. A stopped environment starts first. Explicit links to another tab keep that tab selected. Driftverk Dev includes both tools; custom images must provide the selected CLI.

Agent sessions use their own terminal session, separate from your regular shell. With tmux installed, closing the browser disconnects while the session remains in the running environment. Reopening the agent reconnects to that session. Stopping the environment ends its processes; opening it afterward starts a new agent process. New web agent sessions prevent auto-stop and automatic deletion for up to one hour, including time waiting for input or approval. Closing the browser does not release this protection. The environment shows its deadline; reopening the same session does not extend it. At the deadline the agent process ends. The normal auto-stop idle countdown then applies. An expired auto-delete policy can delete the environment immediately after protection ends, including its files. Manual Stop or Delete still ends the session, and compute stays billable while running.

The compute host checks that the session still exists every 15 seconds. Protection expires after 90 seconds without a host report, followed by the normal idle countdown for auto-stop. This prevents an unreachable host from pinning compute indefinitely. The agent also has a local timeout, so a control-plane outage cannot extend its session. This is lifecycle protection, not proof that an agent is making progress. Processes started independently through SSH are not automatically protected.

Open **Results** for retained tracked-command output, explicit exit status, cancellation and small artifact downloads. Interactive terminal conversations are not captured in that history. A successful command exit is not proof that tests passed or that the task is complete.

Connected ChatGPT accounts require the updated compute host, Python 3, and Codex 0.154.0 or newer. New Driftverk Dev image builds include these. Older published versions are unchanged. Older hosts refuse an agent connection rather than silently opening an ordinary shell.

## Credentials and existing environments

Agent keys reuse the organization's `OPENAI_API_KEY` or `ANTHROPIC_API_KEY` secret. They are encrypted in storage and never returned to the browser. Selecting an agent copies its key and model configuration into the new trusted environment. People with shell access to that environment can use its credentials.

Changes to API keys and model defaults affect new environments. Disconnecting an API key removes the saved organization key, including its use by other setups, but existing environments retain their copies. To stop all use of a compromised key, revoke it with the provider.

Codex sign-in can also write a local authentication cache. Do not capture credentials in reusable images, prebuilds, or snapshots. Choosing **None** does not remove files already contained in a selected snapshot. Review [environment variables](/docs/environment-variables) before sharing saved state.

## Default development setup

New environments use **Driftverk Dev** and resolve its published default to a pinned image. Older versions and custom images remain under **Advanced → Environment source**. Updating the default does not change existing environments. Use a project setup for repository-specific commands and settings.

Organization API keys cannot select a creator's personal ChatGPT connection. API automation should use organization provider keys; personal connections require an authenticated user.

## Browser tasks and recordings

With a current Driftverk Dev image, open the environment's **Desktop** tab to watch or
control the shared browser. From the CLI:

```sh
driftverk browser ENVIRONMENT
driftverk prompt ENVIRONMENT "Test checkout in the open browser" --record --output checkout.mp4
```

This first `prompt` implementation uses Codex's in-environment CLI login or API
credentials. It does not automatically use the managed ChatGPT connection from
the web agent pane. See [Browser and desktop](/docs/desktop) for setup, recording
recovery and attaching evidence to a PR.

A browser agent must attach to the existing Chromium session at
`http://127.0.0.1:9222` inside the environment. An agent that launches another
browser will not appear in the shared viewer. `driftverk prompt` supplies these
attachment instructions. For independently launched agents, supply them yourself
and keep a viewer connected to prevent desktop idle shutdown.

## Updating an existing installation

Apply migration `0051_agent_session_protection.sql` with the control plane, then update the complete Compute stack, including web-terminal. Older hosts cannot open new protected web agent sessions and show an update message. Protected sessions require `tmux` and `timeout` in the environment image. Finish existing unprotected agent sessions before updating; they are not adopted into the new protected sessions.
