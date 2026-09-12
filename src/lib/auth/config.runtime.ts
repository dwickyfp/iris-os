import type { AuthConfig } from "app-types/authentication";
import { AuthConfigSchema } from "app-types/authentication";
import { runtimeSystemSetting } from "lib/system-settings/runtime";

export function getRuntimeAuthConfig(): AuthConfig {
  const socialAuthenticationProviders: AuthConfig["socialAuthenticationProviders"] =
    {};
  const oauthEnabled = runtimeSystemSetting("auth.oauthSignUpEnabled") === true;
  const githubId = runtimeSystemSetting("oauth.github.clientId");
  const githubSecret = runtimeSystemSetting("oauth.github.clientSecret");
  if (typeof githubId === "string" && typeof githubSecret === "string")
    socialAuthenticationProviders.github = {
      clientId: githubId,
      clientSecret: githubSecret,
      disableSignUp: !oauthEnabled,
    };
  const googleId = runtimeSystemSetting("oauth.google.clientId");
  const googleSecret = runtimeSystemSetting("oauth.google.clientSecret");
  if (typeof googleId === "string" && typeof googleSecret === "string")
    socialAuthenticationProviders.google = {
      clientId: googleId,
      clientSecret: googleSecret,
      ...(runtimeSystemSetting("oauth.google.forceAccountSelection")
        ? { prompt: "select_account" as const }
        : {}),
      disableSignUp: !oauthEnabled,
    };
  const microsoftId = runtimeSystemSetting("oauth.microsoft.clientId");
  const microsoftSecret = runtimeSystemSetting("oauth.microsoft.clientSecret");
  if (typeof microsoftId === "string" && typeof microsoftSecret === "string")
    socialAuthenticationProviders.microsoft = {
      clientId: microsoftId,
      clientSecret: microsoftSecret,
      tenantId: String(runtimeSystemSetting("oauth.microsoft.tenantId")),
      ...(runtimeSystemSetting("oauth.microsoft.forceAccountSelection")
        ? { prompt: "select_account" as const }
        : {}),
      disableSignUp: !oauthEnabled,
    };
  return AuthConfigSchema.parse({
    emailAndPasswordEnabled:
      runtimeSystemSetting("auth.emailSignInEnabled") === true,
    signUpEnabled: runtimeSystemSetting("auth.emailSignUpEnabled") === true,
    socialAuthenticationProviders,
  });
}
