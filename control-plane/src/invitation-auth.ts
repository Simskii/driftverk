import { APIError, createAuthEndpoint, createAuthMiddleware } from "better-auth/api";
import { setSessionCookie } from "better-auth/cookies";
import type { BetterAuthPlugin } from "better-auth";
import { SignJWT, jwtVerify } from "jose";
import { createHmac } from "node:crypto";
import { config } from "./config.js";
import { db } from "./db.js";

const audience = "driftverk:organization-invitation";
// A separate signing key prevents invitation proofs from being used as generic
// Better Auth verification tokens, which do not check invitation status.
const key = createHmac("sha256", config.betterAuthSecret).update(audience).digest();
export const invitationHeader = "x-driftverk-invitation";

// Invitation IDs are exposed to workspace members. Only the emailed proof can
// establish ownership of the invited address.
export function createInvitationToken(id: string, email: string, expiresAt: Date) {
  return new SignJWT({ email: email.toLowerCase() })
    .setProtectedHeader({ alg: "HS256" })
    .setAudience(audience).setSubject(id)
    .setExpirationTime(Math.floor(expiresAt.getTime() / 1000)).sign(key);
}

async function readInvitation(token: string, email?: unknown) {
  const invalid = () => new APIError("BAD_REQUEST", {
    message: "This invitation link is invalid or has expired. Ask your workspace admin for a new invitation.",
  });
  let claims;
  try {
    claims = (await jwtVerify(token, key, { algorithms: ["HS256"], audience, requiredClaims: ["exp", "sub", "email"] })).payload;
  } catch {
    throw invalid();
  }
  const result = await db.query<{ id: string; email: string; organization_name: string }>(
    `SELECT i.id, i.email, o.name AS organization_name FROM invitations i
     JOIN organizations o ON o.id = i.organization_id
     WHERE i.id = $1 AND lower(i.email) = $2 AND i.status = 'pending' AND i.expires_at > now()`,
    [claims.sub, claims.email],
  );
  const invitation = result.rows[0];
  if (!invitation) throw invalid();
  if (email !== undefined && (typeof email !== "string" || email.toLowerCase() !== invitation.email.toLowerCase())) {
    throw new APIError("FORBIDDEN", { message: "Use the email address this invitation was sent to." });
  }
  return invitation;
}

const isPasswordAuth = (ctx: { path?: string }) => ctx.path === "/sign-up/email" || ctx.path === "/sign-in/email";

export const invitationAuth = {
  id: "driftverk-invitation-auth",
  endpoints: {
    invitationPreview: createAuthEndpoint("/invitation-preview", { method: "GET" }, async (ctx) => {
      ctx.setHeader("Cache-Control", "no-store");
      return ctx.json(await readInvitation(ctx.headers?.get(invitationHeader) ?? ""));
    }),
  },
  hooks: {
    before: [{ matcher: isPasswordAuth, handler: createAuthMiddleware(async (ctx) => {
      const token = ctx.headers?.get(invitationHeader);
      if (!token) return;
      await readInvitation(token, ctx.body?.email);
      if (ctx.path === "/sign-up/email" && await ctx.context.internalAdapter.findUserByEmail(ctx.body.email)) {
        throw new APIError("UNPROCESSABLE_ENTITY", { message: "An account already exists for this email. Sign in below to join the workspace." });
      }
      // Return request-local options; never mutate the shared auth configuration.
      return { context: { context: { options: {
        // Production disables open registration, but a signed invitation is
        // an explicit authorization to create the invited account.
        emailAndPassword: { disableSignUp: false, requireEmailVerification: false },
        emailVerification: { sendOnSignUp: false, sendOnSignIn: false },
      } } } };
    }) }],
    after: [{ matcher: isPasswordAuth, handler: createAuthMiddleware(async (ctx) => {
      const token = ctx.headers?.get(invitationHeader);
      const signedIn = ctx.context.newSession;
      if (!token || !signedIn) return;
      await readInvitation(token, signedIn.user.email);
      // Existing accounts must successfully authenticate before being verified.
      const user = await ctx.context.internalAdapter.updateUser(signedIn.user.id, { emailVerified: true });
      await setSessionCookie(ctx, { session: signedIn.session, user }, ctx.body?.rememberMe === false);
      return ctx.json({ ...ctx.context.returned as object, user });
    }) }],
  },
} satisfies BetterAuthPlugin;
