import SignIn from "@/components/auth/sign-in";
import { getDatabaseAuthConfig } from "lib/auth/config.server";
import { getIsFirstUser } from "lib/auth/server";

export default async function SignInPage() {
  const isFirstUser = await getIsFirstUser();
  const {
    emailAndPasswordEnabled,
    signUpEnabled,
    socialAuthenticationProviders,
  } = await getDatabaseAuthConfig();
  const enabledProviders = (
    Object.keys(
      socialAuthenticationProviders,
    ) as (keyof typeof socialAuthenticationProviders)[]
  ).filter((key) => socialAuthenticationProviders[key]);
  return (
    <SignIn
      emailAndPasswordEnabled={emailAndPasswordEnabled}
      signUpEnabled={signUpEnabled}
      socialAuthenticationProviders={enabledProviders}
      isFirstUser={isFirstUser}
    />
  );
}
