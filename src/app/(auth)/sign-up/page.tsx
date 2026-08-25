import SignUpPage from "@/components/auth/sign-up";
import { getDatabaseAuthConfig } from "auth/config.server";
import { getIsFirstUser } from "lib/auth/server";
import { redirect } from "next/navigation";

export default async function SignUp() {
  const isFirstUser = await getIsFirstUser();
  const {
    emailAndPasswordEnabled,
    socialAuthenticationProviders,
    signUpEnabled,
  } = await getDatabaseAuthConfig();

  if (!signUpEnabled) {
    redirect("/sign-in");
  }

  const enabledProviders = (
    Object.keys(
      socialAuthenticationProviders,
    ) as (keyof typeof socialAuthenticationProviders)[]
  ).filter((key) => socialAuthenticationProviders[key]);

  if (emailAndPasswordEnabled && enabledProviders.length === 0) {
    redirect("/sign-up/email");
  }

  return (
    <SignUpPage
      isFirstUser={isFirstUser}
      emailAndPasswordEnabled={emailAndPasswordEnabled}
      socialAuthenticationProviders={enabledProviders}
    />
  );
}
