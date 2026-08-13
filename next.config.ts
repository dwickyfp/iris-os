import type { NextConfig } from "next";
import createNextIntlPlugin from "next-intl/plugin";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";

const BUILD_OUTPUT = process.env.NEXT_STANDALONE_OUTPUT
  ? "standalone"
  : undefined;
const PROJECT_ROOT = dirname(fileURLToPath(import.meta.url));

export default () => {
  const nextConfig: NextConfig = {
    output: BUILD_OUTPUT,
    cleanDistDir: true,
    // Allow this development server to be opened from the local network.
    // Next validates dev-server asset and HMR requests by origin.
    allowedDevOrigins: ["192.168.200.61"],
    turbopack: {
      // Keep Turbopack scoped to this repository when a parent lockfile exists.
      root: PROJECT_ROOT,
    },
    devIndicators: {
      position: "bottom-right",
    },
    env: {
      NO_HTTPS: process.env.NO_HTTPS,
    },
    experimental: {
      taint: true,
      authInterrupts: true,
    },
  };
  const withNextIntl = createNextIntlPlugin();
  return withNextIntl(nextConfig);
};
