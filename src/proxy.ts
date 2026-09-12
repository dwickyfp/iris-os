import { getSessionCookie } from "better-auth/cookies";
import { MUTATING_METHODS, isAllowedOrigin } from "lib/security/same-origin";
import { type NextRequest, NextResponse } from "next/server";

export async function proxy(request: NextRequest) {
  const { pathname } = request.nextUrl;

  /*
   * Playwright starts the dev server and requires a 200 status to
   * begin the tests, so this ensures that the tests can start
   */
  if (pathname.startsWith("/ping")) {
    return new Response("pong", { status: 200 });
  }

  if (pathname === "/admin") {
    return NextResponse.redirect(new URL("/admin/users", request.url));
  }

  // CSRF defense for state-changing API calls: cross-origin browser
  // requests carry an Origin that differs from the serving host.
  if (
    pathname.startsWith("/api/") &&
    MUTATING_METHODS.has(request.method) &&
    !isAllowedOrigin(request.headers.get("origin"), request.headers.get("host"))
  ) {
    return new Response(
      JSON.stringify({ error: "Cross-origin request rejected" }),
      { status: 403, headers: { "Content-Type": "application/json" } },
    );
  }

  const sessionCookie = getSessionCookie(request);

  if (!sessionCookie) {
    return NextResponse.redirect(new URL("/sign-in", request.url));
  }
  return NextResponse.next();
}

export const config = {
  matcher: [
    "/((?!_next|favicon.ico|sitemap.xml|robots.txt|api/auth|export|sign-in|sign-up).*)",
  ],
};
