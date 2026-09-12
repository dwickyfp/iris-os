import { getAuthConfig } from "lib/auth/config";
import { redirect } from "next/navigation";

export default async function SignUp() {
  const { emailAndPasswordEnabled, signUpEnabled } = getAuthConfig(process.env);

  if (!signUpEnabled) {
    redirect("/sign-in");
  }

  if (emailAndPasswordEnabled) {
    redirect("/sign-up/email");
  }

  // Email sign-up is the only sign-up method; without it there is nothing to show.
  redirect("/sign-in");
}
