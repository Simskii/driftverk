#!/usr/bin/env python3
"""Real Chromium + FFmpeg; deterministic Codex substitute, no account credentials."""
import base64
import json
import os
from pathlib import Path
import subprocess
import tempfile
import time
import uuid

NAME = "driftverk-recording-smoke-" + uuid.uuid4().hex[:10]

def docker(*args, check=True):
    result = subprocess.run(["docker", *args], capture_output=True, text=True, timeout=90)
    if check and result.returncode:
        raise RuntimeError(result.stdout + result.stderr)
    return result


def execute(*args, **kwargs):
    return docker("exec", NAME, *args, **kwargs)


def payload(identifier, prompt="demo", record=True):
    return base64.b64encode(json.dumps({"id": identifier, "prompt": prompt, "record": record, "cwd": "/workspace"}).encode()).decode()


def status(identifier):
    return json.loads(execute("cat", f"/root/.local/share/driftverk/runs/{identifier}/status.json").stdout)


def probe(identifier):
    path = f"/root/.local/share/driftverk/runs/{identifier}/recording.mp4"
    result = execute("ffprobe", "-v", "error", "-show_entries", "stream=codec_name,width,height,pix_fmt", "-show_entries", "format=duration", "-of", "json", path)
    info = json.loads(result.stdout)
    assert info["streams"][0]["codec_name"] == "h264", info
    assert info["streams"][0]["pix_fmt"] == "yuv420p", info
    assert float(info["format"]["duration"]) > .2, info
    return path

with tempfile.TemporaryDirectory(prefix="driftverk-recording-") as directory:
    stub = Path(directory, "codex")
    stub.write_text('''#!/usr/bin/env python3
import os, signal, subprocess, sys, time
from pathlib import Path
assert os.environ.get('CODEX_API_KEY') == 'fixture-api-key', 'configured API key was not passed to Codex'
Path('/tmp/agent-started').write_text(str(os.getpid()))
if sys.argv[-1].endswith('fail'):
    time.sleep(1)
    sys.exit(7)
if sys.argv[-1].endswith('wait'):
    time.sleep(120)
else:
    subprocess.run(['driftverk-browser-demo'],check=True)
''')
    stub.chmod(0o755)
    docker("run", "-d", "--name", NAME, "--cpus=2", "--memory=2g", "--shm-size=256m",
           "-e", "DRIFTVERK_DESKTOP_IDLE_SECONDS=5", "-v", f"{directory}:/fixture:ro", os.environ.get("DRIFTVERK_TEST_IMAGE", "driftverk-dev:desktop-test"))
    try:
        original_path = execute("printenv", "PATH").stdout.strip()
        command = ["env", "PATH=/fixture:" + original_path, "OPENAI_API_KEY=fixture-api-key", "driftverk-prompt", "run"]
        success = uuid.uuid4().hex + uuid.uuid4().hex[:16]
        execute(*command, payload(success))
        assert status(success)["exit_code"] == 0 and status(success)["recording"]
        video = probe(success)
        with Path(directory, "export.mp4").open("wb") as output:
            exported = subprocess.run(["docker", "exec", NAME, "driftverk-prompt", "export", success], stdout=output, stderr=subprocess.PIPE, timeout=10)
        assert exported.returncode == 0 and Path(directory, "export.mp4").stat().st_size > 1000
        print("PASS recorded real browser interactions and exported a playable H.264 MP4", flush=True)

        failure = uuid.uuid4().hex + uuid.uuid4().hex[:16]
        result = execute(*command, payload(failure, "fail"), check=False)
        assert result.returncode == 7 and status(failure)["recording"]
        probe(failure)
        print("PASS failed agent retains a playable recording and exit code", flush=True)

        cancelled = uuid.uuid4().hex + uuid.uuid4().hex[:16]
        execute("rm", "-f", "/tmp/agent-started")
        process = subprocess.Popen(["docker", "exec", NAME, *command, payload(cancelled, "wait")], stdout=subprocess.PIPE, stderr=subprocess.PIPE)
        for _ in range(100):
            if execute("test", "-f", "/tmp/agent-started", check=False).returncode == 0:
                break
            time.sleep(.1)
        else:
            raise RuntimeError("agent did not start")
        concurrent = execute(*command, payload(uuid.uuid4().hex + uuid.uuid4().hex[:16], "fail"), check=False)
        assert concurrent.returncode != 0 and "Another prompt" in concurrent.stderr
        time.sleep(6)
        assert execute("driftverk-browser", "status").stdout.strip() == "running"
        stop = execute("driftverk-browser", "stop", check=False)
        assert stop.returncode != 0 and "active" in stop.stderr
        print("PASS active prompt and recording prevent idle and explicit shutdown", flush=True)
        execute("pkill", "-HUP", "-f", "^python3 /usr/local/bin/driftverk-prompt run")
        process.communicate(timeout=30)
        assert process.returncode == 129 and status(cancelled)["recording"]
        probe(cancelled)
        pid = execute("cat", "/tmp/agent-started").stdout.strip()
        assert execute("kill", "-0", pid, check=False).returncode != 0
        assert execute("pgrep", "-x", "ffmpeg", check=False).returncode != 0
        print("PASS concurrent task rejection, hangup cleanup and playable interrupted recording", flush=True)

        # The Docker exec transport can remain alive after SSH closes. EOF must
        # still stop the task without relying on a PTY hangup signal.
        disconnected = uuid.uuid4().hex + uuid.uuid4().hex[:16]
        request = {"id": disconnected, "prompt": "wait", "record": True, "cwd": "/workspace", "heartbeat": True}
        encoded = base64.b64encode(json.dumps(request).encode()).decode()
        execute("rm", "-f", "/tmp/agent-started")
        process = subprocess.Popen(["docker", "exec", "-i", NAME, *command, encoded], stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
        process.stdin.write(b"heartbeat\n"); process.stdin.flush()
        for _ in range(100):
            if execute("test", "-f", "/tmp/agent-started", check=False).returncode == 0:
                break
            time.sleep(.1)
        else:
            raise RuntimeError("heartbeat agent did not start")
        process.stdin.close(); process.stdin = None
        process.communicate(timeout=30)
        assert process.returncode == 130 and status(disconnected)["recording"]
        probe(disconnected)
        print("PASS Docker exec stdin disconnect stops agent and finalizes video", flush=True)

        # A broken recorder must prevent the agent from starting.
        broken = Path(directory, "ffmpeg"); broken.write_text("#!/bin/sh\nexit 1\n"); broken.chmod(0o755)
        execute("rm", "-f", "/tmp/agent-started")
        identifier = uuid.uuid4().hex + uuid.uuid4().hex[:16]
        result = execute(*command, payload(identifier), check=False)
        assert result.returncode != 0 and "Recording could not start" in result.stderr, result.stderr
        assert not status(identifier)["recording"]
        assert execute("test", "-f", "/tmp/agent-started", check=False).returncode != 0
        print("PASS recorder startup failure prevents agent execution", flush=True)
    finally:
        docker("rm", "-f", NAME, check=False)
