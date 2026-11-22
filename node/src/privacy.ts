// How private a router's requests are right now, in one sentence: how many nodes take the request and the payment
// sealed to their own key, how many run in an enclave the router verified (where :private can go), whether a proxy keeps
// this computer's address from the nodes and the RPC, and that client IDs never leave. Said by orrery doctor, the
// router's /orrery/status and console, and the status tool of orrery mcp.
export type NodePrivacy = { wire: boolean; inside: boolean; enclave: boolean };

export function privacySentence(nodes: NodePrivacy[], proxied: boolean): string {
  const all = nodes.length;
  const inside = nodes.filter((x) => x.wire && x.inside).length, sealed = nodes.filter((x) => x.wire && !x.inside).length, plain = all - inside - sealed;
  const enclaves = nodes.filter((x) => x.enclave).length;
  return [
    `${inside} of ${all} node${all === 1 ? '' : 's'} take${all === 1 ? 's' : ''} the request and the payment sealed to ${all === 1 ? 'its' : 'their'} own key${sealed ? `, ${sealed} the request only` : ''}${plain ? `, ${plain} plain JSON inside TLS` : ''}`,
    enclaves ? `${enclaves} run${enclaves === 1 ? 's' : ''} in an enclave this computer verified, so :private has somewhere to go` : 'none runs in an enclave this computer verified, so :private would find no node yet',
    proxied ? 'requests leave through your proxy' : 'no proxy, so nodes and the RPC see your address (orrery router --proxy socks5://127.0.0.1:9050 sends it all through Tor)',
    'client IDs are dropped before anything leaves',
  ].join(' · ');
}
