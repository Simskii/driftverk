import test from 'node:test';
import assert from 'node:assert/strict';
import { inspectAgentSession } from './agent-sessions.mjs';
import { agentTerminalCommand } from './agent-terminal.mjs';

const now = Date.now();
const session = { sandbox_id:'env', runtime_id:'a'.repeat(64), current_runtime_id:'a'.repeat(64), environment_state:'running',
  socket:'driftverk-session-11111111-1111-1111-1111-111111111111', status:'running', created_at:new Date(now-120000), expires_at:new Date(now+60000) };
const runner = (present=true) => async (_command,args) => ({stdout:args[0]==='inspect'
  ? JSON.stringify([{State:{Running:true},Config:{Labels:{'driftverk.server-id':'env'}}}]) : present?'running':'absent'});
test('agent protection follows the remote session independently of browser traffic',async()=>{
  assert.equal(await inspectAgentSession(session,runner(),now),'running');
  assert.equal(await inspectAgentSession({...session,environment_state:'provisioning'},runner(),now),'running','pending auto-stop is not proof the process ended');
  assert.equal(await inspectAgentSession(session,runner(false),now),'ended');
  assert.equal(await inspectAgentSession({...session,status:'launching',created_at:new Date(now)},runner(false),now),null);
  assert.equal(await inspectAgentSession({...session,current_runtime_id:'b'.repeat(64)},runner(),now),'lost');
  await assert.rejects(inspectAgentSession(session,async()=>{throw Error('Docker unavailable');},now),/Docker unavailable/);
});
test('deadline stops only the registered session and does not extend on reconnect',async()=>{
  const commands=[];
  const run=runner();
  assert.equal(await inspectAgentSession({...session,expires_at:new Date(now-1)},async(c,args)=>{commands.push(args);return run(c,args);},now),'expired');
  assert.ok(commands[1].includes(session.socket));
  assert.match(commands[1].join(' '),/kill-server/);
  const command=agentTerminalCommand({id:'codex',protection:{socket:session.socket,expires_at:session.expires_at.toISOString()}})[2];
  assert.match(command,/exec timeout -k 10 \d+s/);
  assert.match(command,/new-session -A/);
  assert.throws(()=>agentTerminalCommand({id:'codex',protection:{socket:'$(bad)',expires_at:session.expires_at}}));
  assert.throws(()=>agentTerminalCommand({id:'codex',protection:{socket:session.socket,expires_at:new Date(now-1)}}),/expired/);
});
