import SignIn from "@/components/auth/sign-in";
import { getAuthConfig } from "lib/auth/config";
import { getIsFirstUser } from "lib/auth/server";

export default async function SignInPage() {
  const isFirstUser = await getIsFirstUser();
  const { emailAndPasswordEnabled, signUpEnabled } = getAuthConfig(process.env);
  return (
    <SignIn
      emailAndPasswordEnabled={emailAndPasswordEnabled}
      signUpEnabled={signUpEnabled}
      isFirstUser={isFirstUser}
    />
  );
}
