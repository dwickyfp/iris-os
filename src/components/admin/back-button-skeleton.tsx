import { ArrowLeft } from "lucide-react";
import { Button } from "ui/button";

export function BackButtonSkeleton() {
  return (
    <Button
      variant="ghost"
      size="sm"
      className="hover:bg-muted opacity-50 cursor-not-allowed"
      disabled
    >
      <ArrowLeft className="mr-2 h-4 w-4" />
      Back to Users
    </Button>
  );
}
