#!/usr/bin/env python3
"""On-demand, single-session browser. Preview gateway authenticates port 6080."""
import fcntl
import json
import os
from pathlib import Path
import signal
import socket
import subprocess
import sys
import time
import urllib.request

STATE = Path(f"/tmp/driftverk-browser-{os.getuid()}")
PROFILE = Path.home() / ".local/share/driftverk/browser"
VIEWER = "/opt/driftverk-browser/viewer"
DISPLAY = ":99"
IDLE_SECONDS = int(os.environ.get("DRIFTVERK_DESKTOP_IDLE_SECONDS", "300"))


def prompt_lock(timeout=0):
    root = Path.home() / ".local/share/driftverk/runs"
    root.mkdir(parents=True, exist_ok=True, mode=0o700)
    lock = (root / "lock").open("a")
    deadline = time.monotonic() + timeout
    while True:
        try:
            fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
            return lock
        except BlockingIOError:
            if time.monotonic() >= deadline:
                lock.close()
                return None
            time.sleep(min(0.05, max(0, deadline - time.monotonic())))


def viewers_connected():
    # Count established connections at the VNC server, including all noVNC tabs.
    # Read errors fail open: uncertainty must not shut down someone's session.
    try:
        for table in ("tcp", "tcp6"):
            path = Path(f"/proc/net/{table}")
            if table == "tcp6" and not path.exists():
                continue
            for line in path.read_text().splitlines()[1:]:
                fields = line.split()
                if fields[1].split(":")[1] == "170C" and fields[3] == "01":
                    return True
        return False
    except OSError:
        return True


def process_identity(pid):
    try:
        # starttime prevents a persisted PID from targeting a different process.
        return Path(f"/proc/{pid}/stat").read_text().rsplit(")", 1)[1].split()[19]
    except (OSError, IndexError):
        return None


def running_pid():
    try:
        saved = json.loads((STATE / "pid.json").read_text())
        pid = saved["pid"]
        if process_identity(pid) == saved["started"] and os.getpgid(pid) == pid:
            return pid
    except (OSError, ValueError, KeyError):
        pass
    return None


def port_open(port):
    try:
        with socket.create_connection(("127.0.0.1", port), timeout=0.3):
            return True
    except OSError:
        return False


def ready():
    try:
        with urllib.request.urlopen("http://127.0.0.1:6080/ready.json", timeout=1) as response:
            return json.load(response) == {"service": "driftverk-browser"} and port_open(5900)
    except (OSError, ValueError):
        return False


def wait_for(check, children, seconds=20):
    deadline = time.monotonic() + seconds
    while time.monotonic() < deadline:
        if any(child.poll() is not None for child in children):
            raise RuntimeError("A browser service exited. Check /tmp/driftverk-browser-*/browser.log")
        if check():
            return
        time.sleep(0.2)
    raise RuntimeError("Browser startup timed out. Check /tmp/driftverk-browser-*/browser.log")


def serve():
    children = []
    chrome = None
    stopping = False
    reopen_browser = False
    shutdown_lock = None
    shutdown_state_lock = None
    last_used = time.monotonic()

    def touch(_signal, _frame):
        nonlocal last_used
        last_used = time.monotonic()

    def reopen(_signal, _frame):
        nonlocal reopen_browser
        reopen_browser = True

    def stop(_signal, _frame):
        nonlocal stopping
        stopping = True
        raise InterruptedError()

    signal.signal(signal.SIGTERM, stop)
    signal.signal(signal.SIGINT, stop)
    signal.signal(signal.SIGUSR1, reopen)
    signal.signal(signal.SIGUSR2, touch)
    env = {**os.environ, "DISPLAY": DISPLAY}

    def launch(args):
        child = subprocess.Popen(args, env=env, stdin=subprocess.DEVNULL)
        children.append(child)
        return child

    try:
        (STATE / "pid.json").write_text(json.dumps({"pid": os.getpid(), "started": process_identity(os.getpid())}))
        PROFILE.mkdir(parents=True, exist_ok=True, mode=0o700)
        # A stopped container or filesystem snapshot may retain Chromium's locks.
        # Only this supervisor uses this dedicated profile; startup is serialized.
        for name in ("SingletonLock", "SingletonCookie", "SingletonSocket"):
            (PROFILE / name).unlink(missing_ok=True)
        launch(["Xvfb", DISPLAY, "-screen", "0", "1440x900x24", "-nolisten", "tcp"])
        wait_for(lambda: subprocess.run(["xdpyinfo", "-display", DISPLAY], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL).returncode == 0, children)
        launch(["openbox"])
        def launch_browser():
            return launch(["chromium", "--no-sandbox", "--disable-dev-shm-usage", "--no-first-run", "--no-default-browser-check",
                f"--user-data-dir={PROFILE}", "--remote-debugging-address=127.0.0.1", "--remote-debugging-port=9222",
                "--window-size=1440,900", "--start-maximized", f"file://{VIEWER}/welcome.html"])
        chrome = launch_browser()
        wait_for(lambda: port_open(9222), children)
        launch(["x11vnc", "-display", DISPLAY, "-localhost", "-rfbport", "5900", "-forever", "-shared", "-nopw", "-noxdamage", "-quiet"])
        wait_for(lambda: port_open(5900), children)
        launch(["websockify", "--heartbeat", "15", "--web", VIEWER, "6080", "127.0.0.1:5900"])
        wait_for(ready, children)
        last_used = time.monotonic()
        while not stopping:
            # Closing Chromium leaves the desktop usable. A later browser/focus
            # command reopens it in this supervisor's process group.
            if chrome is not None and chrome.poll() is not None:
                print(f"Chromium exited ({chrome.returncode}); desktop remains available.", flush=True)
                children.remove(chrome)
                chrome = None
            if reopen_browser:
                if chrome is None:
                    chrome = launch_browser()
                reopen_browser = False
            for child in children:
                if child is not chrome and child.poll() is not None:
                    raise RuntimeError(f"Desktop service {child.args[0]} exited ({child.returncode}); stopping the session.")
            idle_lock = prompt_lock()
            if viewers_connected() or idle_lock is None:
                last_used = time.monotonic()
            elif time.monotonic() - last_used >= IDLE_SECONDS:
                # Hold the task lock through cleanup, so a new prompt cannot
                # begin recording while its display is being torn down.
                state_lock = (STATE / "lock").open("a")
                try:
                    fcntl.flock(state_lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
                except BlockingIOError:
                    state_lock.close()
                else:
                    if not viewers_connected() and time.monotonic() - last_used >= IDLE_SECONDS:
                        shutdown_lock = idle_lock
                        shutdown_state_lock = state_lock
                        print("Desktop idle timeout; stopping all desktop services.", flush=True)
                        break
                    state_lock.close()
            if idle_lock is not None:
                idle_lock.close()
            time.sleep(0.5)
    except InterruptedError:
        pass
    finally:
        signal.signal(signal.SIGTERM, signal.SIG_IGN)
        signal.signal(signal.SIGINT, signal.SIG_IGN)
        # Let Chromium flush its profile while its renderers/display are alive.
        # Killing the whole group first can lose recently written browser state.
        if chrome is not None and chrome.poll() is None:
            chrome.terminate()
            try:
                chrome.wait(timeout=8)
            except subprocess.TimeoutExpired:
                pass
        # Include Chromium descendants, not just the immediate child processes.
        os.killpg(os.getpid(), signal.SIGTERM)
        for child in reversed(children):
            try:
                child.wait(timeout=5)
            except subprocess.TimeoutExpired:
                child.kill()
                child.wait()
        (STATE / "pid.json").unlink(missing_ok=True)
        if shutdown_lock is not None:
            shutdown_lock.close()
        if shutdown_state_lock is not None:
            shutdown_state_lock.close()


def main():
    os.umask(0o077)
    STATE.mkdir(parents=True, exist_ok=True, mode=0o700)
    action = sys.argv[1] if len(sys.argv) == 2 else "help"
    if action == "_serve":
        serve()
        return
    if action not in ("start", "focus", "stop", "status"):
        sys.exit("Usage: driftverk-browser start|focus|stop|status")
    with (STATE / "lock").open("w") as lock:
        fcntl.flock(lock, fcntl.LOCK_EX)
        pid = running_pid()
        if action == "status":
            print("running" if pid and ready() else "stopped")
            return
        if action == "stop":
            # The idle monitor briefly holds this lock too. Give that check
            # time to finish, while keeping active tasks protected.
            task_lock = prompt_lock(timeout=1)
            if task_lock is None:
                sys.exit("A prompt or recording is active. Finish it or cancel it with Ctrl+C before stopping the desktop.")
            if pid:
                os.kill(pid, signal.SIGTERM)
                deadline = time.monotonic() + 15
                while running_pid() and time.monotonic() < deadline:
                    time.sleep(0.2)
                if running_pid():
                    raise RuntimeError("Browser is still stopping; inspect browser.log before retrying.")
            print("Browser stopped. Its profile is retained.")
            task_lock.close()
            return
        if not pid:
            if any(port_open(port) for port in (6080, 5900, 9222)):
                raise RuntimeError("Port 6080, 5900 or 9222 is already in use. No services were changed.")
            if subprocess.run(["xdpyinfo", "-display", DISPLAY], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL).returncode == 0:
                raise RuntimeError("Display :99 is already in use. No services were changed.")
            with (STATE / "browser.log").open("w") as log:
                process = subprocess.Popen([sys.executable, str(Path(__file__).resolve()), "_serve"],
                                           stdin=subprocess.DEVNULL, stdout=log, stderr=log, start_new_session=True)
            try:
                wait_for(lambda: running_pid() and ready(), [process], seconds=40)
            except Exception:
                if process.poll() is None:
                    os.kill(process.pid, signal.SIGTERM)
                    process.wait(timeout=15)
                raise
        elif not ready():
            raise RuntimeError("Browser is not ready. Run driftverk-browser stop, then start.")
        os.kill(running_pid(), signal.SIGUSR2)
        if action == "focus":
            if not port_open(9222):
                os.kill(running_pid(), signal.SIGUSR1)
                wait_for(lambda: port_open(9222), [], seconds=20)
            windows = subprocess.check_output(["wmctrl", "-lx"], env={**os.environ, "DISPLAY": DISPLAY}, text=True)
            for window in windows.splitlines():
                if "chromium" in window.lower():
                    subprocess.run(["wmctrl", "-ia", window.split()[0]], env={**os.environ, "DISPLAY": DISPLAY}, check=True)
                    break
        print("Desktop ready. Open private preview port 6080. Use driftverk-browser focus to open Chromium.")


if __name__ == "__main__":
    try:
        main()
    except (RuntimeError, OSError) as error:
        sys.exit(str(error))
