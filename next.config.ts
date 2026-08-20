import type { NextConfig } from 'next';
import { fileURLToPath } from 'node:url';
import { dirname } from 'node:path';

const config: NextConfig = {
  reactStrictMode: true,

  // Pin the workspace root so a lockfile elsewhere on the machine can't shift it.
  turbopack: { root: dirname(fileURLToPath(import.meta.url)) },

  // Native/embedded modules must not be bundled — they load platform binaries at runtime.
  serverExternalPackages: ['@duckdb/node-api', 'maxmind'],

  async headers() {
    return [
      {
        // The tracker is embedded on third-party sites, so it must be openly cacheable.
        source: '/i.js',
        headers: [
          { key: 'Access-Control-Allow-Origin', value: '*' },
          { key: 'Cache-Control', value: 'public, max-age=3600, must-revalidate' },
        ],
      },
    ];
  },
};

export default config;
