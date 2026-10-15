#!/usr/bin/env python3
"""One supervised Codex task and optional desktop recording. Runs in the environment."""
import base64
import fcntl
import json
import os
from pathlib import Path
import re
import shutil
import signal
import select
import subprocess
import sys
import time

ROOT = Path.home() / ".local/share/driftverk/runs"
BROWSER_INSTRUCTIONS = """You share the existing Chromium browser with the user. Use its CDP endpoint
http://127.0.0.1:9222. Do not launch a separate or headless browser, close Chromium,
or stop the desktop. DISPLAY=:99. Node has a built-in WebSocket client: fetch
/json/list from the CDP endpoint, connect to a page's webSocketDebuggerUrl and send
CDP JSON messages with incrementing id, method and params. Use Page.bringToFront,
Runtime.evaluate, Input.dispatchMouseEvent, Input.insertText and Page.captureScreenshot
as needed. If Playwright is available, chromium.connectOverCDP attaches to this same
session. Use the existing context and pages. Respect repository instructions.
The runner manages recording; do not start or stop recorders yourself.
"""


def run_directory(identifier):
    if not re.fullmatch(r"[a-f0-9]{48}", identifier):
        raise ValueError("Invalid run ID")
    return ROOT / identifier


def finish_process(process, sig, seconds=10):
    if process is None:
        return
    try:
        os.killpg(process.pid, sig)
    except ProcessLookupError:
        pass
    try:
        process.wait(timeout=seconds)
    except subprocess.TimeoutExpired:
        os.killpg(process.pid, signal.SIGKILL)
        process.wait()


def export(identifier):
    directory = run_directory(identifier)
    if not directory.is_dir():
        raise RuntimeError("Run did not start; no recording is available")
    deadline = time.monotonic() + 35
    while not (directory / "status.json").exists() and time.monotonic() < deadline:
        time.sleep(.2)
    status = json.loads((directory / "status.json").read_text())
    if not status.get("recording"):
        raise RuntimeError("No completed recording for this run")
    with (directory / "recording.mp4").open("rb") as source:
        shutil.copyfileobj(source, sys.stdout.buffer)


def run(payload):
    request = json.loads(base64.b64decode(payload, validate=True))
    directory = run_directory(request["id"])
    prompt, cwd, record = request["prompt"], request["cwd"], request["record"]
    if not isinstance(prompt, str) or not prompt.strip() or len(prompt.encode()) > 8000 or "\0" in prompt:
        raise ValueError("Invalid prompt")
    if not isinstance(cwd, str) or not Path(cwd).is_absolute() or not Path(cwd).is_dir() or type(record) is not bool:
        raise ValueError("Invalid working directory or recording option")
    for command in ["codex", "driftverk-browser"] + (["ffmpeg"] if record else []):
        if not shutil.which(command):
            raise RuntimeError(f"{command} is not installed in this environment")
    ROOT.mkdir(parents=True, exist_ok=True, mode=0o700)
    with (ROOT / "lock").open("w") as lock:
        # The desktop idle monitor also holds this lock briefly. A prompt
        # should tolerate that check, but not wait indefinitely for another run.
        deadline = time.monotonic() + 1
        while True:
            try:
                fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
                break
            except BlockingIOError:
                if time.monotonic() >= deadline:
                    raise RuntimeError("Another prompt is using this desktop. Wait for it to finish.")
                time.sleep(min(0.05, max(0, deadline - time.monotonic())))
        directory.mkdir(mode=0o700)
        supervise(directory, prompt, cwd, record, request.get("heartbeat", False))


def supervise(directory, prompt, cwd, record, heartbeat):
    agent = recorder = None
    status = {"exit_code": 1, "recording": False}
    started = time.time()
    last_heartbeat = time.monotonic()

    def check_client():
        nonlocal last_heartbeat
        if not heartbeat:
            return
        readable, _, _ = select.select([sys.stdin], [], [], 0)
        if readable:
            if not os.read(sys.stdin.fileno(), 4096):
                status["exit_code"] = 130
                raise InterruptedError("Client disconnected")
            last_heartbeat = time.monotonic()
        if time.monotonic() - last_heartbeat > 15:
            status["exit_code"] = 130
            raise InterruptedError("Client heartbeat timed out")

    def interrupted(sig, _frame):
        status["exit_code"] = 128 + sig
        raise InterruptedError(f"Run interrupted by signal {sig}")

    for sig in (signal.SIGINT, signal.SIGTERM, signal.SIGHUP):
        signal.signal(sig, interrupted)
    try:
        subprocess.run(["driftverk-browser", "focus"], check=True)
        check_client()
        # Keep ffmpeg's logs away from the terminal; it must not consume SSH input.
        if record:
            with (directory / "recorder.log").open("w") as log:
                recorder = subprocess.Popen(["ffmpeg", "-hide_banner", "-loglevel", "error", "-nostdin",
                    "-f", "x11grab", "-framerate", "15", "-video_size", "1440x900", "-i", ":99",
                    "-an", "-c:v", "libx264", "-preset", "ultrafast", "-crf", "28", "-pix_fmt", "yuv420p",
                    "-movflags", "+faststart", "-progress", str(directory / "progress"),
                    str(directory / "recording.mp4")], stdin=subprocess.DEVNULL, stdout=log, stderr=log, start_new_session=True)
            deadline = time.monotonic() + 10
            while True:
                check_client()
                if recorder.poll() is not None:
                    raise RuntimeError("Recording could not start. Check recorder.log in the run directory.")
                progress = directory / "progress"
                if progress.exists() and re.search(r"frame=[1-9]\d*", progress.read_text()):
                    break
                if time.monotonic() > deadline:
                    raise RuntimeError("Recorder startup timed out; agent was not started")
                time.sleep(.1)
        agent_environment = {**os.environ, "DISPLAY": ":99"}
        # Codex exec accepts a per-invocation API key without rewriting login files.
        if agent_environment.get("OPENAI_API_KEY"):
            agent_environment.setdefault("CODEX_API_KEY", agent_environment["OPENAI_API_KEY"])
        agent = subprocess.Popen(["codex", "exec", "--sandbox", "workspace-write",
            "-c", "sandbox_workspace_write.network_access=true", "--skip-git-repo-check",
            "--cd", cwd, "--output-last-message", str(directory / "result.txt"),
            BROWSER_INSTRUCTIONS + "\nUser task:\n" + prompt], stdin=subprocess.DEVNULL,
            env=agent_environment, start_new_session=True)
        deadline = time.monotonic() + 1800
        while agent.poll() is None:
            check_client()
            if recorder is not None and recorder.poll() is not None:
                raise RuntimeError("Recording stopped unexpectedly; stopping the agent")
            if time.monotonic() > deadline:
                status["exit_code"] = 124
                raise RuntimeError("Run reached its 30-minute limit")
            time.sleep(.2)
        status["exit_code"] = agent.returncode
    except (InterruptedError, RuntimeError, OSError, subprocess.SubprocessError) as error:
        status["error"] = str(error)
        try:
            print(str(error), file=sys.stderr, flush=True)
        except OSError:
            pass
    finally:
        for sig in (signal.SIGINT, signal.SIGTERM, signal.SIGHUP):
            signal.signal(sig, signal.SIG_IGN)
        finish_process(agent, signal.SIGTERM, 5)
        finish_process(recorder, signal.SIGINT, 15)
        video = directory / "recording.mp4"
        status["recording"] = recorder is not None and recorder.returncode in (0, 255) and video.exists() and video.stat().st_size > 0
        if record and not status["recording"] and status["exit_code"] == 0:
            status["exit_code"] = 1
        status.update(started_at=started, finished_at=time.time(), cwd=cwd)
        temporary = directory / "status.next"
        temporary.write_text(json.dumps(status))
        temporary.replace(directory / "status.json")
    sys.exit(status["exit_code"])


if __name__ == "__main__":
    os.umask(0o077)
    try:
        if len(sys.argv) != 3 or sys.argv[1] not in ("run", "export"):
            raise ValueError("Usage: driftverk-prompt run <base64-json> | export <run-id>")
        if sys.argv[1] == "export":
            export(sys.argv[2])
        else:
            run(sys.argv[2])
    except (ValueError, KeyError, TypeError, OSError, RuntimeError) as error:
        sys.exit(str(error))
