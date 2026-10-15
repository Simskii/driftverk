# Shared desktop in Driftverk Dev

The Dev image includes Chromium, Xvfb, Openbox, x11vnc, noVNC, Websockify and
FFmpeg. Desktop processes start on demand. There is no separate browser image.
Older images and existing environments need an upgrade or recreation.

```sh
docker build -t driftverk-dev:desktop-test images/dev
docker run -d --name driftverk-desktop --cpus=2 --memory=2g --shm-size=256m \
  -p 127.0.0.1:6080:6080 driftverk-dev:desktop-test
docker exec driftverk-desktop driftverk-browser start
```

Open <http://127.0.0.1:6080>. Choose **Take control** or run
`docker exec driftverk-desktop driftverk-browser-demo` for simulated agent input.

The supervisor stops all desktop services five minutes after the last viewer
disconnects. Reconnecting resets the timer. A desktop without any viewers also
expires. Managed prompts hold a lock until their agent and recording finish,
then get a fresh five-minute grace period. Independently launched agents are
not tracked; keep a viewer connected while using them.

Use **Stop desktop** or `driftverk desktop ENV --stop` to stop immediately.
`driftverk browser ENV --stop` also works. Finish or cancel an active managed
prompt first. The low-level command is `driftverk-browser stop`.

The profile persists in `~/.local/share/driftverk/browser`, including login state.
Stop the desktop before snapshotting to flush changes. Container stop/resume
does not preserve running processes. Chromium closing leaves the desktop usable;
`driftverk-browser focus` reopens it.

Only port 6080 binds to the environment network. Use the private preview gateway;
the viewer has no separate login. VNC and CDP use loopback ports 5900 and 9222.
Chromium uses `--no-sandbox` and relies on environment isolation. Local Docker
tests do not prove production Sysbox or Hybrid compatibility.

See [the desktop guide](../../../control-plane/docs/guides/desktop.md) for commands,
credentials, recordings and PR evidence. Agents must attach to the existing CDP
endpoint at `http://127.0.0.1:9222`. There is no audio, WebRTC or automatic PR upload.

## Verify

```sh
npm ci --prefix infrastructure/compute-agent
python3 images/dev/desktop/smoke.py
python3 images/dev/desktop/idle_smoke.py
python3 images/dev/desktop/recording_smoke.py
```

Tests use disposable containers and `driftverk-dev:desktop-test`, overridable
with `DRIFTVERK_TEST_IMAGE`. Idle tests shorten the grace period using
`DRIFTVERK_DESKTOP_IDLE_SECONDS`; the default is 300 seconds. Gateway tests use
fixture authorization and mount the Docker socket only into the gateway fixture.
