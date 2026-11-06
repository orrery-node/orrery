import type { NextConfig } from 'next';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const config: NextConfig = {
  reactStrictMode: true,
  poweredByHeader: false,
  devIndicators: false,
  agentRules: false,
  turbopack: { root: dirname(fileURLToPath(import.meta.url)) },
  serverExternalPackages: ['orrery-node', '@solana/web3.js'],
};

export default config;
