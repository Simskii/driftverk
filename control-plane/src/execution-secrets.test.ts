import assert from "node:assert/strict";
import test from "node:test";
import type { PoolClient } from "pg";
process.env.DATABASE_URL ??= "postgres://test:test@localhost:5432/test";
process.env.BETTER_AUTH_URL ??= "http://localhost:3000";
process.env.BETTER_AUTH_SECRET ??= "test-better-auth-secret-000000000";
process.env.SECRET_ENCRYPTION_KEYS ??= "test=AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=";
process.env.PREVIEW_TOKEN_SECRET ??= "test-preview-secret-0000000000000";
process.env.TERMINAL_TOKEN_SECRET ??= "test-terminal-secret-000000000000";
process.env.SSH_TOKEN_SECRET ??= "test-ssh-secret-000000000000000000";
process.env.COMPUTE_AGENT_TOKEN ??= "test-compute-secret-0000000000000";
const { parseExecutionEnvironment, createExecution, getExecution } = await import("./executions.js");
const { decryptSecret } = await import("./secrets.js");
const { db } = await import("./db.js");

test("execution variables are strictly bounded and preserve exact string values", () => {
  for (const input of [null, {}, [{name:"A",value:1}], [{name:"-A",value:"x"}], [{name:"A",value:"x\0"}], [{name:"A",value:"x"},{name:"A",value:"y"}], Array.from({length:26},(_,i)=>({name:`V${i}`,value:"x"})), [{name:"A",value:"a".repeat(32769)}], [{name:"A",value:"a".repeat(32768)},{name:"B",value:"b".repeat(32768)}]]) assert.throws(() => parseExecutionEnvironment(input));
  assert.equal(parseExecutionEnvironment([{name:"PREVIEW_GITHUB_TOKEN",value:" fixture "}]).PREVIEW_GITHUB_TOKEN," fixture ");
  assert.equal(Object.keys(parseExecutionEnvironment(undefined)).length,0);
});

test("execution secrets require trusted unrestricted actors and use execution-scoped encryption", async t => {
  let trust = "trusted";
  const queries: Array<{sql:string;args:unknown[]}> = [];
  const client = {query:async (sql:string,args:unknown[] = [])=>{
    queries.push({sql,args});
    if(sql.includes("SELECT * FROM sandboxes")) return {rows:[{state:"running",runtime_id:"runtime",compute_node_id:"node",workspace_path:"/workspace",code_trust:trust}],rowCount:1};
    if(sql.includes("count(*)")) return {rows:[{active:0,total:0}],rowCount:1};
    return {rows:[],rowCount:0};
  }} as unknown as PoolClient;
  const actor={organizationId:"org",organizationName:"Org",organizationSlug:"org",actorUserId:"user",automationIdPrefix:null};
  const input={command:'echo "$PREVIEW_GITHUB_TOKEN"',environment_variables:[{name:"PREVIEW_GITHUB_TOKEN",value:"fixture-token"}]};
  trust="untrusted";
  await assert.rejects(createExecution(actor,"env",input,client),/require trusted code/);
  trust="trusted";
  await assert.rejects(createExecution({...actor,automationIdPrefix:"github:1:pr:"},"env",input,client),/unrestricted organization actor/);
  const result=await createExecution(actor,"env",input,client);
  const stored=queries.find(q=>q.sql.includes("SET encrypted_environment"))!;
  assert.ok(!JSON.stringify(stored).includes("fixture-token"));
  const value=JSON.parse(decryptSecret(stored.args[1] as string,stored.args[2] as string,`organization:org:execution:${result.id}:environment`));
  assert.equal(value.PREVIEW_GITHUB_TOKEN,"fixture-token");
  assert.throws(()=>decryptSecret(stored.args[1] as string,stored.args[2] as string,`organization:other:execution:${result.id}:environment`));
  assert.ok(queries.some(q=>q.sql.includes("has_ever_received_environment_secrets = true")));
  t.mock.method(db,"query",async(sql:string)=>({rows:sql.includes("SELECT e.*")?[{id:result.id,status:"queued",encrypted_environment:stored.args[1],environment_iv:stored.args[2]}]:[]}));
  assert.ok(!JSON.stringify(await getExecution(actor,result.id)).includes(String(stored.args[1])));
});
