import { config } from "./config.js";
import { db } from "./db.js";
import { sendBillingEmail } from "./email.js";

export async function deliverBillingNotifications(send = sendBillingEmail) {
  if (config.selfHosted) return;
  const client = await db.connect();
  let locked = false;
  try {
    // One sender across replicas; email failures must not block compute stops.
    locked = (await client.query("SELECT pg_try_advisory_lock(1154680720) AS locked")).rows[0].locked;
    if (!locked) return;
    await client.query(`UPDATE billing_accounts b SET
      low_balance_notice=CASE WHEN balance_ore>0 AND balance_ore<500 THEN COALESCE(low_balance_notice,gen_random_uuid()) ELSE low_balance_notice END,
      empty_balance_notice=CASE WHEN balance_ore<=0 THEN COALESCE(empty_balance_notice,gen_random_uuid()) ELSE empty_balance_notice END
      FROM organizations o WHERE o.id=b.organization_id AND o.hosting_mode='managed' AND NOT b.complimentary AND b.currency='usd'
      AND EXISTS(SELECT 1 FROM billing_ledger l WHERE l.organization_id=b.organization_id AND l.amount_ore>0)`);
    await client.query(`INSERT INTO billing_notifications(notice_id,organization_id,user_id,kind,email,organization_name,balance_ore)
      SELECT CASE WHEN b.balance_ore<=0 THEN b.empty_balance_notice ELSE b.low_balance_notice END,b.organization_id,m.user_id,
        CASE WHEN b.balance_ore<=0 THEN 'empty' ELSE 'low' END,u.email,o.name,b.balance_ore
      FROM billing_accounts b JOIN organizations o ON o.id=b.organization_id
      JOIN memberships m ON m.organization_id=b.organization_id AND m.role='admin'
      JOIN "user" u ON u.id=m.user_id AND u."emailVerified"
      WHERE NOT b.complimentary AND o.hosting_mode='managed' AND b.currency='usd' AND b.balance_ore<500
        AND CASE WHEN b.balance_ore<=0 THEN b.empty_balance_notice ELSE b.low_balance_notice END IS NOT NULL
      ON CONFLICT DO NOTHING`);
    const pending = await client.query(`SELECT n.notice_id,n.user_id,n.kind,n.organization_name AS name,n.email,n.balance_ore
      FROM billing_notifications n JOIN billing_accounts b ON b.organization_id=n.organization_id
      JOIN organizations o ON o.id=n.organization_id
      JOIN memberships m ON m.organization_id=n.organization_id AND m.user_id=n.user_id AND m.role='admin'
      JOIN "user" u ON u.id=n.user_id AND u."emailVerified" AND u.email=n.email
      WHERE n.sent_at IS NULL AND (n.attempted_at IS NULL OR n.attempted_at<now()-interval '5 minutes')
        AND NOT b.complimentary AND o.hosting_mode='managed' AND b.currency='usd'
        AND ((n.kind='low' AND n.notice_id=b.low_balance_notice AND b.balance_ore>0 AND b.balance_ore<500)
          OR (n.kind='empty' AND n.notice_id=b.empty_balance_notice AND b.balance_ore<=0))
      ORDER BY n.attempted_at NULLS FIRST,n.created_at LIMIT 50`);
    for (const notice of pending.rows) {
      await client.query("UPDATE billing_notifications SET attempted_at=now() WHERE notice_id=$1 AND user_id=$2",[notice.notice_id,notice.user_id]);
      try {
        await send({email:notice.email,organizationName:notice.name,balance:Number(notice.balance_ore),kind:notice.kind,idempotencyKey:`billing-${notice.notice_id}-${notice.user_id}`});
        await client.query("UPDATE billing_notifications SET sent_at=now() WHERE notice_id=$1 AND user_id=$2",[notice.notice_id,notice.user_id]);
      } catch (error) {
        console.error(JSON.stringify({event:"billing_email_failed",notice_id:notice.notice_id,message:error instanceof Error ? error.message : String(error)}));
      }
    }
  } finally {
    if (locked) await client.query("SELECT pg_advisory_unlock(1154680720)").catch(()=>{});
    client.release();
  }
}
