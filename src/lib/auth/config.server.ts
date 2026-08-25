import "server-only";

import type { AuthConfig } from "app-types/authentication";
import { AuthConfigSchema } from "app-types/authentication";
import { systemSettingsService } from "lib/system-settings/server";

export async function getDatabaseAuthConfig(): Promise<AuthConfig> {
  const [
    emailAndPasswordEnabled,
    signUpEnabled,
    oauthSignUpEnabled,
    githubClientId,
    githubClientSecret,
    googleClientId,
    googleClientSecret,
    googleForceAccountSelection,
    microsoftClientId,
    microsoftClientSecret,
    microsoftTenantId,
    microsoftForceAccountSelection,
  ] = await Promise.all([
    systemSettingsService.getPlain("auth.emailSignInEnabled"),
    systemSettingsService.getPlain("auth.emailSignUpEnabled"),
    systemSettingsService.getPlain("auth.oauthSignUpEnabled"),
    systemSettingsService.getPlain("oauth.github.clientId"),
    systemSettingsService.getSecret("oauth.github.clientSecret"),
    systemSettingsService.getPlain("oauth.google.clientId"),
    systemSettingsService.getSecret("oauth.google.clientSecret"),
    systemSettingsService.getPlain("oauth.google.forceAccountSelection"),
    systemSettingsService.getPlain("oauth.microsoft.clientId"),
    systemSettingsService.getSecret("oauth.microsoft.clientSecret"),
    systemSettingsService.getPlain("oauth.microsoft.tenantId"),
    systemSettingsService.getPlain("oauth.microsoft.forceAccountSelection"),
  ]);
  const socialAuthenticationProviders: AuthConfig["socialAuthenticationProviders"] = {};
  if (typeof githubClientId === "string" && githubClientSecret)
    socialAuthenticationProviders.github = {
      clientId: githubClientId,
      clientSecret: githubClientSecret,
      disableSignUp: !oauthSignUpEnabled,
    };
  if (typeof googleClientId === "string" && googleClientSecret)
    socialAuthenticationProviders.google = {
      clientId: googleClientId,
      clientSecret: googleClientSecret,
      ...(googleForceAccountSelection ? { prompt: "select_account" as const } : {}),
      disableSignUp: !oauthSignUpEnabled,
    };
  if (typeof microsoftClientId === "string" && microsoftClientSecret)
    socialAuthenticationProviders.microsoft = {
      clientId: microsoftClientId,
      clientSecret: microsoftClientSecret,
      tenantId: String(microsoftTenantId || "common"),
      ...(microsoftForceAccountSelection ? { prompt: "select_account" as const } : {}),
      disableSignUp: !oauthSignUpEnabled,
    };
  return AuthConfigSchema.parse({
    emailAndPasswordEnabled,
    signUpEnabled,
    socialAuthenticationProviders,
  });
}
