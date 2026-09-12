"use client";

import { TriangleAlertIcon } from "lucide-react";
import { useEffect } from "react";
import { Button } from "ui/button";

/**
 * Route-level error boundary: a render crash no longer takes down the whole
 * app shell with the default framework screen.
 */
export default function Error({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  useEffect(() => {
    console.error("Route error boundary", error);
  }, [error]);

  return (
    <div className="flex flex-col items-center justify-center min-h-[60dvh] gap-4 px-6 text-center">
      <div className="p-3 bg-muted rounded-full">
        <TriangleAlertIcon className="h-6 w-6 text-destructive" />
      </div>
      <div>
        <h2 className="text-lg font-semibold">Something went wrong</h2>
        <p className="text-sm text-muted-foreground mt-1">
          An unexpected error occurred while rendering this page.
        </p>
        {error.digest && (
          <p className="text-xs text-muted-foreground mt-2 font-mono">
            digest: {error.digest}
          </p>
        )}
      </div>
      <Button onClick={reset}>Try again</Button>
    </div>
  );
}
