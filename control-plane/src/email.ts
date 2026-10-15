import { Resend } from "resend";
import { config } from "./config.js";
import { createInvitationToken } from "./invitation-auth.js";

type Message = {
  to: string;
  subject: string;
  text: string;
  html: string;
  idempotencyKey: string;
};

const resend = config.resendApiKey ? new Resend(config.resendApiKey) : null;

export async function sendEmail(message: Message): Promise<void> {
  if (config.emailMode === "console") {
    console.info(
      JSON.stringify({
        event: "email_preview",
        to: message.to,
        subject: message.subject,
        text: message.text,
      }),
    );
    return;
  }
  if (!resend) throw new Error("Resend is not configured");
  const { error } = await resend.emails.send(
    {
      from: config.emailFrom,
      to: message.to,
      subject: message.subject,
      text: message.text,
      html: message.html,
    },
    { idempotencyKey: message.idempotencyKey },
  );
  if (error) throw new Error(`Resend rejected the email: ${error.message}`);
}

function escapeHtml(value: string): string {
  return value.replace(
    /[&<>'"]/g,
    (character) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", "'": "&#39;", '"': "&quot;" })[
        character
      ] ?? character,
  );
}

type EmailTemplate = {
  preheader: string;
  heading: string;
  body: string;
  actionLabel: string;
  actionUrl: string;
  footnote: string;
};

function renderEmail(template: EmailTemplate): string {
  const preheader = escapeHtml(template.preheader);
  const heading = escapeHtml(template.heading);
  const actionLabel = escapeHtml(template.actionLabel);
  const actionUrl = escapeHtml(template.actionUrl);
  const footnote = escapeHtml(template.footnote);

  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <meta name="x-apple-disable-message-reformatting">
    <title>${heading}</title>
  </head>
  <body style="margin:0;background:#f3f6f4;color:#10231e;font-family:Inter,-apple-system,BlinkMacSystemFont,'Segoe UI',Arial,sans-serif;">
    <div style="display:none;max-height:0;overflow:hidden;opacity:0;color:transparent;">${preheader}</div>
    <table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0" style="width:100%;background:#f3f6f4;">
      <tr>
        <td align="center" style="padding:40px 16px;">
          <table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0" style="width:100%;max-width:600px;">
            <tr>
              <td style="padding:0 4px 20px;font-size:24px;font-weight:750;letter-spacing:-0.7px;color:#10231e;">
                Driftverk<span style="color:#155f46;">.</span>
              </td>
            </tr>
            <tr>
              <td style="overflow:hidden;border:1px solid #dce4df;border-radius:14px;background:#ffffff;">
                <div style="height:6px;background:#d9ff66;font-size:0;line-height:0;">&nbsp;</div>
                <div style="padding:40px 40px 36px;">
                  <h1 style="margin:0 0 20px;font-size:28px;line-height:1.2;letter-spacing:-0.7px;color:#10231e;">${heading}</h1>
                  <div style="font-size:16px;line-height:1.65;color:#43534d;">${template.body}</div>
                  <table role="presentation" cellspacing="0" cellpadding="0" border="0" style="margin:28px 0;">
                    <tr>
                      <td style="border-radius:8px;background:#155f46;">
                        <a href="${actionUrl}" style="display:inline-block;padding:13px 20px;color:#ffffff;font-size:15px;font-weight:700;line-height:1.2;text-decoration:none;">${actionLabel}</a>
                      </td>
                    </tr>
                  </table>
                  <p style="margin:0;font-size:13px;line-height:1.55;color:#6b7974;">${footnote}</p>
                  <p style="margin:24px 0 0;padding-top:20px;border-top:1px solid #e7ece9;font-size:12px;line-height:1.55;color:#7a8782;word-break:break-all;">
                    If the button does not work, copy this link:<br>
                    <a href="${actionUrl}" style="color:#155f46;text-decoration:underline;">${actionUrl}</a>
                  </p>
                </div>
              </td>
            </tr>
            <tr>
              <td style="padding:18px 4px 0;font-size:12px;line-height:1.5;color:#74817c;">
                Driftverk &middot; Infrastructure without the busywork
              </td>
            </tr>
          </table>
        </td>
      </tr>
    </table>
  </body>
</html>`;
}

export async function sendBillingEmail(input: { email: string; organizationName: string; balance: number; kind: "low" | "empty"; idempotencyKey: string }): Promise<void> {
  const empty = input.kind === "empty";
  const balance = new Intl.NumberFormat("en-US", {style:"currency",currency:"USD"}).format(Math.max(0,input.balance)/100);
  const heading = empty ? "Your Cloud balance is empty" : "Your Cloud balance is running low";
  const text = empty
    ? `${input.organizationName} has no available Cloud credit. New starts and connections are blocked, and running environments are queued to stop. Add funds, then restart your environments. Billing does not delete your files; any automatic-deletion timers you configured still apply.`
    : `${input.organizationName} has ${balance} in Cloud credit remaining. Add funds to keep your environments running. Top-ups are manual.`;
  const url = new URL("/billing",config.betterAuthUrl).toString();
  await sendEmail({to:input.email,subject:`${heading}: ${input.organizationName}`,text:`${text}\n\nOpen Billing for ${input.organizationName}: ${url}`,html:renderEmail({preheader:heading,heading,body:`<p>${escapeHtml(text)}</p>`,actionLabel:"Open Billing",actionUrl:url,footnote:`You receive this because you administer ${input.organizationName}. Select that organization when opening Billing.`}),idempotencyKey:input.idempotencyKey});
}

export async function sendSignupNotificationEmail(input: {
  userId: string;
  email: string;
  name: string;
  createdAt: Date;
}): Promise<void> {
  if (!config.signupNotificationEmail) return;
  const adminUrl = new URL("/admin/organizations", config.betterAuthUrl).toString();
  const name = input.name || "No name provided";
  const safeName = escapeHtml(name);
  const safeEmail = escapeHtml(input.email);
  const createdAt = input.createdAt.toISOString();
  await sendEmail({
    to: config.signupNotificationEmail,
    subject: `New Driftverk signup: ${name}`,
    text: `A new user signed up for Driftverk.\n\nName: ${name}\nEmail: ${input.email}\nSigned up: ${createdAt}\n\nOpen Driftverk admin: ${adminUrl}`,
    html: renderEmail({
      preheader: `${name} signed up for Driftverk.`,
      heading: "New Driftverk signup",
      body: `<p style="margin:0 0 12px;"><strong style="color:#10231e;">${safeName}</strong> created an account.</p><p style="margin:0;"><a href="mailto:${safeEmail}" style="color:#155f46;text-decoration:underline;">${safeEmail}</a><br>Signed up ${escapeHtml(createdAt)}</p>`,
      actionLabel: "Open Driftverk admin",
      actionUrl: adminUrl,
      footnote: "This is an internal signup notification.",
    }),
    idempotencyKey: `signup-notification-${input.userId}`.slice(0, 256),
  });
}

export async function sendVerificationEmail(input: {
  email: string;
  name: string;
  url: string;
  token: string;
}): Promise<void> {
  const safeName = escapeHtml(input.name || input.email);
  await sendEmail({
    to: input.email,
    subject: "Verify your Driftverk account",
    text: `Verify your Driftverk account: ${input.url}`,
    html: renderEmail({
      preheader: "Verify your email address to finish setting up Driftverk.",
      heading: "Verify your email",
      body: `<p style="margin:0 0 12px;">Hi ${safeName},</p><p style="margin:0;">Verify your email address to finish setting up your Driftverk account.</p>`,
      actionLabel: "Verify email",
      actionUrl: input.url,
      footnote: "This link expires in one hour.",
    }),
    idempotencyKey: `verify-${input.token}`.slice(0, 256),
  });
}

export async function sendPasswordResetEmail(input: {
  email: string;
  name: string;
  url: string;
  token: string;
}): Promise<void> {
  const safeName = escapeHtml(input.name || input.email);
  await sendEmail({
    to: input.email,
    subject: "Reset your Driftverk password",
    text: `Reset your Driftverk password: ${input.url}`,
    html: renderEmail({
      preheader: "Choose a new password for your Driftverk account.",
      heading: "Reset your password",
      body: `<p style="margin:0 0 12px;">Hi ${safeName},</p><p style="margin:0;">Use the button below to choose a new password for your Driftverk account.</p>`,
      actionLabel: "Reset password",
      actionUrl: input.url,
      footnote: "This link expires in one hour. If you did not request a new password, you can ignore this email.",
    }),
    idempotencyKey: `password-reset-${input.token}`.slice(0, 256),
  });
}

export async function sendOrganizationInvitationEmail(input: {
  email: string;
  inviterName: string;
  organizationName: string;
  invitationId: string;
  expiresAt: Date;
}): Promise<void> {
  const url = new URL("/accept-invitation", config.betterAuthUrl);
  url.searchParams.set("id", input.invitationId);
  url.searchParams.set("token", await createInvitationToken(input.invitationId, input.email, input.expiresAt));
  const safeInviterName = escapeHtml(input.inviterName);
  const safeOrganizationName = escapeHtml(input.organizationName);
  await sendEmail({
    to: input.email,
    subject: `Join ${input.organizationName} on Driftverk`,
    text: `${input.inviterName} invited you to join ${input.organizationName} on Driftverk: ${url}`,
    html: renderEmail({
      preheader: `${input.inviterName} invited you to join ${input.organizationName} on Driftverk.`,
      heading: `Join ${input.organizationName}`,
      body: `<p style="margin:0;"><strong style="color:#10231e;">${safeInviterName}</strong> invited you to join <strong style="color:#10231e;">${safeOrganizationName}</strong> on Driftverk.</p>`,
      actionLabel: "Accept invitation",
      actionUrl: url.toString(),
      footnote: "This invitation expires in 48 hours.",
    }),
    idempotencyKey: `organization-invitation-${input.invitationId}`.slice(0, 256),
  });
}
