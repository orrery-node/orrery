// The provider's own page at http://127.0.0.1:<port>/ — what this node served, what routers signed for it, what is
// already redeemed on chain and what is waiting. Read from /orrery/status, which answers only on this computer.
import type { IncomingMessage } from 'node:http';
import { NAME } from '../brand.ts';
import { consoleHead } from '../router/console.ts';

const LOOPBACK = new Set(['127.0.0.1', '::1', '::ffff:127.0.0.1']);

/** A request from this computer itself. One relayed by a proxy on the same machine carries forwarding headers and is not. */
export function isLocal(req: Pick<IncomingMessage, 'headers'> & { socket: { remoteAddress?: string } }): boolean {
  if (!LOOPBACK.has(req.socket.remoteAddress ?? '')) return false;
  return !req.headers['x-forwarded-for'] && !req.headers.forwarded && !req.headers['x-real-ip'];
}

export function providerConsolePage(): string {
  return `${consoleHead(`${NAME} provider`, 'Provider console')}
<main>
<div><h1><span>Your node.</span> Every answer, paid by the router that asked.</h1><p class="lede">Each answer comes back with a running total the router signed. Redeem pays the latest total on chain straight to your wallet, with nothing taken out. This page answers only on this computer.</p></div>
<div class="stats" id="sum"></div>
<section><h2>Recent answers</h2><div class="wrap"><table><thead><tr><th>time</th><th>model</th><th>channel</th><th>tokens</th><th>earned</th><th>note</th></tr></thead><tbody id="recent"></tbody></table></div></section>
<section><h2>Channels</h2><div class="wrap"><table><thead><tr><th>channel</th><th>deposit</th><th>signed to you</th><th>redeemed</th><th>waiting</th><th>unsigned answers</th></tr></thead><tbody id="ch"></tbody></table></div></section>
</main><script>
const esc=s=>String(s??'').replace(/[&<>"]/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c]));
async function tick(){try{const s=await (await fetch('/orrery/status')).json();
document.getElementById('sum').innerHTML='<div><b>'+s.answers+'</b><span class=cap>answers since start</span></div><div><b class=go>$'+esc(s.signed)+'</b><span class=cap>signed to you</span></div><div><b>$'+esc(s.redeemed)+'</b><span class=cap>redeemed on chain</span></div><div><b class=sig>$'+esc(s.waiting)+'</b><span class=cap>waiting to redeem</span></div>';
document.getElementById('recent').innerHTML=s.recent.map(r=>'<tr><td>'+new Date(r.at).toLocaleTimeString()+'</td><td>'+esc(r.model)+'</td><td>'+esc(r.channel.slice(0,8))+'</td><td>'+r.inputTokens+'+'+r.outputTokens+'</td><td class=go>$'+esc(r.cost)+'</td><td>'+(r.sealed?'<span class=go>sealed</span> ':'')+(r.off?'<span class=go>holder −'+(r.off/100)+'%</span>':'')+'</td></tr>').join('')||'<tr class=empty><td colspan=6>No answers yet. Routers find you through your listing on chain.</td></tr>';
document.getElementById('ch').innerHTML=s.channels.map(c=>'<tr><td>'+esc(c.channel.slice(0,8))+'</td><td>$'+esc(c.deposit)+'</td><td class=go>$'+esc(c.signed)+'</td><td>$'+esc(c.redeemed)+'</td><td class=sig>$'+esc(c.waiting)+'</td><td>'+c.unsigned+'</td></tr>').join('')||'<tr class=empty><td colspan=6>None yet. A router opens one with its first request.</td></tr>';
}catch(e){}}tick();setInterval(tick,2000);
</script></body></html>`;
}
