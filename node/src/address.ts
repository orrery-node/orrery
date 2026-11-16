// Which addresses only machines on the same computer or network can reach. A node listed under one is one no router
// on the internet can use; a cluster whose RPC is at one is a local validator.

/** Whether a URL's host is one only machines on the same computer or network can reach: loopback, the private ranges,
 * link-local, carrier-grade NAT (100.64.0.0/10, where tailnets live), unique-local IPv6, and .local / localhost names. */
export function privateAddress(url: string): boolean {
  let host: string;
  try {
    host = new URL(url).hostname.toLowerCase().replace(/^\[|\]$/g, '');
  } catch {
    return false;
  }
  if (host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.local')) return true;
  const v4 = host.match(/^(\d+)\.(\d+)\.\d+\.\d+$/);
  if (v4) {
    const [a, b] = [Number(v4[1]), Number(v4[2])];
    return a === 0 || a === 10 || a === 127 || (a === 100 && b >= 64 && b <= 127) || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168);
  }
  return host === '::1' || /^f[cd][0-9a-f]{0,2}:/.test(host) || /^fe[89ab][0-9a-f]?:/.test(host);
}
