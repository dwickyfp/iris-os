"use client";

import { buttonVariants } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { cn } from "lib/utils";
import { Mail } from "lucide-react";
import { useTranslations } from "next-intl";
import Link from "next/link";

export default function SignUpPage({
  emailAndPasswordEnabled,
  isFirstUser,
}: {
  emailAndPasswordEnabled: boolean;
  isFirstUser: boolean;
}) {
  const t = useTranslations();
  return (
    <Card className="w-full md:max-w-md bg-background border-none mx-auto shadow-none">
      <CardHeader>
        <CardTitle className="text-2xl text-center ">
          {isFirstUser ? t("Auth.SignUp.titleAdmin") : t("Auth.SignUp.title")}
        </CardTitle>
        <CardDescription className="text-center">
          {isFirstUser
            ? t("Auth.SignUp.signUpDescriptionAdmin")
            : t("Auth.SignUp.signUpDescription")}
        </CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-2">
        {emailAndPasswordEnabled && (
          <Link
            href="/sign-up/email"
            data-testid="email-signup-button"
            className={cn(buttonVariants({ variant: "default" }), "w-full")}
          >
            <Mail className="size-4" />
            {t("Auth.SignUp.email")}
          </Link>
        )}
      </CardContent>
    </Card>
  );
}
