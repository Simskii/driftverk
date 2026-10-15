import test from 'node:test';
import assert from 'node:assert/strict';
import { promisify } from 'node:util';
import { execFile } from 'node:child_process';
import { agentTerminalCommand } from './agent-terminal.mjs';
import { inspectAgentSession } from './agent-sessions.mjs';

const exec=promisify(execFile);
test('detached agent survives its client and expires locally without the control plane',{
  skip:process.env.DRIFTVERK_RUNTIME_QA!=='1',timeout:45000,
},async()=>{
  const name=`driftverk-agent-qa-${process.pid}`;
  let id;
  try {
    id=(await exec('docker',['run','-d','--name',name,'--network','none','--init','--label',`driftverk.server-id=${name}`,
      '-e','ANTHROPIC_API_KEY=local-fixture',process.env.DRIFTVERK_QA_IMAGE || 'driftverk-dev:1','sleep','infinity'])).stdout.trim();
    await exec('docker',['exec',id,'sh','-c',`printf '#!/bin/sh\necho $$ > /workspace/agent.pid\necho running\nsleep 90\n' >/usr/local/bin/claude; chmod +x /usr/local/bin/claude`]);
    const socket=`driftverk-session-${crypto.randomUUID()}`;
    const expires=new Date(Date.now()+10000).toISOString();
    await exec('docker',['exec','-d','-t',id,...agentTerminalCommand({id:'claude',protection:{socket,expires_at:expires}})]);
    const session={sandbox_id:name,runtime_id:id,current_runtime_id:id,environment_state:'running',socket,status:'running',created_at:new Date().toISOString(),expires_at:expires};
    let running=false;
    for(let i=0;i<30;i++){
      if(await inspectAgentSession(session)==='running'){running=true;break;}
      await new Promise(resolve=>setTimeout(resolve,100));
    }
    assert.ok(running,'agent starts in its protected session');
    await exec('docker',['exec',id,'tmux','-L',socket,'detach-client','-a']);
    await exec('docker',['exec',id,'sh','-c','kill -0 "$(cat /workspace/agent.pid)"']);
    assert.equal(await inspectAgentSession(session),'running','disconnect does not end the agent');
    // Do not call the host deadline monitor: the guest timeout alone must terminate it.
    await new Promise(resolve=>setTimeout(resolve,Math.max(0,Date.parse(expires)-Date.now())+1500));
    await assert.rejects(exec('docker',['exec',id,'tmux','-L',socket,'has-session','-t','agent']));
    assert.equal((await exec('docker',['inspect','--format','{{.State.Running}}',id])).stdout.trim(),'true','expiration ends the agent, not the environment');
  } finally {
    if(id)await exec('docker',['rm','-f',id]);
  }
});
