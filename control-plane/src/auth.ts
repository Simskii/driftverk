import { betterAuth } from "better-auth";
import { APIError, createAuthMiddleware, getSessionFromCtx } from "better-auth/api";
import type { BetterAuthPlugin } from "better-auth";
import { cimd } from "@better-auth/cimd";
import { mcp } from "@better-auth/mcp";
import { bearer, deviceAuthorization, jwt, organization } from "better-auth/plugins";
import { config } from "./config.js";
import { fetchClientMetadataResource } from "./cimd-fetch.js";
import { db } from "./db.js";
import { oauthWorkspaceFor } from "./oauth-workspace.js";
import { invitationAuth } from "./invitation-auth.js";
import {
  sendOrganizationInvitationEmail,
  sendPasswordResetEmail,
  sendSignupNotificationEmail,
  sendVerificationEmail,
} from "./email.js";

export const auth = betterAuth({
  appName: "Driftverk",
  baseURL: config.betterAuthUrl,
  secret: config.betterAuthSecret,
  trustedOrigins: config.trustedOrigins,
  database: db,
  rateLimit: {
    customRules: {
      "/device/code": { window: 60, max: 10 },
      "/device/approve": { window: 60, max: 10 },
      "/device/deny": { window: 60, max: 10 },
    },
  },
  user: {
    additionalFields: {
      termsVersion: { type: "string", required: false, input: false, fieldName: "terms_version" },
      termsAcceptedAt: { type: "date", required: false, input: false, fieldName: "terms_accepted_at" },
      isPlatformAdmin: {
        type: "boolean",
        required: true,
        defaultValue: false,
        input: false,
        fieldName: "is_platform_admin",
      },
    },
  },
  databaseHooks: {
    user: {
      create: {
        before: async (user, context) => {
          if (!config.termsVersion) return { data: user };
          if (context?.body?.acceptedTerms !== true || context.body.acceptedTermsVersion !== config.termsVersion) {
            throw new APIError("BAD_REQUEST", { message: "Accept the current Terms of service to create an account." });
          }
          return { data: { ...user, termsVersion: config.termsVersion, termsAcceptedAt: new Date() } };
        },
        after: async (user) => {
          try {
            await sendSignupNotificationEmail({
              userId: user.id,
              email: user.email,
              name: user.name,
              createdAt: user.createdAt,
            });
          } catch (error) {
            console.error(JSON.stringify({
              event: "signup_notification_failed",
              userId: user.id,
              error: error instanceof Error ? error.message : String(error),
            }));
          }
        },
      },
    },
  },
  emailAndPassword: {
    enabled: true,
    disableSignUp: !config.allowSignUp,
    requireEmailVerification: config.requireEmailVerification,
    minPasswordLength: 12,
    maxPasswordLength: 128,
    revokeSessionsOnPasswordReset: true,
    resetPasswordTokenExpiresIn: 60 * 60,
    sendResetPassword: async ({ user, url, token }) => {
      await sendPasswordResetEmail({
        email: user.email,
        name: user.name,
        url,
        token,
      });
    },
  },
  emailVerification: {
    sendOnSignUp: true,
    sendOnSignIn: true,
    autoSignInAfterVerification: true,
    expiresIn: 60 * 60,
    sendVerificationEmail: async ({ user, url, token }) => {
      await sendVerificationEmail({
        email: user.email,
        name: user.name,
        url,
        token,
      });
    },
  },
  plugins: [
    invitationAuth,
    bearer(),
    {
      id: "driftverk-cli-verification",
      hooks: {
        before: [{
          matcher: (ctx) => ctx.path?.replace(/\/+$/, "") === "/device/approve",
          handler: createAuthMiddleware(async (ctx) => {
            const session = await getSessionFromCtx(ctx);
            if (!session) throw new APIError("UNAUTHORIZED", { message: "Sign in to connect the CLI." });
            if (!session.user.emailVerified) throw new APIError("FORBIDDEN", { message: "Verify your email before connecting the CLI." });
          }),
        }],
      },
    },
    deviceAuthorization({
      verificationUri: "/cli",
      expiresIn: "10m",
      interval: "5s",
      validateClient: (clientId) => clientId === "driftverk-cli",
    }),
    jwt(),
    mcp({
      loginPage: "/sign-in",
      consentPage: "/oauth/consent",
      resource: new URL("/mcp", config.betterAuthUrl).toString(),
      scopes: ["mcp:read", "mcp:write", "mcp:delete", "offline_access"],
      grantTypes: ["authorization_code", "refresh_token"],
      accessTokenExpiresIn: 60 * 60,
      refreshTokenExpiresIn: 30 * 24 * 60 * 60,
      postLogin: {
        page: "/oauth/consent",
        shouldRedirect: async () => false,
        consentReferenceId: async ({ user, session }) => {
          const activeOrganizationId = typeof session.activeOrganizationId === "string"
            ? session.activeOrganizationId
            : null;
          const workspace = await oauthWorkspaceFor(user.id, activeOrganizationId);
          if (!workspace) throw new Error("A Driftverk organization membership is required");
          return workspace.organization_id;
        },
      },
      customAccessTokenClaims: async ({ user, referenceId }) => ({
        organization_id: referenceId,
        driftverk_user_id: user?.id,
      }),
    }) as unknown as BetterAuthPlugin,
    cimd({
      fetchClientMetadataResource,
      metadataProfile: "mcp-2026-07-28",
    }),
    organization({
      organizationHooks: {
        beforeCreateOrganization: async ({ user }) => {
          if (!user.emailVerified) throw new APIError("FORBIDDEN", { message: "Verify your email before creating an organization" });
        },
        beforeUpdateOrganization: async ({ organization: changes }) => {
          if (changes.hostingMode !== undefined) throw new APIError("BAD_REQUEST", { message: "Change hosting from Compute hosts" });
        },
      },
      allowUserToCreateOrganization: true,
      creatorRole: "admin",
      invitationExpiresIn: 48 * 60 * 60,
      cancelPendingInvitationsOnReInvite: true,
      requireEmailVerificationOnInvitation: true,
      schema: {
        session: {
          fields: { activeOrganizationId: "active_organization_id" },
        },
        organization: {
          modelName: "organizations",
          additionalFields: {
            hostingMode: { type: ["managed", "hybrid"], required: false, defaultValue: "managed", fieldName: "hosting_mode" },
          },
          fields: {
            name: "name",
            slug: "slug",
            logo: "logo",
            createdAt: "created_at",
            updatedAt: "updated_at",
          },
        },
        member: {
          modelName: "memberships",
          fields: {
            organizationId: "organization_id",
            userId: "user_id",
            role: "role",
            createdAt: "created_at",
          },
        },
        invitation: {
          modelName: "invitations",
          fields: {
            organizationId: "organization_id",
            email: "email",
            role: "role",
            status: "status",
            expiresAt: "expires_at",
            createdAt: "created_at",
            inviterId: "inviter_id",
          },
        },
      },
      sendInvitationEmail: async ({ id, email, organization: invitedOrganization, inviter, invitation }) => {
        await sendOrganizationInvitationEmail({
          email,
          inviterName: inviter.user.name || inviter.user.email,
          organizationName: invitedOrganization.name,
          invitationId: id,
          expiresAt: invitation.expiresAt,
        });
      },
    }),
  ],
  advanced: {
    useSecureCookies: config.nodeEnv === "production",
    trustedProxyHeaders: config.nodeEnv === "production",
  },
});
