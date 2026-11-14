// A docker-compose file that runs this node in a container: the official Node image running this package from npm, the
// config and the node's folder mounted at the paths they have on the host, the port from the config. Nothing is built
// and nothing is pulled from a registry of ours. The wallet is never mounted: a node runs on its own key.
import { resolve } from 'node:path';

export type ComposeInput = {
  /** provider.json as written, for the fields that decide what the container needs. */
  cfg: { listen?: number; dataDir?: string; nodeKey?: string; nodeKeyEnv?: string; upstream: { baseUrl: string; apiKeyEnv?: string }; tee?: unknown; burn?: unknown };
  /** Where provider.json is on the host. */
  configPath: string;
  /** The host's home folder: `~` in the config means this, in the container too. */
  home: string;
  /** The package to run, e.g. orrery-node@0.1.17. */
  pkg: string;
  port: number;
};

const LOOPBACK = /^(127\.0\.0\.1|localhost|\[::1\])$/i;
const expandIn = (home: string) => (p: string) => resolve(p.replace(/^~(?=$|\/)/, home));
/** A YAML double-quoted string. */
const q = (s: string) => `"${s.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;

/** The upstream as the container reaches it: a model server on this computer is at host.docker.internal there. */
export function upstreamInContainer(baseUrl: string): { url: string; viaHost: boolean } {
  try {
    const u = new URL(baseUrl);
    if (!LOOPBACK.test(u.hostname)) return { url: baseUrl, viaHost: false };
    u.hostname = 'host.docker.internal';
    return { url: u.toString().replace(/\/$/, baseUrl.endsWith('/') ? '/' : ''), viaHost: true };
  } catch {
    return { url: baseUrl, viaHost: false };
  }
}

export function composeFile(i: ComposeInput): string {
  const at = expandIn(i.home);
  const config = at(i.configPath);
  const dataDir = at(i.cfg.dataDir ?? `${i.home}/.orrery/provider`);
  const up = upstreamInContainer(i.cfg.upstream.baseUrl);
  // The node key, when it is a file outside the node's folder, comes along read-only.
  const nodeKey = i.cfg.nodeKey && !i.cfg.nodeKeyEnv ? at(i.cfg.nodeKey) : null;
  const volumes = [`${config}:${config}:ro`, `${dataDir}:${dataDir}`, ...(nodeKey && !nodeKey.startsWith(`${dataDir}/`) ? [`${nodeKey}:${nodeKey}:ro`] : [])];
  const env = [`HOME=${i.home}`, ...(up.viaHost ? [`ORRERY_UPSTREAM_URL=${up.url}`] : [])];
  // Secrets the config reads from the environment are passed through by name: their values never land in this file.
  const passed = [i.cfg.nodeKeyEnv, i.cfg.upstream.apiKeyEnv].filter((n): n is string => !!n);
  // --package names what to install and `orrery` what to run, so a version, a tag or a packed file all work.
  const run = `npx -y --package=${i.pkg} orrery provider`;
  const start = `${run} start --config ${config}`;
  return [
    `# Runs this Orrery node in a container. Written by: orrery provider compose --config ${i.configPath}`,
    '#   docker compose up -d                      start it, and again after a reboot or a crash',
    `#   docker compose exec node ${run} status --config ${config}`,
    '#   docker compose logs -f node               every answer it serves and every payout',
    '# The config and the node’s folder are mounted from this computer, so its key, its listing and what routers signed to',
    '# it stay the same in and out of the container. Your wallet is not mounted: the node pays out to it, never from it.',
    ...(i.cfg.burn ? ['# This node has a burn pledge: buying and burning needs the wallet, so run `orrery provider burn` outside the container.'] : []),
    'services:',
    '  node:',
    '    image: node:22-slim',
    `    command: ${q(start)}`,
    '    restart: unless-stopped',
    '    ports:',
    `      - ${q(`${i.port}:${i.port}`)}`,
    '    environment:',
    ...env.map((e) => `      - ${q(e)}`),
    ...passed.map((n) => `      - ${n}`),
    '    volumes:',
    ...volumes.map((v) => `      - ${q(v)}`),
    ...(up.viaHost ? ['    extra_hosts:', '      - "host.docker.internal:host-gateway"'] : []),
    '    healthcheck:',
    `      test: ["CMD", "node", "-e", "require('http').get('http://127.0.0.1:${i.port}/health',r=>process.exit(r.statusCode===200?0:1)).on('error',()=>process.exit(1))"]`,
    '      interval: 30s',
    '      timeout: 5s',
    '      start_period: 60s',
    '',
  ].join('\n');
}
