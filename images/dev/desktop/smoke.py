#!/usr/bin/env python3
"""Runtime checks in an isolated container; never touches the interactive demo."""
import base64
import http.client
import os
from pathlib import Path
import socket
import subprocess
import tempfile
import time
import uuid

NAME = f"driftverk-browser-smoke-{uuid.uuid4().hex[:10]}"
IMAGE = os.environ.get("DRIFTVERK_TEST_IMAGE", "driftverk-dev:desktop-test")


def docker(*args, input=None, check=True):
    result = subprocess.run(["docker", *args], input=input, text=True, capture_output=True, timeout=90)
    if check and result.returncode:
        raise RuntimeError(f"docker {' '.join(args)} failed:\n{result.stdout}\n{result.stderr}")
    return result


def execute(*args, **kwargs):
    return docker("exec", "-i", NAME, *args, **kwargs)


def check_gateway():
    """Real compute preview gateway + Docker lookup, with fixture authorization."""
    gateway = f"{NAME}-gateway"
    token = uuid.uuid4().hex
    runtime = docker("inspect", "--format", "{{.Id}}", NAME).stdout.strip()
    compute = Path(__file__).resolve().parents[3] / "infrastructure/compute-agent"
    fixture = r"""
import http from 'node:http';
import {spawn} from 'node:child_process';
http.createServer(async (req,res) => {
  let body=''; for await (const chunk of req) body+=chunk;
  const input=JSON.parse(body || '{}');
  const allowed=req.headers.authorization==='Bearer fixture-agent' &&
    (req.url==='/api/compute/activity' || (input.token===process.env.FIXTURE_TOKEN && input.port===6080 && input.preview_id==='browser-smoke'));
  res.writeHead(allowed?200:403, {'content-type':'application/json'});
  res.end(JSON.stringify(allowed?{runtime_id:process.env.FIXTURE_RUNTIME,sandbox_id:'browser-smoke'}:{error:'Access denied'}));
}).listen(18080,'127.0.0.1', () => {
  const child=spawn(process.execPath,['/compute/preview-gateway.mjs'],{stdio:'inherit',env:{...process.env,
    CONTROL_PLANE_URL:'http://127.0.0.1:18080',COMPUTE_AGENT_TOKEN:'fixture-agent',
    COMPUTE_NODE_ID:'fixture-node',PREVIEW_GATEWAY_PORT:'8081',PREVIEW_DOMAIN:'preview.test'}});
  child.on('exit',code=>process.exit(code ?? 1));
});
"""
    created_gateway = False
    with tempfile.TemporaryDirectory(prefix="driftverk-browser-gateway-") as directory:
        Path(directory, "gateway.mjs").write_text(fixture)
        try:
            # Docker socket belongs only to this compute gateway fixture, never
            # to the browser/customer environment being tested.
            docker("run", "-d", "--name", gateway, "-p", "127.0.0.1::8081",
                   "-v", f"{compute}:/compute:ro", "-v", f"{directory}:/fixtures:ro",
                   "-v", "/var/run/docker.sock:/var/run/docker.sock:ro",
                   "-e", f"FIXTURE_TOKEN={token}", "-e", f"FIXTURE_RUNTIME={runtime}",
                   IMAGE, "node", "/fixtures/gateway.mjs")
            created_gateway = True
            port = int(docker("port", gateway, "8081/tcp").stdout.strip().split(":")[-1])
            host = "6080-browser-smoke.preview.test"

            def request(path, cookie=None):
                connection = http.client.HTTPConnection("127.0.0.1", port, timeout=5)
                try:
                    connection.request("GET", path, headers={"Host": host, **({"Cookie": cookie} if cookie else {})})
                    response = connection.getresponse()
                    return response.status, dict(response.getheaders()), response.read()
                finally:
                    connection.close()

            for _ in range(100):
                try:
                    if request("/health")[0] == 200:
                        break
                except OSError:
                    pass
                time.sleep(.1)
            else:
                raise RuntimeError(docker("logs", gateway).stdout)
            assert request("/")[0] == 401
            assert request("/?token=invalid")[0] == 403
            status, headers, _ = request(f"/?token={token}")
            assert status == 302 and headers["location"] == "/"
            assert "HttpOnly" in headers["set-cookie"] and "Secure" in headers["set-cookie"]
            cookie = headers["set-cookie"].split(";", 1)[0]
            assert request("/", cookie)[0] == 200
            assert b"driftverk-browser" in request("/ready.json", cookie)[2]
            assert request("/novnc/core/rfb.js", cookie)[0] == 200

            with socket.create_connection(("127.0.0.1", port), timeout=5) as stream:
                key = base64.b64encode(uuid.uuid4().bytes).decode()
                stream.sendall((f"GET /websockify HTTP/1.1\r\nHost: {host}\r\nCookie: {cookie}\r\n"
                                f"Connection: Upgrade\r\nUpgrade: websocket\r\nSec-WebSocket-Version: 13\r\n"
                                f"Sec-WebSocket-Key: {key}\r\nSec-WebSocket-Protocol: binary\r\n\r\n").encode())
                data = b""
                while b"\r\n\r\n" not in data:
                    chunk = stream.recv(4096)
                    assert chunk, "gateway closed before WebSocket upgrade"
                    data += chunk
                headers, data = data.split(b"\r\n\r\n", 1)
                assert b"101 Switching Protocols" in headers
                while len(data) < 14:
                    chunk = stream.recv(4096)
                    assert chunk, "gateway closed before VNC handshake"
                    data += chunk
                assert data[0] == 0x82 and data[1] == 12 and data[2:14].startswith(b"RFB 003."), data
            print("PASS real preview gateway: rejected access, cookie redirect, viewer assets and binary VNC WebSocket", flush=True)
        finally:
            if created_gateway:
                docker("rm", "-f", gateway, check=False)


CDP = r"""
import assert from 'node:assert/strict';
const targets = await (await fetch('http://127.0.0.1:9222/json/list')).json();
const page = targets.find(t => t.type === 'page' && t.url.endsWith('/welcome.html'));
assert.ok(page, 'the visible welcome page exists');
const ws = new WebSocket(page.webSocketDebuggerUrl);
let id = 0;
const calls = new Map();
ws.addEventListener('message', e => {
  const m = JSON.parse(e.data);
  if (calls.has(m.id)) { const cb = calls.get(m.id); calls.delete(m.id); m.error ? cb.reject(m.error) : cb.resolve(m.result); }
});
await new Promise((resolve, reject) => {
  ws.addEventListener('open', resolve, {once:true});
  ws.addEventListener('error', reject, {once:true});
});
const call = (method, params = {}) => new Promise((resolve, reject) => {
  const n = ++id; calls.set(n, {resolve,reject}); ws.send(JSON.stringify({id:n,method,params}));
});
const evaluate = async expression => {
  const result = await call('Runtime.evaluate', {expression, returnByValue:true});
  assert.equal(result.exceptionDetails, undefined);
  return result.result.value;
};
try {
  for (let i=0; i<50 && !await evaluate('Boolean(document.querySelector("#counter"))'); i++) await new Promise(r=>setTimeout(r,100));
  if (process.env.CHECK_PERSISTED === '1') {
    assert.equal(await evaluate('localStorage.getItem("prototype-smoke")'), 'persisted');
  } else {
    await call('Page.bringToFront');
    await evaluate('document.querySelector("#note").focus()');
    await call('Input.insertText', {text:'Shared browser CDP smoke'});
    assert.equal(await evaluate('document.querySelector("#note").value'), 'Shared browser CDP smoke');
    const {x,y} = await evaluate('(()=>{const r=document.querySelector("#counter").getBoundingClientRect();return {x:r.x+r.width/2,y:r.y+r.height/2}})()');
    await call('Input.dispatchMouseEvent', {type:'mousePressed', x,y,button:'left',clickCount:1});
    await call('Input.dispatchMouseEvent', {type:'mouseReleased', x,y,button:'left',clickCount:1});
    assert.equal(await evaluate('document.querySelector("#counter").textContent'), 'Clicked 1 times');
    await evaluate('localStorage.setItem("prototype-smoke","persisted")');
    const image = await call('Page.captureScreenshot', {format:'png'});
    assert.equal(Buffer.from(image.data,'base64').subarray(1,4).toString(),'PNG');
  }
  console.log('CDP interaction/profile check passed');
} finally { ws.close(); }
"""

created = False
try:
    docker("run", "-d", "--name", NAME, "--label", "driftverk.server-id=browser-smoke", "--cpus=2", "--memory=2g", "--shm-size=256m", IMAGE)
    created = True
    assert execute("driftverk-browser", "status").stdout.strip() == "stopped"
    execute("driftverk-browser", "start")
    assert execute("driftverk-browser", "status").stdout.strip() == "running"
    identity = execute("cat", "/tmp/driftverk-browser-0/pid.json").stdout
    execute("driftverk-browser", "start")
    assert execute("cat", "/tmp/driftverk-browser-0/pid.json").stdout == identity
    print("PASS startup and idempotent start", flush=True)

    listeners = execute("ss", "-lnt").stdout.splitlines()
    for port in (5900, 9222):
        addresses = [line.split()[3] for line in listeners if line.split()[3].endswith(f":{port}")]
        assert addresses and all(address.startswith(("127.0.0.1:", "[::1]:")) for address in addresses), addresses
    assert execute("curl", "--fail", "--silent", "http://127.0.0.1:6080/ready.json").stdout.strip() == '{"service":"driftverk-browser"}'
    print("PASS viewer HTTP and loopback-only VNC/CDP", flush=True)
    check_gateway()
    execute("node", "--input-type=module", input=CDP)
    print("PASS shared-session typing, pointer click and screenshot", flush=True)
    execute("node", "--input-type=module", input="""
const version = await (await fetch('http://127.0.0.1:9222/json/version')).json();
const socket = new WebSocket(version.webSocketDebuggerUrl);
let sent = false;
await new Promise((resolve, reject) => {
  socket.addEventListener('open', () => { sent = true; socket.send(JSON.stringify({id:1,method:'Browser.close'})); });
  socket.addEventListener('close', resolve);
  socket.addEventListener('error', event => sent ? resolve() : reject(event));
});
""")
    time.sleep(1)
    assert execute("driftverk-browser", "status").stdout.strip() == "running"
    execute("driftverk-browser", "focus")
    execute("curl", "--fail", "--silent", "http://127.0.0.1:9222/json/version")
    print("PASS closing Chromium preserves the desktop; browser focus reopens it", flush=True)


    execute("driftverk-browser", "stop")
    assert execute("driftverk-browser", "status").stdout.strip() == "stopped"
    listeners = execute("ss", "-lnt").stdout
    assert all(f":{port} " not in listeners for port in (5900, 6080, 9222))
    execute("driftverk-browser", "stop")
    execute("driftverk-browser", "start")
    execute("env", "CHECK_PERSISTED=1", "node", "--input-type=module", input=CDP)
    print("PASS clean stop, repeated stop and profile persistence", flush=True)

    docker("restart", "--time", "5", NAME)
    assert execute("driftverk-browser", "status").stdout.strip() == "stopped"
    execute("driftverk-browser", "start")
    execute("env", "CHECK_PERSISTED=1", "node", "--input-type=module", input=CDP)
    print("PASS container restart with stale state and persisted profile", flush=True)
    execute("driftverk-browser", "stop")
    # An existing app on the viewer port must not be killed or mistaken for this service.
    docker("exec", "-d", NAME, "python3", "-m", "http.server", "6080")
    execute("python3", "-c", "import socket,time\nfor _ in range(50):\n try:\n  socket.create_connection(('127.0.0.1',6080),.2).close(); break\n except OSError: time.sleep(.1)\nelse: raise RuntimeError('fixture did not start')")
    conflict = execute("driftverk-browser", "start", check=False)
    assert conflict.returncode != 0 and "already in use" in conflict.stderr
    execute("curl", "--fail", "--silent", "http://127.0.0.1:6080/")
    print("PASS conflicting port leaves existing app running", flush=True)
finally:
    if created:
        docker("rm", "-f", NAME, check=False)
