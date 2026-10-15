import type { Session, User } from "better-auth";
import type { ApiPrincipal } from "./api-keys.js";

export type AuthSession = {
  session: Session & { activeOrganizationId?: string | null };
  user: User & { isPlatformAdmin: boolean };
};

export type AppEnv = {
  Variables: {
    nonce: string;
    requestId: string;
    authSession: AuthSession;
    apiPrincipal: ApiPrincipal;
    computeAgent: { id: string; organizationId: string | null; managed: boolean };
  };
};
