import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Current ikas CLI Cloudflare tunnel used during development.
  // If ikas app dev creates a new tunnel, update this host or ignore the dev-only HMR warning.
  allowedDevOrigins: ["elected-steve-sacred-billion.trycloudflare.com"],
};

export default nextConfig;
