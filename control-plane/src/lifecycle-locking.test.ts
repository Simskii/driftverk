import assert from "node:assert/strict";
import test from "node:test";
import { readFile, readdir } from "node:fs/promises";
import pg, { type PoolClient } from "pg";

test("lifecycle admission never waits for an agent-held job while holding its sandbox", { skip: !process.env.CONTROL_PLANE_TEST_DATABASE_URL }, async t => {
  const admin=new pg.Client({connectionString:process.env.CONTROL_PLANE_TEST_DATABASE_URL}); await admin.connect();
  const schema=`qa_lifecycle_locks_${crypto.randomUUID().replaceAll("-", "")}`;
  const url=new URL(process.env.CONTROL_PLANE_TEST_DATABASE_URL!); url.searchParams.set("options",`-c search_path=${schema}`);
  Object.assign(process.env,{DATABASE_URL:url.toString(),BETTER_AUTH_URL:"http://localhost:3098",BETTER_AUTH_SECRET:"local-test-auth-secret-000000000000",SECRET_ENCRYPTION_KEYS:"test=AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=",PREVIEW_TOKEN_SECRET:"local-test-preview-secret-000000000",TERMINAL_TOKEN_SECRET:"local-test-terminal-secret-000000000",SSH_TOKEN_SECRET:"local-test-ssh-secret-00000000000000",COMPUTE_AGENT_TOKEN:"local-test-compute-secret-000000000"});
  await admin.query(`CREATE SCHEMA ${schema}; SET search_path TO ${schema}`);
  const {db}=await import("./db.js");
  try {
    const migrations=new URL("../migrations/",import.meta.url);
    for(const name of (await readdir(migrations)).filter(name=>name.endsWith(".sql")).sort()) await admin.query(await readFile(new URL(name,migrations),"utf8"));
    await admin.query(`INSERT INTO "user"(id,name,email,"emailVerified") VALUES('user','QA','locks@example.test',true);
      INSERT INTO organizations(id,name,slug) VALUES('org','Org','org'); UPDATE billing_accounts SET complimentary=true;
      INSERT INTO memberships(id,organization_id,user_id,role) VALUES('member','org','user','admin');
      INSERT INTO sandboxes(id,preview_id,organization_id,name,source_type,source_image,cpu_count,memory_mb,disk_gb,state,desired_state,created_by_user_id,runtime_id)
      VALUES('env','preview','org','env','image','node:22',2,4096,40,'running','stopped','user','runtime');
      INSERT INTO compute_jobs(id,sandbox_id,operation,status) VALUES('job','env','stop','leased');`);
    const {changeEnvironmentStateForActor,EnvironmentServiceError}=await import("./environment-service.js");
    const {environmentAction}=await import("./workspace.js");
    const actor={organizationId:"org",organizationName:"Org",organizationSlug:"org",actorUserId:"user",automationIdPrefix:null};
    const session={user:{id:"user"},session:{activeOrganizationId:"org"}} as Parameters<typeof environmentAction>[1];
    const context=(action:string)=>({req:{param:()=>"env",json:async()=>({action})},json:(body:unknown,status=200)=>({body,status})}) as unknown as Parameters<typeof environmentAction>[0];
    for(const path of ["API active job","browser active job","browser queued cancellation"]){
      await t.test(path,async sub=>{
        const queued=path==="browser queued cancellation";
        await admin.query("UPDATE sandboxes SET state='provisioning',runtime_id=$1 WHERE id='env'",[queued?null:"runtime"]);
        await admin.query("UPDATE compute_jobs SET status=$1,operation=$2 WHERE id='job'",[queued?"queued":"leased",queued?"create":"stop"]);
        const lifecycle=await db.connect(), reporter=await db.connect();
        try {
          await lifecycle.query("BEGIN");
          await lifecycle.query("SET LOCAL lock_timeout='3s'");
          await lifecycle.query("SELECT id FROM sandboxes WHERE id='env' FOR UPDATE");
          await reporter.query("BEGIN");
          await reporter.query("SET LOCAL lock_timeout='3s'");
          await reporter.query("SELECT id FROM compute_jobs WHERE id='job' FOR UPDATE");
          // This is the agent callback's job -> sandbox lock order. Hold its first
          // lock while the lifecycle request already owns the sandbox row.
          const reporting=reporter.query("SELECT id FROM sandboxes WHERE id='env' FOR UPDATE").then(()=>null,(error:unknown)=>error);
          if(path==="API active job"){
            await assert.rejects(changeEnvironmentStateForActor(actor,"env","stop",lifecycle),error=>error instanceof EnvironmentServiceError && error.status===409);
            await lifecycle.query("ROLLBACK");
          }else{
            sub.mock.method(db,"query",async()=>({rows:[{organization_id:"org",role:"admin"}],rowCount:1}));
            sub.mock.method(db,"connect",async()=>({query:(sql:string,args?:unknown[])=>sql==="BEGIN"?Promise.resolve({rows:[],rowCount:0}):lifecycle.query(sql,args),release(){}} as unknown as PoolClient));
            assert.equal((await environmentAction(context(queued?"delete":"stop"),session)).status,409);
          }
          assert.equal(await reporting,null,"the real callback lock must complete without deadlock or lock timeout");
          await reporter.query("COMMIT");
        }finally{await lifecycle.query("ROLLBACK");await reporter.query("ROLLBACK");lifecycle.release();reporter.release();}
      });
    }
    await t.test("uncontended queued cancellation still deletes before provisioning",async()=>{
      await admin.query("UPDATE sandboxes SET state='provisioning',desired_state='running',runtime_id=NULL WHERE id='env'");
      await admin.query("UPDATE compute_jobs SET status='queued',operation='create' WHERE id='job'");
      assert.equal((await environmentAction(context("delete"),session)).status,200);
      assert.equal((await admin.query("SELECT state FROM sandboxes WHERE id='env'")).rows[0].state,"deleted");
      assert.equal((await admin.query("SELECT status FROM compute_jobs WHERE id='job'")).rows[0].status,"failed");
    });
  }finally{await db.end();await admin.query(`DROP SCHEMA ${schema} CASCADE`);await admin.end();}
});
