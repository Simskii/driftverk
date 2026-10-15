"""Runs only inside a sandbox. The compute host supplies JSON over docker exec stdin."""
import base64
import json
import os
import re
import selectors
import signal
import subprocess
import sys
import time

ROOT = "/var/lib/driftverk/executions"
LIMIT = 1048576
ARTIFACT_LIMIT = 131072


def write_json(path, value):
    temporary = path + ".next"
    with open(temporary, "w") as handle:
        json.dump(value, handle)
    os.replace(temporary, path)


def process_stamp(pid):
    try:
        with open("/proc/%s/stat" % pid) as handle:
            return handle.read().rsplit(")", 1)[1].split()[19]
    except (OSError, IndexError):
        return None


class SecretRedactor:
    """Hold enough bytes to mask exact secret values even across pipe reads."""
    def __init__(self, values):
        secrets = sorted({value.encode("utf-8") for value in values if value}, key=len, reverse=True)
        self.pattern = re.compile(b"|".join(re.escape(value) for value in secrets)) if secrets else None
        self.keep = max((len(value) - 1 for value in secrets), default=0)
        self.pending = b""

    def feed(self, chunk, final=False):
        if self.pattern is None:
            return chunk
        data = self.pending + chunk
        cutoff = len(data) if final else max(0, len(data) - self.keep)
        parts, position = [], 0
        for match in self.pattern.finditer(data):
            if match.start() >= cutoff:
                break
            parts.extend((data[position:match.start()], b"[REDACTED]"))
            position = match.end()
        cutoff = max(cutoff, position)
        parts.append(data[position:cutoff])
        self.pending = data[cutoff:]
        return b"".join(parts)


def read_artifact(cwd, path, secrets=()):
    # Walk through directory descriptors, rejecting symlinks and special files.
    import stat
    directory = None
    try:
        directory = os.open(cwd, os.O_RDONLY | os.O_DIRECTORY)
        parts = path.split("/")
        if any(part in ("", ".", "..") for part in parts):
            raise ValueError("Invalid artifact path")
        for part in parts[:-1]:
            child = os.open(part, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW, dir_fd=directory)
            os.close(directory)
            directory = child
        fd = os.open(parts[-1], os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK, dir_fd=directory)
        try:
            info = os.fstat(fd)
            if not stat.S_ISREG(info.st_mode) or info.st_size > ARTIFACT_LIMIT:
                raise ValueError("Artifact must be a regular file no larger than 128 KiB")
            data = b""
            while len(data) <= ARTIFACT_LIMIT:
                chunk = os.read(fd, min(32768, ARTIFACT_LIMIT + 1 - len(data)))
                if not chunk:
                    break
                data += chunk
            if len(data) > ARTIFACT_LIMIT:
                raise ValueError("Artifact exceeds 128 KiB")
            data = SecretRedactor(secrets).feed(data, final=True)
            if len(data) > ARTIFACT_LIMIT:
                raise ValueError("Redacted artifact exceeds 128 KiB")
            return {"path": path, "data": base64.b64encode(data).decode("ascii")}
        finally:
            os.close(fd)
    except (OSError, ValueError):
        return {"path": path, "error": "Artifact unavailable, unsafe, or larger than 128 KiB"}
    finally:
        if directory is not None:
            os.close(directory)


def supervise(directory):
    # Secrets arrive on a private pipe, never in request.json or process arguments.
    environment = json.load(sys.stdin)
    secrets = list(environment.values())
    with open(directory + "/request.json") as handle:
        config = json.load(handle)
    write_json(directory + "/worker.json", {"pid": os.getpid(), "stamp": process_stamp(os.getpid())})
    child = None
    result = {"status": "failed", "exit_code": None, "artifacts": []}
    try:
        child = subprocess.Popen(["/bin/sh", "-c", config["command"]], cwd=config["cwd"], stdin=subprocess.DEVNULL,
                                 stdout=subprocess.PIPE, stderr=subprocess.PIPE, start_new_session=True,
                                 env={**os.environ, **environment})
        environment.clear()
        selector = selectors.DefaultSelector()
        selector.register(child.stdout, selectors.EVENT_READ, "stdout")
        selector.register(child.stderr, selectors.EVENT_READ, "stderr")
        files = {name: open(directory + "/" + name, "wb", buffering=0) for name in ("stdout", "stderr")}
        sizes = {"stdout": 0, "stderr": 0}
        redactors = {name: SecretRedactor(secrets) for name in ("stdout", "stderr")}
        deadline = time.monotonic() + config["timeout_seconds"]
        reason = None
        def stop():
            try:
                os.killpg(child.pid, signal.SIGKILL)
            except ProcessLookupError:
                pass
        try:
            while selector.get_map() or child.poll() is None:
                if reason is None:
                    if os.path.exists(directory + "/cancel"):
                        reason = "cancelled"
                    elif time.monotonic() >= deadline:
                        reason = "timed_out"
                    if reason:
                        stop()
                for key, _ in selector.select(0.1):
                    chunk = os.read(key.fileobj.fileno(), 32768)
                    name = key.data
                    final = not chunk
                    chunk = redactors[name].feed(chunk, final=final)
                    if final:
                        selector.unregister(key.fileobj)
                        key.fileobj.close()
                    available = LIMIT - sizes[name]
                    files[name].write(chunk[:available])
                    sizes[name] += min(len(chunk), available)
                    if len(chunk) > available and reason is None:
                        reason = "output_limit"
                        stop()
                # Detached descendants can retain pipes after the command group was killed.
                if reason and child.poll() is not None:
                    break
            exit_code = child.wait()
            for name in ("stdout", "stderr"):
                tail = redactors[name].feed(b"", final=True)
                files[name].write(tail[:LIMIT - sizes[name]])
                sizes[name] += min(len(tail), LIMIT - sizes[name])
            result = {"status": reason or ("succeeded" if exit_code == 0 else "failed"), "exit_code": exit_code,
                      "artifacts": [read_artifact(config["cwd"], path, secrets) for path in config["artifact_paths"]]}
        finally:
            for handle in files.values():
                handle.close()
            selector.close()
    except Exception:
        if child and child.poll() is None:
            try:
                os.killpg(child.pid, signal.SIGKILL)
            except ProcessLookupError:
                pass
            child.wait()
    environment.clear()
    secrets.clear()
    write_json(directory + "/result.json", result)


def handle(request):
    execution_id = request["id"]
    if not re.fullmatch(r"exec_[a-f0-9-]{36}", execution_id):
        raise ValueError("Invalid execution ID")
    directory = ROOT + "/" + execution_id
    if request["action"] == "start":
        os.makedirs(ROOT, exist_ok=True)
        try:
            os.mkdir(directory, mode=0o700)
        except FileExistsError:
            return {"started": False}
        write_json(directory + "/request.json", {key: request[key] for key in ("command", "cwd", "timeout_seconds", "artifact_paths")})
        worker = subprocess.Popen([sys.executable, "-c", request["_source"], "worker", directory],
                                  stdin=subprocess.PIPE, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
                                  close_fds=True, start_new_session=True)
        try:
            worker.stdin.write(json.dumps(request.get("environment_variables", {})).encode("utf-8"))
            worker.stdin.close()
        except Exception:
            worker.kill()
            worker.wait()
            write_json(directory + "/result.json", {"status": "failed", "exit_code": None, "artifacts": []})
        return {"started": True}
    if not os.path.isdir(directory):
        return {"status": "lost", "exit_code": None, "artifacts": []}
    if request.get("cancel_requested"):
        open(directory + "/cancel", "a").close()
    result = {"status": "running", "exit_code": None}
    if os.path.isfile(directory + "/result.json"):
        with open(directory + "/result.json") as handle:
            result = json.load(handle)
    elif os.path.isfile(directory + "/worker.json"):
        with open(directory + "/worker.json") as handle:
            worker = json.load(handle)
        if not worker["stamp"] or process_stamp(worker["pid"]) != worker["stamp"]:
            result = {"status": "lost", "exit_code": None, "artifacts": []}
    elif time.time() - os.stat(directory).st_mtime > 10:
        result = {"status": "lost", "exit_code": None, "artifacts": []}
    pending = False
    for name in ("stdout", "stderr"):
        offset = request.get(name + "_bytes", 0)
        try:
            with open(directory + "/" + name, "rb") as handle:
                handle.seek(offset)
                chunk = handle.read(32768)
                pending = pending or bool(handle.read(1))
        except FileNotFoundError:
            chunk = b""
        result[name] = {"offset": offset, "data": base64.b64encode(chunk).decode("ascii")}
    if pending:
        result.update(status="running", exit_code=None, artifacts=[])
    return result


if __name__ == "__main__":
    if len(sys.argv) > 1 and sys.argv[1] == "worker":
        supervise(sys.argv[2])
    else:
        print(json.dumps(handle(json.load(sys.stdin))))
