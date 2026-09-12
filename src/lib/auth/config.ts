import {
  AuthConfig,
  AuthConfigSchema,
  GitHubConfig,
  GitHubConfigSchema,
  GoogleConfig,
  GoogleConfigSchema,
  MicrosoftConfig,
  MicrosoftConfigSchema,
} from "app-types/authentication";
// Conditionally import React taint
let experimental_taintUniqueValue: any = () => {};
try {
  // Only use taint in Next.js runtime
  if (typeof window !== "undefined" || process.env.NEXT_RUNTIME) {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const react = require("react");
    experimental_taintUniqueValue = react.experimental_taintUniqueValue;
  }
} catch (_e) {
  // No-op for non-React contexts
}
import { parseEnvBoolean } from "../utils";

function parseSocialAuthConfigs(env: Record<string, string | undefined>) {
  const configs: {
    github?: GitHubConfig;
    google?: GoogleConfig;
    microsoft?: MicrosoftConfig;
  } = {};
  // DISABLE_SIGN_UP only applies to OAuth signups, not email signups
  const disableSignUp = parseEnvBoolean(env.DISABLE_SIGN_UP);

  if (env.GITHUB_CLIENT_ID && env.GITHUB_CLIENT_SECRET) {
    const githubResult = GitHubConfigSchema.safeParse({
      clientId: env.GITHUB_CLIENT_ID,
      clientSecret: env.GITHUB_CLIENT_SECRET,
      disableSignUp,
    });
    if (githubResult.success) {
      configs.github = githubResult.data;
      experimental_taintUniqueValue(
        "Do not pass GITHUB_CLIENT_SECRET to the client",
        configs,
        configs.github.clientSecret,
      );
    }
  }

  if (env.GOOGLE_CLIENT_ID && env.GOOGLE_CLIENT_SECRET) {
    const forceAccountSelection = parseEnvBoolean(
      env.GOOGLE_FORCE_ACCOUNT_SELECTION,
    );

    const googleConfig: GoogleConfig = {
      clientId: env.GOOGLE_CLIENT_ID,
      clientSecret: env.GOOGLE_CLIENT_SECRET,
      ...(forceAccountSelection && { prompt: "select_account" as const }),
      disableSignUp,
    };

    const googleResult = GoogleConfigSchema.safeParse(googleConfig);
    if (googleResult.success) {
      configs.google = googleResult.data;
      experimental_taintUniqueValue(
        "Do not pass GOOGLE_CLIENT_SECRET to the client",
        configs,
        configs.google.clientSecret,
      );
    }
  }

  if (env.MICROSOFT_CLIENT_ID && env.MICROSOFT_CLIENT_SECRET) {
    const forceAccountSelection = parseEnvBoolean(
      env.MICROSOFT_FORCE_ACCOUNT_SELECTION,
    );
    const tenantId = env.MICROSOFT_TENANT_ID || "common";

    const microsoftConfig: MicrosoftConfig = {
      clientId: env.MICROSOFT_CLIENT_ID,
      clientSecret: env.MICROSOFT_CLIENT_SECRET,
      tenantId,
      ...(forceAccountSelection && { prompt: "select_account" as const }),
      disableSignUp,
    };

    const microsoftResult = MicrosoftConfigSchema.safeParse(microsoftConfig);
    if (microsoftResult.success) {
      configs.microsoft = microsoftResult.data;
      experimental_taintUniqueValue(
        "Do not pass MICROSOFT_CLIENT_SECRET to the client",
        configs,
        configs.microsoft.clientSecret,
      );
    }
  }

  return configs;
}

export function getAuthConfig(
  env: Record<string, string | undefined> = {},
): AuthConfig {
  const rawConfig = {
    emailAndPasswordEnabled: env.DISABLE_EMAIL_SIGN_IN
      ? !parseEnvBoolean(env.DISABLE_EMAIL_SIGN_IN)
      : true,
    // signUpEnabled now only applies to email signups
    // OAuth signups are controlled separately via DISABLE_SIGN_UP in parseSocialAuthConfigs
    signUpEnabled: env.DISABLE_EMAIL_SIGN_UP
      ? !parseEnvBoolean(env.DISABLE_EMAIL_SIGN_UP)
      : true,
    socialAuthenticationProviders: parseSocialAuthConfigs(env),
  };

  const result = AuthConfigSchema.safeParse(rawConfig);

  if (!result.success) {
    throw new Error(`Invalid auth configuration: ${result.error.message}`);
  }

  return result.data;
}
