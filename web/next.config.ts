import { fileURLToPath } from 'node:url';
import type { NextConfig } from 'next';

const nextConfig: NextConfig = {
  reactStrictMode: true,
  // `api/`, `web/` and the root each have a lockfile, so Turbopack cannot infer
  // which one is the workspace root. Pin it to this package.
  turbopack: {
    root: fileURLToPath(new URL('.', import.meta.url)),
  },
  // Next 16 writes AGENTS.md/CLAUDE.md into the project on dev boot; this repo
  // does not want generated files in the deliverable.
  agentRules: false,
  // MUI ships a large barrel; this keeps dev compiles and bundles honest.
  experimental: {
    optimizePackageImports: ['@mui/material', '@mui/icons-material'],
  },
};

export default nextConfig;
