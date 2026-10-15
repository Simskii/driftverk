# Browser, desktop and recordings

Open a browser inside an environment, watch an agent use it, and take control of the same desktop. Desktop support is included in new Driftverk Dev builds. Older images and existing environments require an image upgrade or recreation.

## Requirements

Use a running environment with a Driftverk Dev image containing desktop support. Enable **HTTP preview** in the environment's **Settings**. The CLI viewer commands also require SSH access; the web Desktop tab does not.

Check `driftverk browser --help`, `driftverk desktop --help` and `driftverk prompt --help` before using these commands. They require a CLI build containing desktop support. Updating the CLI alone does not install desktop software in an existing environment.

Driftverk Dev `2026.09.4` includes the desktop tools. Custom images must provide them separately. In the environment's Terminal, check:

```sh
command -v driftverk-browser driftverk-prompt
driftverk-browser status
```

`stopped` is normal before the first use. If the commands are missing, ask your workspace admin to create an environment from the current Dev image. Changing the default image or restarting an existing environment does not replace its installed software. Save and push your work before moving to a new environment; restoring an old snapshot also restores its older software.

To update your local CLI, rerun the installer in the [Quickstart](/docs/getting-started), then check `driftverk version`. Use `driftverk whoami` and `driftverk ls` to confirm the active organization and target environment. If you explicitly stopped the environment, run `driftverk start ENVIRONMENT` first and wait for it to be running.

For agent tasks, Codex must be installed inside the environment with a CLI login or API credentials. `driftverk connect ENVIRONMENT` can guide you through that login. The current `prompt` command uses the environment's Codex CLI credentials; it does not automatically use the managed account connection from the web agent tab.

API-key environments can use their configured `OPENAI_API_KEY`. The runner passes it to Codex as a per-run `CODEX_API_KEY` without rewriting saved login files. An explicitly configured `CODEX_API_KEY` takes precedence. See [Codex authentication for non-interactive runs](https://learn.chatgpt.com/docs/non-interactive-mode#authenticate-in-automation).

## Open the shared browser

```sh
driftverk browser ENVIRONMENT
```

This starts the desktop services if needed, opens or restores Chromium, and opens a private viewer link in your local browser. The environment can be selected by name or ID in the active organization.

To print the URL without opening your local browser:

```sh
driftverk browser ENVIRONMENT --no-browser
```

Inside remote Chromium, visit your application using its environment-local address, such as `http://localhost:3000`.

Start your application first using its startup command, Compose project, or Terminal. Opening the desktop starts Chromium, not your application. For an app inside nested Docker, publish its port to the environment so Chromium can reach it. The remote browser has its own cookies and logins; it does not inherit your local browser session.

`driftverk preview ENVIRONMENT --port 3000` opens the application in your own browser. `driftverk browser ENVIRONMENT` shows the browser running inside the environment, including the session used by the agent.

## Open the desktop

```sh
driftverk desktop ENVIRONMENT
```

This opens the full display and leaves the focused window as it is. It shares the same viewer and session as `browser`. Both commands support `--no-browser`.

In the web application, open the environment, select **Desktop** next to **Terminal**, and click **Open desktop**.

- The viewer starts in **View only** mode.
- **Take control** enables your mouse and keyboard. It does not pause an agent or lock out other viewers.
- **Release control** returns to view-only mode.
- **Reconnect** in the viewer reconnects the stream. **Reconnect** above the embedded viewer also obtains a fresh access link.
- **Open in new tab** provides more space and can help when your browser blocks embedded preview cookies.

After the last viewer disconnects, the desktop stops automatically after five minutes. Reconnecting cancels the countdown. Managed `driftverk prompt` tasks and their recordings keep it running, with a new five-minute grace period after completion. Starting without connecting a viewer also starts the countdown. Independently launched agents are not tracked; keep a viewer connected while they need the desktop.

Closing Chromium leaves the desktop available while viewers are connected; `driftverk browser ENVIRONMENT` opens Chromium again. Choose **Stop desktop** in the web tab or run:

```sh
driftverk desktop ENVIRONMENT --stop
```

Stopping shuts down Chromium and all desktop services while leaving the environment running. Finish or cancel an active managed prompt first so its recording can finalize. `driftverk browser ENVIRONMENT --stop` also works. Stop does not require HTTP preview access.

Desktop links expire after one hour. Anyone with the full link can access and control the desktop while the link is valid. Keep them out of repositories, public issues and PR descriptions.

## What survives shutdown

Stopping the desktop closes its browser windows and services. It preserves the Chromium profile, including cookies and sign-ins, in `~/.local/share/driftverk/browser`. Open processes and unsaved page state are not preserved. Stop the desktop before taking a snapshot so Chromium can flush its profile; snapshots can include those sign-ins.

The five-minute desktop timer is separate from the environment's auto-stop setting. Stopping the desktop leaves your app, shell sessions, and environment running, so compute charges can continue. Use `driftverk stop ENVIRONMENT` when you want to stop the whole environment. An open viewer sends network traffic even in view-only mode and can keep the environment awake. Close all viewer tabs when finished.

All viewers and agents share one display and browser profile. **Take control** only enables your own keyboard and mouse. Coordinate with anyone else using the environment, or use separate environments for independent tasks. Keep ports 5900 and 9222 private; the supported viewer is the authenticated preview on port 6080.

## Run an agent task

```sh
driftverk prompt ENVIRONMENT "Complete the checkout flow in the open browser window"
```

The first version runs Codex and supplies instructions to attach to the existing Chromium session. It starts the browser if necessary and streams the agent's output to your terminal. It does not open a viewer automatically; use `browser`, `desktop` or the web tab to watch.

The working directory defaults to the environment's configured workspace. Override it when needed:

```sh
driftverk prompt ENVIRONMENT "Test the checkout flow" --cwd /workspaces/shop
```

Codex uses workspace-write permissions with network access to reach the shared browser and application. Existing Codex configuration and repository instructions still apply. A run is limited to 30 minutes. Only one `prompt` run may use the desktop at a time; independently started agents and manual input are not paused.

## Record a task

```sh
driftverk prompt ENVIRONMENT \
  "Complete the checkout flow in the open browser window" \
  --record --output checkout.mp4
```

The runner starts recording before launching Codex. It captures the full desktop as a 1440×900, 15 fps H.264 MP4 without audio. If recording cannot start, the agent is not launched.

`--output` selects the local file and requires `--record`. Without `--output`, the filename is `driftverk-RUN_ID.mp4`. Existing files are never overwritten. Without `--record`, no video is captured.

The runner finalizes the video after success, an agent error, or Ctrl+C. A heartbeat also detects a disconnected CLI and stops its task. Abrupt container shutdown or disk failure may prevent a complete recording. An agent failure remains a failed command even when its recording downloads successfully.

Closing the viewer does not cancel a managed prompt. Closing the terminal or losing the SSH connection running `driftverk prompt` does cancel it. Keep that CLI session connected until completion. This differs from a persistent agent terminal or an API execution that can continue after its client disconnects.

The remote run directory is `~/.local/share/driftverk/runs/RUN_ID/`. It contains the video, completion status, recorder logs and the agent's final response when available. These files persist until removed or the environment is deleted; there is no automatic recording-retention policy.

Recordings include everything visible on the shared display, including manual input and other agents' actions. Downloads are saved on the computer running the CLI, relative to its current directory unless `--output` is an absolute path. Keep enough free space there and in the environment. After verifying a downloaded copy, remove remote runs you no longer need to reclaim environment storage.

## Recover a recording

If the local download fails, the CLI prints the run ID and remote location. Reconnect and choose a new local filename:

```sh
driftverk ssh ENVIRONMENT -- driftverk-prompt export RUN_ID > recovered.mp4
```

Shell redirection can overwrite a local file, so use an unused filename. The export waits briefly for an interrupted run to finish finalizing its video. It fails if there is no completed recording.

## Add evidence to a pull request

Recording does not create or update a PR automatically. Use your review workflow or the [CLI skill](/docs/cli-skill) to attach the MP4 to the intended PR when requested.

Verify the repository, branch and commit being demonstrated before attaching evidence. Describe the flow tested and its result. If the relevant code changes afterward, record the updated flow again. A video is evidence of that observed session; it is not a reproducible test or proof that every checkout case passes.

Upload the MP4 through GitHub's supported attachment tooling rather than linking to the temporary desktop preview. Review the recording for credentials or other sensitive screen content before sharing it.

## Troubleshooting

**Desktop tooling is not installed:** use a desktop-enabled environment image. A CLI update does not modify your environment image.

**An execution is already active:** wait for the current environment execution to finish, then open the desktop again. Desktop startup uses the same execution service.

**The embedded viewer is blank:** try **Open in new tab**. Browser privacy settings can block embedded preview authentication. If the link expired, use **Reconnect** above the viewer.

**Chromium was closed or minimized:** run `driftverk browser ENVIRONMENT` to reopen or restore it.

**The viewer disconnected after you left:** the desktop may have reached its idle timeout. Use **Open desktop** or run `driftverk desktop ENVIRONMENT` again. The viewer's own Reconnect button cannot restart stopped services.

**Stop desktop is refused:** finish the managed prompt or press Ctrl+C in its CLI terminal, allow its recording to finalize, then retry. Stopping the entire environment bypasses this protection and may interrupt the video.

**The desktop cannot start:** check `/tmp/driftverk-browser-*/browser.log` in Terminal. Another application using port 6080, 5900, 9222 or display `:99` prevents startup; Driftverk does not kill the conflicting service.

**Codex is not signed in:** run `driftverk connect ENVIRONMENT` and complete its login. A connected account in the web agent tab is a separate authentication path.

**A recording is missing:** inspect `status.json` and `recorder.log` in the printed run directory. Do not claim a recording was saved or attached unless the file or PR attachment was verified.
