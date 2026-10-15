import assert from "node:assert/strict";
import test from "node:test";
import { readFile, readdir } from "node:fs/promises";
import pg, { type PoolClient } from "pg";
import type { EnvironmentActor } from "./environment-service.js";

test("prepared preview claims, replenishment and lifecycle isolation", { skip: !process.env.CONTROL_PLANE_TEST_DATABASE_URL }, async t => {
  const admin = new pg.Client({ connectionString: process.env.CONTROL_PLANE_TEST_DATABASE_URL });
  await admin.connect();
  const schema = `qa_prepared_${crypto.randomUUID().replaceAll("-", "")}`;
  const url = new URL(process.env.CONTROL_PLANE_TEST_DATABASE_URL!);
  url.searchParams.set("options", `-c search_path=${schema}`);
  Object.assign(process.env, {
    DATABASE_URL: url.toString(), BETTER_AUTH_URL: "http://localhost:3098", BETTER_AUTH_SECRET: "local-test-auth-secret-000000000000",
    SECRET_ENCRYPTION_KEYS: "test=AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=", PREVIEW_TOKEN_SECRET: "local-test-preview-secret-000000000",
    TERMINAL_TOKEN_SECRET: "local-test-terminal-secret-000000000", SSH_TOKEN_SECRET: "local-test-ssh-secret-00000000000000",
    COMPUTE_AGENT_TOKEN: "local-test-compute-secret-000000000",
  });
  await admin.query(`CREATE SCHEMA ${schema}; SET search_path TO ${schema}`);
  const { db } = await import("./db.js");
  try {
    const migrations = new URL("../migrations/", import.meta.url);
    for (const name of (await readdir(migrations)).filter(name => name.endsWith(".sql")).sort()) await admin.query(await readFile(new URL(name, migrations), "utf8"));
    await admin.query(`INSERT INTO "user" (id,name,email,"emailVerified") VALUES ('user','QA','prepared@example.test',true);
      INSERT INTO organizations(id,name,slug,hosting_mode) VALUES ('org','Org','org','managed'),('other','Other','other','managed');
      UPDATE billing_accounts SET complimentary=true;
      INSERT INTO memberships(id,user_id,organization_id,role) VALUES ('admin','user','org','admin');
      INSERT INTO workspace_snapshots(id,organization_id,name,version,status,base_image,created_by_user_id) VALUES ('snapshot','org','Prepared','1','ready','node:22','user');`);
    const configuration = {source_type:"snapshot",snapshot_id:"snapshot",workspace_path:"/workspaces/example-project",startup_command:"true",readiness_command:"true",cpu:2,memory_mb:4096};
    await admin.query("INSERT INTO environment_templates(id,organization_id,name,configuration) VALUES ('template','org','Example project',$1)",[JSON.stringify(configuration)]);
    const actor:EnvironmentActor = {organizationId:"org",organizationName:"Org",organizationSlug:"org",actorUserId:"user",automationIdPrefix:null};
    const pool = await import("./prepared-previews.js");
    async function transaction<T>(operation:(client:PoolClient)=>Promise<T>):Promise<T> {
      const client=await db.connect();
      try { await client.query("BEGIN"); const result=await operation(client); await client.query("COMMIT"); return result; }
      catch(error) { await client.query("ROLLBACK"); throw error; } finally { client.release(); }
    }
    const claim=(name:string, identity=actor)=>transaction(client=>pool.claimPreparedPreview(identity,"template",name,client));
    const configure=(enabled:boolean, identity=actor)=>transaction(client=>pool.configurePreparedPreview(identity,"template",enabled,client));
    async function ready(id:string) {
      await admin.query("UPDATE compute_jobs SET status='succeeded' WHERE sandbox_id=$1",[id]);
      await admin.query(`UPDATE sandboxes SET state='running',desired_state='running',runtime_id='fixture-runtime',application_status='{"status":"ready"}'::jsonb WHERE id=$1`,[id]);
    }
    async function stopped(id:string) {
      await admin.query("UPDATE compute_jobs SET status='succeeded' WHERE sandbox_id=$1",[id]);
      await admin.query("UPDATE sandboxes SET state='stopped',desired_state='stopped' WHERE id=$1",[id]);
    }
    const spare=async()=> (await admin.query("SELECT prepared_environment_id FROM environment_templates WHERE id='template'")).rows[0].prepared_environment_id as string | null;
    let firstSpare:string;
    let claims:Awaited<ReturnType<typeof claim>>[]=[];
    await t.test("enabling creates exactly one prepared environment and reports readiness",async()=>{
      await configure(true);
      await pool.reconcilePreparedPreviews();
      firstSpare=(await spare())!;
      assert.ok(firstSpare);
      assert.equal((await pool.preparedPreviewStatus(actor,"template")).status,"waiting");
      await ready(firstSpare);
      await pool.reconcilePreparedPreviews();
      assert.equal((await pool.preparedPreviewStatus(actor,"template")).status,"preparing");
      assert.equal((await admin.query("SELECT operation FROM compute_jobs WHERE sandbox_id=$1 AND status='queued'",[firstSpare])).rows[0].operation,"stop");
      await stopped(firstSpare);
      assert.equal((await pool.preparedPreviewStatus(actor,"template")).status,"ready");
      assert.equal(await spare(),firstSpare);
      const environments=await import("./environment-service.js");
      assert.equal((await environments.listEnvironmentsForActor(actor)).length,0,"unclaimed spare is hidden from environments");
    });
    await t.test("concurrent different PR claims never share the spare",async()=>{
      claims=await Promise.all([claim("gh-123-pr-1"),claim("gh-123-pr-2")]);
      assert.notEqual(claims[0]!.environment_id,claims[1]!.environment_id);
      assert.equal(claims.filter(result=>result.environment_id===firstSpare).length,1);
      assert.deepEqual(claims.map(result=>result.source).sort(),["cold","prepared"]);
      assert.equal(await spare(),null);
      const environments=await import("./environment-service.js");
      assert.equal((await environments.listEnvironmentsForActor(actor)).length,2,"claimed previews are visible as environments");
      const preparedClaim=claims.find(result=>result.environment_id===firstSpare)!;
      assert.ok(preparedClaim.operation_id,"claiming a stopped spare queues its start");
      assert.equal((await admin.query("SELECT operation FROM compute_jobs WHERE id=$1",[preparedClaim.operation_id])).rows[0].operation,"start");
      assert.equal((await admin.query("SELECT count(*)::int AS n FROM sandboxes WHERE preview_claim_key IS NOT NULL")).rows[0].n,2);
      for(const result of claims) await ready(result.environment_id);
    });
    await t.test("concurrent retries of the same PR reuse one environment and operation",async()=>{
      const [a,b]=await Promise.all([claim("gh-123-pr-3"),claim("gh-123-pr-3")]);
      assert.equal(a.environment_id,b.environment_id);
      assert.equal(a.operation_id,b.operation_id);
      assert.equal((await admin.query("SELECT count(*)::int AS n FROM sandboxes WHERE preview_claim_key='gh-123-pr-3'")).rows[0].n,1);
    });
    await t.test("claimed environments stay out of the pool and one replacement is prepared",async()=>{
      await pool.reconcilePreparedPreviews();
      const next=(await spare())!;
      assert.ok(next && !claims.some(result=>result.environment_id===next));
      await pool.reconcilePreparedPreviews();
      assert.equal(await spare(),next);
      assert.equal((await admin.query("SELECT preview_claim_key FROM sandboxes WHERE id=$1",[next])).rows[0].preview_claim_key,null);
    });
    await t.test("claim renews expiry without rewriting creation history",async()=>{
      const id=claims[0]!.environment_id;
      await admin.query("UPDATE sandboxes SET created_at=now()-interval '2 days',auto_delete_minutes=1440 WHERE id=$1",[id]);
      const before=(await admin.query("SELECT created_at FROM sandboxes WHERE id=$1",[id])).rows[0].created_at;
      assert.equal((await claim("gh-123-pr-1")).environment_id,id);
      const after=(await admin.query("SELECT created_at,EXTRACT(EPOCH FROM (created_at+auto_delete_minutes*interval '1 minute'-now()))/60 AS remaining FROM sandboxes WHERE id=$1",[id])).rows[0];
      assert.equal(after.created_at.toISOString(),before.toISOString());
      assert.ok(Number(after.remaining)>=1439 && Number(after.remaining)<=1441);
    });
    await t.test("cross-organization and repository-scoped actors cannot claim or configure",async()=>{
      const other={...actor,organizationId:"other"}, scoped={...actor,automationIdPrefix:"github:123:pr:"};
      await assert.rejects(claim("gh-123-pr-4",other),/not found/);
      await assert.rejects(configure(true,other),/not found/);
      await assert.rejects(pool.preparedPreviewStatus(other,"template"),/not found/);
      await assert.rejects(claim("gh-123-pr-4",scoped),/trusted organization key/);
      await assert.rejects(configure(true,scoped),/trusted organization key/);
      await assert.rejects(pool.preparedPreviewStatus(scoped,"template"),/trusted organization key/);
    });
    await t.test("retiring claims are rejected instead of returning a deletion operation",async()=>{
      const id=claims[0]!.environment_id;
      await admin.query("UPDATE sandboxes SET state='provisioning',desired_state='deleted' WHERE id=$1",[id]);
      await admin.query("INSERT INTO compute_jobs(id,sandbox_id,operation,status) VALUES('delete-existing',$1,'delete','queued')",[id]);
      await assert.rejects(claim("gh-123-pr-1"),(error:unknown)=>error instanceof Error && "status" in error && error.status===409);
      assert.equal((await admin.query("SELECT desired_state FROM sandboxes WHERE id=$1",[id])).rows[0].desired_state,"deleted");
    });
    await t.test("degraded existing claims queue recovery on their existing environment",async()=>{
      const id=claims[1]!.environment_id;
      await admin.query("UPDATE sandboxes SET state='degraded',desired_state='running' WHERE id=$1",[id]);
      const result=await claim("gh-123-pr-2");
      assert.equal(result.environment_id,id);
      assert.ok(result.operation_id);
      assert.equal((await admin.query("SELECT operation FROM compute_jobs WHERE id=$1",[result.operation_id])).rows[0].operation,"start");
    });
    await t.test("disabling deletes only the spare after active work ends and never replenishes",async()=>{
      const id=(await spare())!;
      await configure(false);
      await pool.reconcilePreparedPreviews();
      assert.equal((await pool.preparedPreviewStatus(actor,"template")).status,"off");
      assert.equal((await admin.query("SELECT desired_state FROM sandboxes WHERE id=$1",[id])).rows[0].desired_state,"running","active preparation is not interrupted");
      await ready(id);
      await pool.reconcilePreparedPreviews();
      assert.equal((await admin.query("SELECT desired_state FROM sandboxes WHERE id=$1",[id])).rows[0].desired_state,"deleted");
      await admin.query("UPDATE compute_jobs SET status='succeeded' WHERE sandbox_id=$1",[id]);
      await admin.query("UPDATE sandboxes SET state='deleted' WHERE id=$1",[id]);
      await pool.reconcilePreparedPreviews();
      assert.equal(await spare(),null);
      const before=(await admin.query("SELECT count(*)::int AS n FROM sandboxes")).rows[0].n;
      await pool.reconcilePreparedPreviews();
      assert.equal((await admin.query("SELECT count(*)::int AS n FROM sandboxes")).rows[0].n,before);
      assert.equal((await admin.query("SELECT desired_state FROM sandboxes WHERE id=$1",[claims[1]!.environment_id])).rows[0].desired_state,"running","claimed previews survive disabling the spare");
    });
  } finally { await db.end(); await admin.query(`DROP SCHEMA ${schema} CASCADE`); await admin.end(); }
});
