import { createContext, useContext } from "react";

export type Installation = {
  installationMode: "hosted" | "self-hosted";
  allowSignUp: boolean;
  requireEmailVerification: boolean;
  termsVersion: string | null;
  termsUrl: string | null;
  privacyUrl: string | null;
};
export const InstallationContext = createContext<Installation | null>(null);
export function useInstallation() {
  const value = useContext(InstallationContext);
  if (!value) throw new Error("Installation configuration is not loaded");
  return value;
}
