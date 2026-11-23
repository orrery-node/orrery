// How private a router's requests are right now, in one sentence: how many nodes take the request and the payment
// sealed to their own key, how many run in an enclave the router verified (where :private can go), whether a proxy keeps
// this computer's address from the nodes and the RPC, and that client IDs never leave. Said by orrery doctor, the
// router's /orrery/status and console, and the status tool of orrery mcp.
export type NodePrivacy = { wire: boolean; inside: boolean; enclave: boolean };

/** How sealed answers come back: the beat this router asks for (0 is none), and of the nodes that answered it sealed
 * since it started, how many paced the answer (pace.ts) and how many were asked. */
export type Pace = { ms: number; paced: number; asked: number };

export function paceClause(p: Pace): string {
  if (p.ms <= 0) return 'sealed answers come back a chunk per frame (--frame-ms turns pacing on)';
  const beat = `sealed answers are asked for one 4 KiB frame every ${p.ms} ms`;
  return p.asked ? `${beat}; ${p.paced} of ${p.asked} node${p.asked === 1 ? '' : 's'} that answered sealed paced ${p.asked === 1 ? 'its' : 'their'} answers` : beat;
}

export function privacySentence(nodes: NodePrivacy[], proxied: boolean, pace?: Pace): string {
  const all = nodes.length;
  const inside = nodes.filter((x) => x.wire && x.inside).length, sealed = nodes.filter((x) => x.wire && !x.inside).length, plain = all - inside - sealed;
  const enclaves = nodes.filter((x) => x.enclave).length;
  return [
    `${inside} of ${all} node${all === 1 ? '' : 's'} take${all === 1 ? 's' : ''} the request and the payment sealed to ${all === 1 ? 'its' : 'their'} own key${sealed ? `, ${sealed} the request only` : ''}${plain ? `, ${plain} plain JSON inside TLS` : ''}`,
    enclaves ? `${enclaves} run${enclaves === 1 ? 's' : ''} in an enclave this computer verified, so :private has somewhere to go` : 'none runs in an enclave this computer verified, so :private would find no node yet',
    proxied ? 'requests leave through your proxy' : 'no proxy, so nodes and the RPC see your address (orrery router --proxy socks5://127.0.0.1:9050 sends it all through Tor)',
    ...(pace ? [paceClause(pace)] : []),
    'client IDs are dropped before anything leaves',
  ].join(' · ');
}
