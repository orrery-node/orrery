// The provider's own page at http://127.0.0.1:<port>/ — what this node served, what routers signed for it, what is
// already redeemed on chain and what is waiting. Read from /orrery/status, which answers only on this computer.
import { nextPayoutSentence, noticeSentence, payoutRows, type Held, type NextPayout, type NoticeSent, type PayoutSummary } from './payouts.ts';
import { reachSentence, type ReachNow } from './reach.ts';
import { slotsSentence, type SlotState } from './slots.ts';
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

/** The line provider start prints for its console. The key goes only to a terminal: output that is not one usually
 * lands in a log a host keeps, so that line names the command that prints the key instead. */
export function consoleLine(port: number, key: string, toTerminal: boolean, configPath: string): string {
  const at = `your console, on this computer only: http://127.0.0.1:${port}/`;
  return toTerminal ? `${at}?key=${key}` : `${at} (orrery provider console --config ${configPath} prints it with its key)`;
}

/** When what is waiting gets paid out, for the status line: by itself at the node's minimum, or at the next round once
 * it is there, or, for a node never paid out on chain, at the next round whatever the minimum (its first payout goes
 * out at once). Empty when nothing waits. */
export function payoutHint(waiting: string, minUnits: number, everySecs: number, configPath: string, firstPayout = false): string {
  const units = Math.round(Number(waiting) * 1e6);
  if (!(units > 0)) return '';
  const every = everySecs < 60 ? `${everySecs} s` : `${Math.round(everySecs / 60)} min`;
  if (firstPayout) return `  (your first payout: pays out at the next round, every ${every})`;
  if (units >= minUnits) return `  (pays out at the next round, every ${every})`;
  const min = (minUnits / 1e6).toFixed(6).replace(/0+$/, '').replace(/\.$/, '').replace(/^(\d+\.\d)$/, '$10');
  return `  (pays out by itself at $${min}; orrery provider redeem --config ${configPath} does it now)`;
}

/** The same hint from the running node's own count, which judges each channel on its own as the payout round does: two
 * channels of $0.03 are not $0.06 due, and a channel its router is closing goes out whatever it holds. */
export function nextPayoutHint(n: NextPayout, configPath: string): string {
  if (n.due === '0' && n.below === '0') return '';
  const every = n.everySecs < 60 ? `${n.everySecs} s` : `${Math.round(n.everySecs / 60)} min`;
  const min = (Number(n.floor) / 1e6).toFixed(6).replace(/0+$/, '').replace(/\.$/, '').replace(/^(\d+\.\d)$/, '$10');
  if (n.below === '0') return n.first ? `  (your first payout: pays out at the next round, every ${every})` : `  (pays out at the next round, every ${every})`;
  if (n.due === '0') return `  (${n.belowChannels === 1 ? '' : 'each channel '}pays out by itself at $${min}; orrery provider redeem --config ${configPath} does it now)`;
  return `  ($${(Number(n.due) / 1e6).toFixed(6)} at the next round, every ${every}; $${(Number(n.below) / 1e6).toFixed(6)} waits for $${min} a channel)`;
}

export type OwnStatus = { provider: string; name: string; answers: number; signed: string; redeemed: string; waiting: string; channels: { unsigned: number }[]; recent?: { at: number }[]; refused?: Partial<Record<string, number>>; payouts?: PayoutSummary | null; manifestHash?: string; reach?: ReachNow; nextPayout?: NextPayout; wallet?: Held | null; notify?: { host: string; last: NoticeSent | null } | null; slots?: SlotState | null };

/** The running node's own status, read on this computer with its key; null when no node answers on that port. Stays on
 * loopback, so it never goes through a proxy. */
export async function readOwnStatus(port: number, key: string): Promise<OwnStatus | null> {
  const r = await fetch(`http://127.0.0.1:${port}/orrery/status`, { headers: { 'x-orrery-console-key': key } }).catch(() => null);
  return r?.ok ? ((await r.json()) as OwnStatus) : null;
}

/** The node's own count of the last 24 hours, from /orrery/earnings (its log of answers), with the key; null when no
 * node answers. A restart does not reset it, as it does `answers since start`. */
export async function readOwnDay(port: number, key: string): Promise<{ answers: number; usd: string } | null> {
  const r = await fetch(`http://127.0.0.1:${port}/orrery/earnings?since=24h`, { headers: { 'x-orrery-console-key': key } }).catch(() => null);
  const j = r?.ok ? ((await r.json().catch(() => null)) as { total?: { answers?: number; usd?: string } } | null) : null;
  return typeof j?.total?.answers === 'number' && typeof j.total.usd === 'string' ? { answers: j.total.answers, usd: j.total.usd } : null;
}

/** "  last 24 h             1,312 answers, $0.038912 billed", or "no answers". */
export function dayLine(t: { answers: number; usd: string }): string {
  return `  last 24 h             ${t.answers ? `${t.answers.toLocaleString('en-US')} answer${t.answers === 1 ? '' : 's'}, $${t.usd} billed` : 'no answers'}`;
}

export type OwnMonth = { day: string; answers: number; billed: string; payouts: number; paid: string };

/** This UTC month so far from the node's own books (/orrery/books, kept days included), with the key; null when no
 * node answers. */
export async function readOwnMonth(port: number, key: string): Promise<OwnMonth | null> {
  const r = await fetch(`http://127.0.0.1:${port}/orrery/books?since=1d`, { headers: { 'x-orrery-console-key': key } }).catch(() => null);
  const j = r?.ok ? ((await r.json().catch(() => null)) as { month?: OwnMonth } | null) : null;
  return j?.month && typeof j.month.answers === 'number' ? { day: j.month.day, answers: j.month.answers, billed: j.month.billed, payouts: j.month.payouts, paid: j.month.paid } : null;
}

/** "  this month (UTC)      1,312 answers, $0.038912 billed; 3 payouts, $0.120000 to your wallet", or "nothing yet". */
export function monthLine(m: OwnMonth): string {
  return `  this month (UTC)      ${m.answers || m.payouts ? `${m.answers.toLocaleString('en-US')} answer${m.answers === 1 ? '' : 's'}, $${m.billed} billed; ${m.payouts} payout${m.payouts === 1 ? '' : 's'}, $${m.paid} to your wallet` : 'nothing yet'}`;
}

/** The page that asks for the key: a local visit to the console without it. Says where the address is, not the key. */
export function consoleKeyPage(): string {
  return `${consoleHead(`${NAME} provider`, 'Provider console')}
<main><div><h1><span>Your node.</span> This page needs its key.</h1><p class="lede">Open the address the node printed when it started, or run <code>orrery provider console --config provider.json</code> to print it again; it ends in ?key=. The key is in console.key in the node’s folder, so only someone who can read that folder can read this page.</p></div></main></body></html>`;
}

export function providerConsolePage(): string {
  return `${consoleHead(`${NAME} provider`, 'Provider console')}
<main>
<div><h1><span>Your node.</span> Every answer, paid by the router that asked.</h1><p class="lede">Each answer comes back with a running total the router signed. Redeem pays the latest total on chain straight to your wallet, with nothing taken out. This page answers only on this computer.</p><p class="lede" id="reach" hidden></p></div>
<div class="stats" id="sum"></div>
<p class="lede" id="fees" hidden></p>
<section><h2>Recent answers, latest 12</h2><div class="wrap"><table><thead><tr><th>time</th><th>model</th><th>channel</th><th>tokens</th><th>earned</th><th>note</th></tr></thead><tbody id="recent"></tbody></table></div><p class="lede" id="slots" hidden></p></section>
<section><div class="pay"><h2>Payouts to your wallet, latest 12</h2><button class="check" id="check" type="button" hidden>Check against the chain</button></div><div class="wrap"><table><thead><tr><th>time</th><th>paid out</th><th>channels</th><th>transaction</th><th>on chain</th></tr></thead><tbody id="payouts"></tbody></table></div><p class="lede" id="next" hidden></p><p class="lede" id="notice" hidden></p><p class="lede" id="checked" hidden></p><p class="lede" id="copied" hidden></p></section>
<section><h2>Last 24 hours, by model (billed)</h2><div class="wrap"><table><thead><tr><th>model</th><th>answers</th><th>tokens in</th><th>tokens out</th><th>billed</th></tr></thead><tbody id="earn"></tbody></table></div><p class="lede" id="holders" hidden></p></section>
<section><div class="pay"><h2>Your books by day (UTC), last 7 days</h2><a class="check" id="csv" href="#" download="orrery-books.csv">Download 90 days as CSV</a></div><div class="wrap"><table><thead><tr><th>day</th><th>answers</th><th>billed</th><th>payouts</th><th>paid out</th></tr></thead><tbody id="days"></tbody></table></div><p class="lede" id="month" hidden></p></section>
<section id="cardsec" hidden><div class="pay"><h2>This month, as a card</h2><button class="check" id="cardsave" type="button">Download PNG</button></div><canvas id="card" width="2400" height="1260" style="display:block;width:100%;height:auto;border:1px solid var(--line);border-radius:14px"></canvas></section>
<section><h2>Channels</h2><div class="wrap"><table><thead><tr><th>channel</th><th>deposit</th><th>signed to you</th><th>redeemed</th><th>waiting</th><th>unsigned answers</th></tr></thead><tbody id="ch"></tbody></table></div></section>
</main><script>
const K={headers:{'x-orrery-console-key':new URLSearchParams(location.search).get('key')||''}};
document.getElementById('csv').href='/orrery/books?since=90d&format=csv&key='+encodeURIComponent(K.headers['x-orrery-console-key']);
const reachSentence=${reachSentence.toString()};
const payoutRows=${payoutRows.toString()};
const esc=s=>String(s??'').replace(/[&<>"]/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c]));
const nextPayoutSentence=${nextPayoutSentence.toString()};
const noticeSentence=${noticeSentence.toString()};
const slotsSentence=${slotsSentence.toString()};
const checked={};
let cardMonth='';
function drawCard(m,node){const c=document.getElementById('card'),x=c.getContext('2d'),v=n=>getComputedStyle(document.documentElement).getPropertyValue(n).trim(),W=1200,H=630,P=64;x.setTransform(c.width/W,0,0,c.height/H,0,0);
cardMonth=m.day;const name=new Date(m.day+'-01T00:00:00Z').toLocaleString('en-US',{month:'long',year:'numeric',timeZone:'UTC'}),paid=Number(m.payouts)>0;
x.fillStyle=v('--bg')||'#000';x.fillRect(0,0,W,H);x.textBaseline='alphabetic';
x.font="500 26px 'Geist Mono',monospace";x.fillStyle=v('--fg2');x.textAlign='left';const right=name+' so far (UTC)',room=W-2*P-(x.measureText(right).width||0)-40;let left='orrery node'+(node?' · '+node:'');while(left.length>14&&(x.measureText(left).width||0)>room)left=left.slice(0,-2)+'…';x.fillText(left,P,P+22);x.textAlign='right';x.fillStyle=v('--fg3');x.fillText(right,W-P,P+22);x.textAlign='left';
x.font="500 132px 'Instrument Sans',sans-serif";x.fillStyle=v('--fg');x.fillText('$'+(paid?m.paid:m.billed),P-6,P+250);
x.font="400 34px 'Instrument Sans',sans-serif";x.fillStyle=v('--fg2');x.fillText(paid?'paid out to my wallet in '+m.payouts+' payout'+(m.payouts===1?'':'s')+', for '+Number(m.answers).toLocaleString('en-US')+' answer'+(m.answers===1?'':'s'):'billed for '+Number(m.answers).toLocaleString('en-US')+' answer'+(m.answers===1?'':'s')+'; the first payout goes out once it adds up',P,P+318);
if(paid){x.font="500 44px 'Instrument Sans',sans-serif";x.fillStyle=v('--green');x.fillText('each answer paid on its own, $'+m.billed+' billed',P,P+400);}
x.font="400 22px 'Geist Mono',monospace";x.fillStyle=v('--fg3');x.fillText("from my node's own books, on my machine",P,H-P);x.textAlign='right';x.fillText('0% taken in between',W-P,H-P);x.textAlign='left';}
document.getElementById('cardsave').onclick=()=>document.getElementById('card').toBlob(b=>{if(!b)return;const a=document.createElement('a');a.href=URL.createObjectURL(b);a.download='orrery-node-'+(cardMonth||'month')+'.png';document.body.appendChild(a);a.click();a.remove();setTimeout(()=>URL.revokeObjectURL(a.href),5000);});
document.getElementById('check').onclick=async()=>{const b=document.getElementById('check'),l=document.getElementById('checked');b.disabled=true;b.textContent='Reading the chain…';
try{const c=await (await fetch('/orrery/payouts/check',K)).json();for(const r of c.rows)if(r.state!=='unchecked')checked[r.tx]={state:r.state,units:r.units};l.textContent=c.line?c.line+' (checked '+new Date().toISOString().slice(11,19)+' UTC)':'';l.hidden=!c.line;tick();}
catch(e){l.textContent='The RPC did not answer. Try again in a moment.';l.hidden=false;}b.disabled=false;b.textContent='Check against the chain';};
document.getElementById('payouts').onclick=async(ev)=>{const b=ev.target.closest&&ev.target.closest('button.tx');if(!b)return;const tx=b.dataset.tx,c=document.getElementById('copied');
try{await navigator.clipboard.writeText(tx);c.textContent='Copied the whole transaction ('+tx.slice(0,12)+'…). Paste it into any Solana explorer to see the payout there.';}
catch(e){c.textContent='The whole transaction, to look up on any Solana explorer: '+tx;}c.hidden=false;};
async function tick(){try{const s=await (await fetch('/orrery/status',K)).json();
document.getElementById('sum').innerHTML='<div><b>'+s.answers+'</b><span class=cap>answers since start</span></div><div><b class=go>$'+esc(s.signed)+'</b><span class=cap>signed to you</span></div><div><b>$'+esc(s.redeemed)+'</b><span class=cap>redeemed on chain</span></div><div><b class=sig>$'+esc(s.waiting)+'</b><span class=cap>waiting to redeem</span></div>'
+(s.wallet?'<div title="after the last payout, read from the chain’s record of tx '+esc(s.wallet.tx)+'"><b class=go>$'+(Number(s.wallet.units)/1e6).toFixed(6)+'</b><span class=cap>in your wallet, per the chain</span></div>':'');
document.getElementById('sum').className=s.wallet?'stats five':'stats';
document.getElementById('recent').innerHTML=s.recent.slice(0,12).map(r=>'<tr><td>'+new Date(r.at).toLocaleTimeString()+'</td><td>'+esc(r.model)+'</td><td>'+esc(r.channel.slice(0,8))+'</td><td>'+r.inputTokens+'+'+r.outputTokens+'</td><td class=go>$'+esc(r.cost)+'</td><td>'+(r.sealed?'<span class=go>sealed</span> ':'')+(r.off?'<span class=go>holder −'+(r.off/100)+'%</span>':'')+'</td></tr>').join('')||'<tr class=empty><td colspan=6>No answers yet. Routers find you through your listing on chain.</td></tr>';
if(s.payouts)s.payouts.checked=Object.assign({},s.payouts.checked,checked);document.getElementById('payouts').innerHTML=payoutRows(s.payouts);document.getElementById('check').hidden=!(s.payouts&&s.payouts.recent.length);
const nx=nextPayoutSentence(s.nextPayout),ne=document.getElementById('next');ne.textContent=nx;ne.hidden=!nx;const no=document.getElementById('notice');no.textContent=s.notify?'Payout notices go '+noticeSentence(s.notify.host,s.notify.last,Date.now())+'.':'';no.hidden=!s.notify;
const rs=reachSentence(s.reach,Date.now()),re=document.getElementById('reach');re.textContent=rs;re.hidden=!rs;
const sl=document.getElementById('slots');sl.textContent=s.slots?'Slots: '+slotsSentence(s.slots)+'. When every slot is answering, the next free one goes to the largest holder discount.':'';sl.hidden=!s.slots;
try{const e=await (await fetch('/orrery/earnings?since=24h',K)).json();const fe=document.getElementById('fees');fe.textContent=e.fees?'Fee money for payouts: '+e.fees.line+'.':'';fe.className=e.fees&&e.fees.low?'lede stop':'lede';fe.hidden=!e.fees;document.getElementById('earn').innerHTML=e.total.answers?[...e.rows,{...e.total,key:'total'}].map(r=>'<tr><td>'+esc(r.key)+'</td><td>'+r.answers+'</td><td>'+Number(r.inputTokens).toLocaleString('en-US')+'</td><td>'+Number(r.outputTokens).toLocaleString('en-US')+'</td><td class=go>$'+esc(r.usd)+'</td></tr>').join(''):'<tr class=empty><td colspan=5>Nothing served in the last 24 hours.</td></tr>';const ho=document.getElementById('holders'),hl=e.holders&&e.holders.answers?e.holders.line:'';ho.textContent=hl?hl.charAt(0).toUpperCase()+hl.slice(1)+'.':'';ho.hidden=!hl;}catch(err){}
try{const b=await (await fetch('/orrery/books?since=7d',K)).json();const mo=document.getElementById('month');mo.textContent=b.month&&b.month.line?b.month.line+'.':'';mo.hidden=!(b.month&&b.month.line);document.getElementById('days').innerHTML=b.rows.length?[...b.rows,b.total].map(r=>'<tr><td>'+esc(r.day)+'</td><td>'+Number(r.answers).toLocaleString('en-US')+'</td><td>$'+esc(r.billed)+'</td><td>'+Number(r.payouts)+'</td><td class=go>$'+esc(r.paid)+'</td></tr>').join(''):'<tr class=empty><td colspan=5>Nothing served or paid out in the last 7 days.</td></tr>';const cs=document.getElementById('cardsec');if(b.month&&b.month.answers){drawCard(b.month,s.name);cs.hidden=false;}else cs.hidden=true;}catch(err){}
document.getElementById('ch').innerHTML=s.channels.map(c=>'<tr><td>'+esc(c.channel.slice(0,8))+'</td><td>$'+esc(c.deposit)+'</td><td class=go>$'+esc(c.signed)+'</td><td>$'+esc(c.redeemed)+'</td><td class=sig>$'+esc(c.waiting)+'</td><td>'+c.unsigned+'</td></tr>').join('')||'<tr class=empty><td colspan=6>None yet. A router opens one with its first request.</td></tr>';
}catch(e){}}tick();setInterval(tick,2000);
</script></body></html>`;
}
