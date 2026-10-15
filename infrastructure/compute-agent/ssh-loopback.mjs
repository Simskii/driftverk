import { spawn } from "node:child_process";
import { Duplex } from "node:stream";

// Enter only the network namespace. Node and its libraries stay in the agent.
const relay = `
const net = require("node:net");
const socket = net.createConnection({ host: "127.0.0.1", port: Number(process.argv[1]), allowHalfOpen: true });
const timeout = setTimeout(() => socket.destroy(new Error("SSH forwarding connection timed out")), 10000);
socket.on("connect", () => {
  clearTimeout(timeout);
  socket.pipe(process.stdout);
  process.stdin.pipe(socket);
  process.send("connected");
});
socket.on("error", (error) => {
  console.error(error.message);
  process.exitCode = 1;
});
socket.on("close", () => {
  clearTimeout(timeout);
  process.stdin.destroy();
  if (process.connected) process.disconnect();
});
`;

export function connectContainerLoopback(pid, port, spawnProcess = spawn) {
  if (!Number.isSafeInteger(pid) || pid <= 0) throw new Error("Invalid SSH forwarding runtime PID");
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error("Invalid SSH forwarding port");
  const child = spawnProcess("nsenter", ["--target", String(pid), "--net", process.execPath, "-e", relay, String(port)], {
    stdio: ["pipe", "pipe", "pipe", "ipc"],
  });
  const socket = Duplex.from({ readable: child.stdout, writable: child.stdin });
  let errorText = "";
  child.stderr.on("data", (data) => { errorText = (errorText + data.toString()).slice(-4096); });
  child.on("message", (message) => { if (message === "connected") socket.emit("connect"); });
  child.on("error", (error) => socket.destroy(error));
  child.on("close", (code) => {
    if (code !== 0 && !socket.destroyed) socket.destroy(new Error(errorText.trim() || "SSH forwarding relay exited"));
  });
  socket.on("close", () => { if (child.exitCode === null) child.kill(); });
  return socket;
}
