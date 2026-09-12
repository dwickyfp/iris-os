import { AuthConfig, AuthConfigSchema } from "app-types/authentication";
import { parseEnvBoolean } from "../utils";

// Static authentication configuration. Sign-in/sign-up access is controlled
// with DISABLE_EMAIL_SIGN_IN / DISABLE_EMAIL_SIGN_UP environment variables.
export function getAuthConfig(
  env: Record<string, string | undefined> = {},
): AuthConfig {
  const result = AuthConfigSchema.safeParse({
    emailAndPasswordEnabled: env.DISABLE_EMAIL_SIGN_IN
      ? !parseEnvBoolean(env.DISABLE_EMAIL_SIGN_IN)
      : true,
    signUpEnabled: env.DISABLE_EMAIL_SIGN_UP
      ? !parseEnvBoolean(env.DISABLE_EMAIL_SIGN_UP)
      : true,
  });

  if (!result.success) {
    throw new Error(`Invalid auth configuration: ${result.error.message}`);
  }

  return result.data;
}
