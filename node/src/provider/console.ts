// The provider's own page at http://127.0.0.1:<port>/ — what this node served, what routers signed for it, what is
// already redeemed on chain and what is waiting. Read from /orrery/status, which answers only on this computer.
import { timingSafeEqual } from 'node:crypto';
import type { IncomingMessage } from 'node:http';
import { NAME } from '../brand.ts';
import { consoleHead } from '../router/console.ts';

const LOOPBACK = new Set(['127.0.0.1', '::1', '::ffff:127.0.0.1']);
/** Host names that address this computer; a page that points its own domain here (DNS rebinding) still sends its own. */
const LOCAL_NAMES = new Set(['127.0.0.1', 'localhost', '[::1]']);

/** A request from this computer, addressed to this computer. One relayed by a proxy on the same machine carries forwarding
 * headers and is not; nor is one whose Host names another domain. */
export function isLocal(req: Pick<IncomingMessage, 'headers'> & { socket: { remoteAddress?: string } }): boolean {
  if (!LOOPBACK.has(req.socket.remoteAddress ?? '')) return false;
  if (req.headers['x-forwarded-for'] || req.headers.forwarded || req.headers['x-real-ip']) return false;
  return LOCAL_NAMES.has(String(req.headers.host ?? '').replace(/:\d+$/, '').toLowerCase());
}

/** Whether a request carries the key this node keeps on its disk (console.key), by header or by ?key=. A front on the
 * same machine can make a request look local (nginx by default rewrites Host to 127.0.0.1 and adds no forwarding
 * header); it cannot read the node's disk. */
export function hasConsoleKey(req: Pick<IncomingMessage, 'headers'>, url: URL, key: string): boolean {
  const given = String(req.headers['x-orrery-console-key'] ?? url.searchParams.get('key') ?? '');
  const a = Buffer.from(given), b = Buffer.from(key);
  return a.length === b.length && b.length > 0 && timingSafeEqual(a, b);
}

export type OwnStatus = { provider: string; name: string; answers: number; signed: string; redeemed: string; waiting: string; channels: { unsigned: number }[] };

/** The running node's own status, read on this computer with its key; null when no node answers on that port. Stays on
 * loopback, so it never goes through a proxy. */
export async function readOwnStatus(port: number, key: string): Promise<OwnStatus | null> {
  const r = await fetch(`http://127.0.0.1:${port}/orrery/status`, { headers: { 'x-orrery-console-key': key } }).catch(() => null);
  return r?.ok ? ((await r.json()) as OwnStatus) : null;
}

/** The page that asks for the key: a local visit to the console without it. Says where the address is, not the key. */
export function consoleKeyPage(): string {
  return `${consoleHead(`${NAME} provider`, 'Provider console')}
<main><div><h1><span>Your node.</span> This page needs its key.</h1><p class="lede">Open the address the node printed when it started, or run <code>orrery provider console --config provider.json</code> to print it again; it ends in ?key=. The key is in console.key in the node’s folder, so only someone who can read that folder can read this page.</p></div></main></body></html>`;
}

export function providerConsolePage(): string {
  return `${consoleHead(`${NAME} provider`, 'Provider console')}
<main>
<div><h1><span>Your node.</span> Every answer, paid by the router that asked.</h1><p class="lede">Each answer comes back with a running total the router signed. Redeem pays the latest total on chain straight to your wallet, with nothing taken out. This page answers only on this computer.</p></div>
<div class="stats" id="sum"></div>
<section><h2>Recent answers, latest 12</h2><div class="wrap"><table><thead><tr><th>time</th><th>model</th><th>channel</th><th>tokens</th><th>earned</th><th>note</th></tr></thead><tbody id="recent"></tbody></table></div></section>
<section><h2>Last 24 hours, by model (billed)</h2><div class="wrap"><table><thead><tr><th>model</th><th>answers</th><th>tokens in</th><th>tokens out</th><th>billed</th></tr></thead><tbody id="earn"></tbody></table></div></section>
<section><h2>Channels</h2><div class="wrap"><table><thead><tr><th>channel</th><th>deposit</th><th>signed to you</th><th>redeemed</th><th>waiting</th><th>unsigned answers</th></tr></thead><tbody id="ch"></tbody></table></div></section>
</main><script>
const K={headers:{'x-orrery-console-key':new URLSearchParams(location.search).get('key')||''}};
const esc=s=>String(s??'').replace(/[&<>"]/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c]));
async function tick(){try{const s=await (await fetch('/orrery/status',K)).json();
document.getElementById('sum').innerHTML='<div><b>'+s.answers+'</b><span class=cap>answers since start</span></div><div><b class=go>$'+esc(s.signed)+'</b><span class=cap>signed to you</span></div><div><b>$'+esc(s.redeemed)+'</b><span class=cap>redeemed on chain</span></div><div><b class=sig>$'+esc(s.waiting)+'</b><span class=cap>waiting to redeem</span></div>';
document.getElementById('recent').innerHTML=s.recent.slice(0,12).map(r=>'<tr><td>'+new Date(r.at).toLocaleTimeString()+'</td><td>'+esc(r.model)+'</td><td>'+esc(r.channel.slice(0,8))+'</td><td>'+r.inputTokens+'+'+r.outputTokens+'</td><td class=go>$'+esc(r.cost)+'</td><td>'+(r.sealed?'<span class=go>sealed</span> ':'')+(r.off?'<span class=go>holder −'+(r.off/100)+'%</span>':'')+'</td></tr>').join('')||'<tr class=empty><td colspan=6>No answers yet. Routers find you through your listing on chain.</td></tr>';
try{const e=await (await fetch('/orrery/earnings?since=24h',K)).json();document.getElementById('earn').innerHTML=e.total.answers?[...e.rows,{...e.total,key:'total'}].map(r=>'<tr><td>'+esc(r.key)+'</td><td>'+r.answers+'</td><td>'+Number(r.inputTokens).toLocaleString('en-US')+'</td><td>'+Number(r.outputTokens).toLocaleString('en-US')+'</td><td class=go>$'+esc(r.usd)+'</td></tr>').join(''):'<tr class=empty><td colspan=5>Nothing served in the last 24 hours.</td></tr>';}catch(err){}
document.getElementById('ch').innerHTML=s.channels.map(c=>'<tr><td>'+esc(c.channel.slice(0,8))+'</td><td>$'+esc(c.deposit)+'</td><td class=go>$'+esc(c.signed)+'</td><td>$'+esc(c.redeemed)+'</td><td class=sig>$'+esc(c.waiting)+'</td><td>'+c.unsigned+'</td></tr>').join('')||'<tr class=empty><td colspan=6>None yet. A router opens one with its first request.</td></tr>';
}catch(e){}}tick();setInterval(tick,2000);
</script></body></html>`;
}
