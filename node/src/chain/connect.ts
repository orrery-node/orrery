// One place opens the connection to the Solana RPC, so one place decides how it leaves this machine.
//
// With a proxy set (orrery router --proxy), RPC calls go through it like requests to nodes do, and the RPC's websocket
// is pointed at an address nothing listens on: a subscription would be a second, direct connection to the RPC
// provider, and this way one can never open. Transactions are then confirmed by asking for their status (send.ts).
import { Connection, type Commitment, type ConnectionConfig } from '@solana/web3.js';
import { nodeProxy, outFetch } from '../proxy.ts';

export const NO_WEBSOCKET = 'ws://127.0.0.1:9/';

export function rpcConnection(url: string, commitment: Commitment = 'confirmed'): Connection {
  if (!nodeProxy()) return new Connection(url, commitment);
  return new Connection(url, { commitment, wsEndpoint: NO_WEBSOCKET, fetch: outFetch as unknown as ConnectionConfig['fetch'] });
}
