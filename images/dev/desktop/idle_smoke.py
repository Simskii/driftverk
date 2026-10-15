#!/usr/bin/env python3
"""Short real noVNC connections exercise last-viewer idle shutdown."""
import os
import subprocess
import time
import uuid

name = "driftverk-idle-" + uuid.uuid4().hex[:10]
image = os.environ.get("DRIFTVERK_TEST_IMAGE", "driftverk-dev:desktop-test")


def docker(*args):
    return subprocess.check_output(["docker", *args], text=True, timeout=90)


def execute(*args):
    return docker("exec", name, *args)


def stopped():
    for _ in range(80):
        if execute("driftverk-browser", "status").strip() == "stopped":
            break
        time.sleep(.25)
    else:
        raise AssertionError("idle desktop did not stop")
    # status may become false during teardown; wait for supervisor completion.
    for _ in range(80):
        if execute("sh", "-c", "test -f /tmp/driftverk-browser-0/pid.json && echo alive || true").strip() == "":
            break
        time.sleep(.25)
    listeners = execute("ss", "-lnt")
    assert all(f":{port} " not in listeners for port in (5900, 6080, 9222)), listeners
    assert execute("sh", "-c", "pgrep -x 'Xvfb|openbox|x11vnc|chromium|ffmpeg' || true").strip() == ""


def viewer(seconds):
    # WebSocket upgrade creates a real websockify -> VNC connection. Read the
    # banner so this cannot pass with an unopened TCP socket.
    script = f"""
const ws = new WebSocket('ws://127.0.0.1:6080/websockify', ['binary']);
const timer = setTimeout(() => process.exit(1), 5000);
ws.addEventListener('message', () => {{
  clearTimeout(timer);
  console.log('connected');
  setTimeout(() => ws.close(), {seconds * 1000});
}}, {{once:true}});
ws.addEventListener('error', () => process.exit(1));
"""
    process = subprocess.Popen(["docker", "exec", name, "node", "-e", script], stdout=subprocess.PIPE, text=True)
    assert process.stdout.readline().strip() == "connected"
    return process


docker("run", "-d", "--name", name, "-e", "DRIFTVERK_DESKTOP_IDLE_SECONDS=5", image)
try:
    execute("driftverk-browser", "start")
    stopped()
    print("PASS never-connected desktop stops and releases all listeners", flush=True)
    execute("driftverk-browser", "start")
    first = viewer(3)
    second = viewer(9)
    first.wait(timeout=10)
    time.sleep(3)
    assert execute("driftverk-browser", "status").strip() == "running"
    second.wait(timeout=10)
    time.sleep(2)
    reconnect = viewer(7)
    time.sleep(5)
    assert execute("driftverk-browser", "status").strip() == "running"
    reconnect.wait(timeout=10)
    stopped()
    print("PASS last-viewer disconnect, reconnect reset, and full service cleanup", flush=True)
finally:
    docker("rm", "-f", name)
