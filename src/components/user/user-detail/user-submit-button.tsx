"use client";

import { Loader2 } from "lucide-react";
import { ComponentProps, ReactNode } from "react";
import { useFormStatus } from "react-dom";
import { Button } from "ui/button";

interface SubmitButtonProps extends ComponentProps<typeof Button> {
  children: ReactNode;
}

export function SubmitButton({
  children,
  disabled,
  ...props
}: SubmitButtonProps) {
  const { pending } = useFormStatus();

  return (
    <Button type="submit" disabled={pending || disabled} {...props}>
      {pending && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
      {children}
    </Button>
  );
}
