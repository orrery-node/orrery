// The page at http://127.0.0.1:7171/ — what the router did, read from /orrery/status. Plain HTML, no build step.
import { skipNote, unansweredNote } from '../spend.ts';
import { NAME } from '../brand.ts';
import { FONT_FACES } from './fonts.ts';

/** The shared page head, styles and header bar of the local consoles (router and provider). The page asks nothing of
 * any other computer: its two typefaces are carried in the page (fonts.ts), where a font link would tell a third party
 * every time a console is opened. */
export function consoleHead(title: string, here: string): string {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${title}</title>
<style>
${FONT_FACES}
:root{--bg:#000;--card:#0c0c0c;--well:#070707;--line:#1c1c1c;--line2:#2e2e2e;--fg:#f7f7f7;--fg2:#c6c6c6;--fg3:#9c9c9c;--green:#14f195;--purple:#b98aff;--warn:#f0a868;
--sans:'Instrument Sans','Helvetica Neue',Arial,sans-serif;--mono:'Geist Mono',ui-monospace,SFMono-Regular,Menlo,monospace;color-scheme:dark}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--fg);font:15px/1.5 var(--sans);-webkit-font-smoothing:antialiased;padding:0 clamp(16px,4vw,48px) 64px}
header{display:flex;align-items:center;gap:12px;height:64px;border-bottom:1px solid var(--line);margin:0 calc(-1*clamp(16px,4vw,48px)) 32px;padding:0 clamp(16px,4vw,48px)}
.brand{display:inline-flex;align-items:center;gap:10px;font-weight:500;font-size:17px;letter-spacing:-.02em}
.grad{background-image:linear-gradient(90deg,#9945ff,#5f8ff2 50%,#14f195);-webkit-background-clip:text;background-clip:text;color:transparent}
.here{color:var(--fg3);font-size:14px}.live{margin-left:auto;display:inline-flex;align-items:center;gap:8px;font:400 12px var(--mono);color:var(--fg2)}
.live i{width:7px;height:7px;border-radius:50%;background:var(--green);box-shadow:0 0 0 3px rgba(20,241,149,.15);animation:b 2.4s ease-in-out infinite}@keyframes b{50%{opacity:.35}}
main{max-width:1180px;margin:0 auto;display:grid;grid-template-columns:minmax(0,1fr);gap:36px}
h1{margin:0;font-size:clamp(28px,3.2vw,40px);font-weight:500;letter-spacing:-.03em;line-height:1.08}h1 span{color:var(--fg3)}
.lede{margin:10px 0 0;color:var(--fg2);max-width:46em}.lede code{font:400 13px var(--mono);color:var(--fg)}
.stats{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));border:1px solid var(--line);border-radius:16px;background:var(--card);overflow:hidden}
.stats div{padding:18px 20px;display:flex;flex-direction:column-reverse;gap:6px}.stats div+div{border-left:1px solid var(--line)}
.stats b{font:500 22px var(--mono);letter-spacing:0}.cap{font:500 11px/1.4 var(--mono);letter-spacing:.16em;text-transform:uppercase;color:var(--fg3)}
section h2{margin:0 0 12px;font:500 11px/1.4 var(--mono);letter-spacing:.16em;text-transform:uppercase;color:var(--fg3)}
.wrap{overflow-x:auto;border:1px solid var(--line);border-radius:16px;background:var(--card)}
table{width:100%;border-collapse:collapse;font:400 13px/1.5 var(--mono);font-variant-numeric:tabular-nums}
th,td{text-align:left;padding:12px 16px;border-bottom:1px solid var(--line);white-space:nowrap}tbody tr:last-child td{border-bottom:0}
th{color:var(--fg3);font-weight:500;font-size:10.5px;text-transform:uppercase;letter-spacing:.14em;background:var(--well)}
td{color:var(--fg2)}td:first-child{color:var(--fg)}tbody tr:hover td{background:#101010}
td.rec{white-space:normal;min-width:300px;line-height:1.6}
.go{color:var(--green)}.stop{color:var(--warn)}.sig{color:var(--purple)}.dim{color:var(--fg3)}.empty td{color:var(--fg3);font-family:var(--sans);font-size:14px;padding:22px 16px}
.pay{display:flex;align-items:center;justify-content:space-between;gap:12px;margin:0 0 12px}.pay h2{margin:0}
.check{font:500 12px/1 var(--mono);color:var(--fg);background:var(--well);border:1px solid var(--line2);border-radius:8px;padding:8px 12px;cursor:pointer;white-space:nowrap;flex:none;text-decoration:none}.check:hover{border-color:var(--fg3)}.check:focus-visible{outline:2px solid var(--green);outline-offset:2px}.check:disabled{color:var(--fg3);cursor:default}
.stats.five{grid-template-columns:repeat(5,minmax(0,1fr))}
.wrap td button.tx{font:inherit;color:inherit;background:none;border:0;border-bottom:1px dashed var(--line2);padding:0;cursor:copy}.wrap td button.tx:hover{color:var(--fg);border-color:var(--fg3)}.wrap td button.tx:focus-visible{outline:2px solid var(--green);outline-offset:2px}
@media (max-width:760px){.stats,.stats.five{grid-template-columns:repeat(2,minmax(0,1fr))}.stats div:nth-child(3),.stats div:nth-child(5){border-left:0}.stats.five div:nth-child(5){grid-column:1/-1}.stats div:nth-child(n+3){border-top:1px solid var(--line)}.live{display:none}}
</style></head><body>
<header><span class="brand"><svg width="22" height="22" viewBox="0 0 24 24" aria-hidden="true"><defs><linearGradient id="g" x1="2" y1="18" x2="22" y2="6" gradientUnits="userSpaceOnUse"><stop offset="0" stop-color="#9945ff"/><stop offset=".5" stop-color="#5f8ff2"/><stop offset="1" stop-color="#14f195"/></linearGradient></defs><ellipse cx="12" cy="12" rx="10.2" ry="4.3" fill="none" stroke="url(#g)" stroke-width="1.3"/><ellipse cx="12" cy="12" rx="10.2" ry="4.3" fill="none" stroke="url(#g)" stroke-width="1.3" opacity=".6" transform="rotate(62 12 12)"/><circle cx="12" cy="12" r="2.5" fill="#f5f5f5"/><circle cx="20.6" cy="9.7" r="1.7" fill="#14f195"/></svg><span class="grad">${NAME}</span></span><span class="here">${here}</span><span class="live"><i></i>live from this computer</span></header>`;
}

/** The paid cell of one answer: what this router paid and, beside it, how the node's bill compared with what the
 * prices it listed on chain come to (`billed`, `listed`, logged since 0.1.18). Its source goes into the page. */
export function paidCell(t: { cost: string; billed?: string; listed?: string }): string {
  if (typeof t.billed !== 'string' || typeof t.listed !== 'string') return '$' + t.cost;
  if (Number(t.billed) > Number(t.listed)) return '$' + t.cost + ' <span class=sig>it asked $' + t.billed + '; paid its listed price</span>';
  if (Number(t.billed) < Number(t.listed)) return '$' + t.cost + ' <span class=dim>under its list of $' + t.listed + '</span>';
  return '$' + t.cost;
}

/** Beside an answer that came after other nodes failed: those nodes were paid nothing. Its source goes into the page. */
export function failedNote(n: number): string {
  return n ? ' <span class=sig>after ' + n + ' failed, ' + (n === 1 ? 'which was' : 'which were') + ' paid nothing</span>' : '';
}

/** Under the 24-hour spend: answers that came after a node did not answer or finish, and requests no node answered,
 * all of them signed nothing; empty when there were none. Its source goes into the page, with the two it uses. */
export function spendNotes(sp: { afterANodeDidNotAnswer?: { answers: number; nodes: number }; finishedByAnotherNode?: number; unanswered?: { requests: number; nodes: number } }): string {
  return [skipNote({ answers: sp.afterANodeDidNotAnswer?.answers ?? 0, nodes: sp.afterANodeDidNotAnswer?.nodes ?? 0, resumed: sp.finishedByAnotherNode ?? 0 }), sp.unanswered ? unansweredNote(sp.unanswered) : ''].filter((x) => x).join(' ');
}

export function consolePage(): string {
  return `${consoleHead(`${NAME} router`, 'Router console')}
<main>
<div><h1><span>Your router.</span> Every request, straight to a provider.</h1><p class="lede">Point any OpenAI-compatible tool at <code id="base">http://127.0.0.1/v1</code>, or an Anthropic client at the same address without <code>/v1</code>. Each answer is paid from your channel to the machine that served it; nothing in between.</p></div>
<div class="stats" id="sum"></div>
<p class="lede" id="standing" hidden></p>
<section><h2>Recent requests</h2><div class="wrap"><table><thead><tr><th>time</th><th>route</th><th>model</th><th>provider</th><th>tokens</th><th>paid</th><th>first token</th></tr></thead><tbody id="trips"></tbody></table></div></section>
<section><h2>Last 24 hours, by model</h2><div class="wrap"><table><thead><tr><th>model</th><th>answers</th><th>tokens in</th><th>tokens out</th><th>paid</th><th>kept for cache</th></tr></thead><tbody id="spend"></tbody></table></div><p class="lede" id="spendnote" hidden></p><p class="lede" id="spendkinds" hidden></p></section>
<section><div class="pay"><h2>Paid by day (UTC), last 7 days</h2><a class="check" id="spendcsv" href="/orrery/spend?by=day&amp;since=90d&amp;format=csv" download="orrery-spend-by-day.csv">Download 90 days as CSV</a></div><div class="wrap"><table><thead><tr><th>day</th><th>answers</th><th>tokens in</th><th>tokens out</th><th>paid</th></tr></thead><tbody id="spendday"></tbody></table></div><p class="lede" id="spendmonth" hidden></p><p class="lede" id="spendheld" hidden></p><p class="lede" id="spendprivate" hidden></p></section>
<section id="cardsec" hidden><div class="pay"><h2>This month, as a card</h2><button class="check" id="cardsave" type="button">Download PNG</button></div><canvas id="card" width="2400" height="1260" style="display:block;width:100%;height:auto;border:1px solid var(--line);border-radius:14px"></canvas></section>
<section id="agentsec" hidden><h2>Agents today (UTC)</h2><div class="wrap"><table><thead><tr><th>agent</th><th>daily limit</th><th>spent</th><th>left</th><th>models</th></tr></thead><tbody id="agents"></tbody></table></div></section>
<section><h2>Providers</h2><p class="lede" id="privacy" hidden></p><div class="wrap"><table><thead><tr><th>name</th><th>models</th><th>settled on chain</th><th>enclave</th><th>model server</th><th>this router’s record</th><th>state</th></tr></thead><tbody id="prov"></tbody></table></div></section>
<section id="p2psec" hidden><h2>Peers</h2><p class="lede" id="p2pline" hidden></p><div class="wrap"><table><thead><tr><th>peer</th><th>signed by</th><th>nodes</th><th>state</th></tr></thead><tbody id="peers"></tbody></table></div></section>
<section><h2>Channels</h2><div class="wrap"><table><thead><tr><th>provider</th><th>channel</th><th>deposit</th><th>spent</th><th>left</th></tr></thead><tbody id="ch"></tbody></table></div></section>
</main><script>
const paidCell=${paidCell.toString()};
const failedNote=${failedNote.toString()};
const skipNote=${skipNote.toString()};
const unansweredNote=${unansweredNote.toString()};
const spendNotes=${spendNotes.toString()};
const esc=s=>String(s??'').replace(/[&<>"]/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c]));
let cardMonth='';
function drawCard(m){const c=document.getElementById('card'),x=c.getContext('2d'),v=n=>getComputedStyle(document.documentElement).getPropertyValue(n).trim(),W=1200,H=630,P=64;x.setTransform(c.width/W,0,0,c.height/H,0,0);
cardMonth=m.month;const name=new Date(m.month+'-01T00:00:00Z').toLocaleString('en-US',{month:'long',year:'numeric',timeZone:'UTC'});
x.fillStyle=v('--bg')||'#000';x.fillRect(0,0,W,H);x.textBaseline='alphabetic';
x.font="500 26px 'Geist Mono',monospace";x.fillStyle=v('--fg2');x.textAlign='left';x.fillText('orrery router',P,P+22);x.textAlign='right';x.fillStyle=v('--fg3');x.fillText(name+' so far (UTC)',W-P,P+22);x.textAlign='left';
x.font="500 132px 'Instrument Sans',sans-serif";x.fillStyle=v('--fg');x.fillText('$'+m.usd,P-6,P+250);
x.font="400 34px 'Instrument Sans',sans-serif";x.fillStyle=v('--fg2');x.fillText('paid for '+Number(m.answers).toLocaleString('en-US')+' answer'+(m.answers===1?'':'s')+', each straight to the node that gave it',P,P+318);
if(m.saved&&Number(m.saved)>0){x.font="500 44px 'Instrument Sans',sans-serif";x.fillStyle=v('--green');x.fillText('$'+m.saved+' saved by holding $OREY',P,P+400);}
x.font="400 22px 'Geist Mono',monospace";x.fillStyle=v('--fg3');x.fillText("from my router's own log, on my machine",P,H-P);x.textAlign='right';x.fillText('0% taken in between',W-P,H-P);x.textAlign='left';}
document.getElementById('cardsave').onclick=()=>document.getElementById('card').toBlob(b=>{if(!b)return;const a=document.createElement('a');a.href=URL.createObjectURL(b);a.download='orrery-'+(cardMonth||'month')+'.png';document.body.appendChild(a);a.click();a.remove();setTimeout(()=>URL.revokeObjectURL(a.href),5000);});
async function tick(){try{const s=await (await fetch('/orrery/status')).json();const hv=document.querySelector('.here');if(hv&&s.version)hv.textContent='Router console · orrery-node '+s.version;
document.getElementById('base').textContent='http://127.0.0.1:'+location.port+'/v1';
document.getElementById('sum').innerHTML='<div><b>'+esc(s.privateOnly?'private only':s.route)+'</b><span class=cap>'+(s.privateOnly?'every request sealed':'default route')+'</span></div><div><b class=go>$'+esc(s.spentToday)+'</b><span class=cap>spent today</span></div><div><b>'+s.providers.length+'</b><span class=cap>providers</span></div><div><b>'+s.channels.length+'</b><span class=cap>open channels</span></div>';
const st=document.getElementById('standing'),sl=(s.holder&&s.holder.line?s.holder.line:'')+(s.holder&&s.holder.lane?' Peer relays carry this wallet past their daily limit: it rides the $OREY holder lanes.':'');st.textContent=sl;st.hidden=!sl;
const ag=s.agents||[];document.getElementById('agents').innerHTML=ag.map(a=>'<tr><td>'+esc(a.name)+'</td><td>'+(a.cap===null?'none':'$'+esc(a.cap))+'</td><td class=go>$'+esc(a.spent)+'</td><td>'+(a.left===null?'—':Number(a.left)>0?'$'+esc(a.left):'<span class=stop>spent until 00:00 UTC</span>')+'</td><td>'+(a.models&&a.models.length?a.models.map(esc).join(', '):'any')+'</td></tr>').join('');document.getElementById('agentsec').hidden=!ag.length;
document.getElementById('trips').innerHTML=s.trips.map(t=>'<tr><td>'+new Date(t.at).toLocaleTimeString()+'</td><td>'+esc(t.route)+(t.sealed?' <span class=go>sealed'+(t.enclave?' · '+esc(t.enclave.kind):'')+'</span>':t.wire?' <span class=sig>wire</span>':'')+(t.off?' <span class=go>holder −'+(t.off/100)+'%</span>':'')+'</td><td>'+esc(t.model)+'</td><td>'+esc(t.providerName)+failedNote(t.fellThrough)+(t.cacheKept?' <span class=go>kept for its cache</span>':'')+'</td><td>'+t.inputTokens+'+'+t.outputTokens+'</td><td class=go>'+paidCell(t)+'</td><td>'+t.ttftMs+' ms</td></tr>').join('')||'<tr class=empty><td colspan=7>No requests yet. Point a tool at http://127.0.0.1:'+location.port+'/v1</td></tr>';
{const pe=document.getElementById('privacy');pe.textContent=s.privacy?'Privacy: '+s.privacy.line+'.':'';pe.hidden=!s.privacy;}
{const ps=s.peers||[],rl=s.relay,bits=[];const mp=s.providers||[];if(mp.length&&(ps.length||s.discovery!=='chain')){const mc=f=>mp.filter(p=>(p.found||'rpc')===f).length;bits.push('the map: '+mp.length+' listing'+(mp.length===1?'':'s')+', '+[mc('rpc')?mc('rpc')+' in the RPC\u2019s list':'none in the RPC\u2019s list',mc('peers')?mc('peers')+' from peers':'',mc('record')?mc('record')+' from this router\u2019s own record':''].filter(Boolean).join(', '));}if(s.peerRelays&&s.peerRelays.length>1)bits.push('your requests to nodes are spread over '+s.peerRelays.length+' peer relays (--spread-relays), each node always through the same one');else if(s.peerRelay)bits.push('your requests to nodes go through '+s.peerRelay+', a peer\u2019s relay (--proxy-via-peers)');else if(s.proxyViaPeers)bits.push('--proxy-via-peers is on, but no peer relay can take your requests now: they go your own way');if(s.discovery==='peers')bits.push('the listings came from the peers\u2019 notes, each checked on chain');else if(s.discovery==='record')bits.push('the listings came from this router\u2019s own record of the nodes it watched before, each checked on chain');else if(s.rpcLeftOut)bits.push(s.rpcLeftOut+' listing'+(s.rpcLeftOut===1?'':'s')+' this RPC\u2019s list left out, named by the peers and read on chain');if(ps.length)bits.unshift(ps.length+' peer router'+(ps.length===1?'':'s')+': '+ps.filter(p=>p.signed&&!p.refused).length+' signed, '+ps.filter(p=>p.via).length+' met through a peer, '+ps.filter(p=>p.refused).length+' refused, '+ps.filter(p=>p.relayPort).length+' relaying'+(ps.filter(p=>p.relayPort&&p.relayFull).length?' ('+ps.filter(p=>p.relayPort&&p.relayFull).length+' full for today)':''));const rpe=ps.filter(p=>p.relayPort&&!p.refused);if(rpe.length)bits.push((rpe.length===1?'1 peer relays':rpe.length+' peers relay')+': point --proxy at '+(rpe.length===1?'it':'one')+' and the nodes see that router, not this computer');if(rl)bits.push('relay open on port '+rl.port+': carried '+rl.relayed+(rl.bytes>0?' ('+(rl.bytes<1024?rl.bytes+' B':rl.bytes<1048576?(rl.bytes/1024).toFixed(1)+' KB':(rl.bytes/1048576).toFixed(1)+' MB')+')':'')+', refused '+rl.refused+(rl.open!=null?', '+rl.open+' open now (up to '+rl.perClient+' for one address)':'')+(rl.maxBytes?', '+(rl.today<1048576?(rl.today/1024).toFixed(1)+' KB':(rl.today/1048576).toFixed(1)+' MB')+' of '+(rl.maxBytes/1048576).toFixed(1)+' MB today':'')+(rl.peersOnly?', for peer routers only':''));const pl=document.getElementById('p2pline');pl.textContent=bits.length?bits.join(' \u00b7 ')+'.':'';pl.hidden=!bits.length;document.getElementById('peers').innerHTML=ps.map(p=>'<tr><td>'+(p.name?'<b>'+esc(p.name)+'</b> ':'')+esc(p.url)+(p.pinned?' <span class=cap>pinned</span>':'')+(p.via?' <span class=cap>met through '+esc(p.via)+'</span>':'')+(p.kept?' <span class=cap>from before the restart</span>':'')+(typeof p.say==='number'&&p.say<1?' <span class=cap>counts '+Math.round(p.say*100)+'% under --trust-peers</span>':'')+(p.relayPort?' <span class=cap>relays on :'+p.relayPort+(p.relayOpen!=null?', '+p.relayOpen+' open':'')+(p.relayFull?', full for today':'')+(p.relayDownFor?', could not be reached, passed over '+Math.max(1,Math.ceil(p.relayDownFor/60))+' more min':'')+'</span>':'')+'</td><td>'+(p.by?esc(p.by.slice(0,4)+'\u2026'+p.by.slice(-4)):p.at===0?'\u2014':p.refused?'\u2014':'<span class=cap>unsigned</span>')+'</td><td>'+p.nodes+(p.unlisted?' <span class=cap>'+p.unlisted+' not on chain</span>':'')+'</td><td>'+(p.refused?'<span class=stop>refused: '+esc(p.refused)+'</span>':p.at===0?'<span class=stop>no answer yet ('+p.missed+' read'+(p.missed===1?'':'s')+' tried)</span>'+(p.retryAt>Date.now()?' <span class=cap>next read in '+Math.max(1,Math.ceil((p.retryAt-Date.now())/60000))+' min</span>':''):'<span class=go>'+(p.signed?'signed, checks':'read, unsigned')+'</span>'+(p.readMs!=null?' <span class=cap>'+p.readMs+' ms</span>':'')+(p.missed?' <span class=cap>no answer to the last '+(p.missed===1?'read':p.missed+' reads')+'</span>':''))+'</td></tr>').join('');document.getElementById('p2psec').hidden=!(ps.length||rl||s.discovery==='peers'||s.discovery==='record'||s.rpcLeftOut||s.proxyViaPeers);}
document.getElementById('prov').innerHTML=s.providers.map(p=>'<tr><td>'+esc(p.name||p.address.slice(0,8))+(p.found==='peers'?' <span class=cap>found through peers</span>':p.found==='record'?' <span class=cap>from this router\u2019s record</span>':'')+'</td><td>'+p.models+'</td><td>$'+esc(p.settled)+' · '+p.redeems+' redeems</td><td>'+(p.tee?(p.tee.verified?'<span class=go>verified</span>':'<span class=stop>'+esc(p.tee.reason)+'</span>'):'—')+'</td><td>'+(p.modelServer==='up'?'<span class=go>up</span>'+(p.healthMs!=null?' · '+p.healthMs+' ms':''):p.modelServer==='down'?'<span class=stop>down, skipped</span>':'—')+'</td><td class=rec>'+(p.record&&p.record.length?p.record.map(esc).join('<br>'):p.observed.ok+' ok / '+p.observed.fail+' failed')+'</td><td>'+(p.problem?'<span class=stop>'+esc(p.problem)+'</span>':p.active?(p.full?'<span class=sig>full · asked after the others for '+p.full+' s</span>':'<span class=go>open</span>'):'closed')+'</td></tr>').join('');
try{const sp=await (await fetch('/orrery/spend?since=24h&by=model')).json();const rows=[...sp.rows,{...sp.total,key:'total'}];document.getElementById('spend').innerHTML=sp.total.answers?rows.map(r=>'<tr><td>'+esc(r.key)+'</td><td>'+r.answers+'</td><td>'+Number(r.inputTokens).toLocaleString('en-US')+'</td><td>'+Number(r.outputTokens).toLocaleString('en-US')+'</td><td class=go>$'+esc(r.usd)+'</td><td>'+(r.cacheKept||'—')+'</td></tr>').join(''):'<tr class=empty><td colspan=6>Nothing paid in the last 24 hours.</td></tr>';const note=spendNotes(sp),el=document.getElementById('spendnote');el.textContent=note;el.hidden=!note;}catch(e){}
try{const sk=await (await fetch('/orrery/spend?since=24h&by=kind')).json(),kr=(sk.rows||[]),ke=document.getElementById('spendkinds');ke.textContent=kr.length>1?'By kind of work: '+kr.map(k=>k.key+' '+Number(k.answers).toLocaleString('en-US')+' answer'+(Number(k.answers)===1?'':'s')+', $'+k.usd).join(' · ')+'.':'';ke.hidden=!(kr.length>1);}catch(e){}
try{const sd=await (await fetch('/orrery/spend?since=7d&by=day')).json();document.getElementById('spendday').innerHTML=sd.total.answers?[...sd.rows,{...sd.total,key:'total'}].map(r=>'<tr><td>'+esc(r.key)+'</td><td>'+Number(r.answers).toLocaleString('en-US')+'</td><td>'+Number(r.inputTokens).toLocaleString('en-US')+'</td><td>'+Number(r.outputTokens).toLocaleString('en-US')+'</td><td class=go>$'+esc(r.usd)+'</td></tr>').join(''):'<tr class=empty><td colspan=5>Nothing paid in the last 7 days.</td></tr>';const sm=document.getElementById('spendmonth');sm.textContent=sd.month&&sd.month.answers?sd.month.line+'.':'';sm.hidden=!(sd.month&&sd.month.answers);const sh=document.getElementById('spendheld');sh.textContent=sd.held&&sd.held.answers?sd.held.line:'';sh.hidden=!(sd.held&&sd.held.answers);const sp=document.getElementById('spendprivate');sp.textContent=sd.private&&sd.private.answers?sd.private.line:'';sp.hidden=!(sd.private&&sd.private.answers);
const cs=document.getElementById('cardsec');if(sd.month&&sd.month.answers){drawCard(sd.month);cs.hidden=false;}else cs.hidden=true;}catch(e){}
document.getElementById('ch').innerHTML=s.channels.map(c=>'<tr><td>'+esc(c.provider.slice(0,8))+'</td><td>'+esc(c.channel.slice(0,8))+'</td><td>$'+esc(c.deposit)+'</td><td>$'+esc(c.spent)+'</td><td>$'+esc(c.left)+'</td></tr>').join('')||'<tr class=empty><td colspan=5>None yet. The first request to a provider opens one.</td></tr>';
}catch(e){}}tick();setInterval(tick,2000);
</script></body></html>`;
}
