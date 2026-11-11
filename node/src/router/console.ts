// The page at http://127.0.0.1:7171/ — what the router did, read from /orrery/status. Plain HTML, no build step.
import { NAME } from '../brand.ts';

/** The shared page head, styles and header bar of the local consoles (router and provider). */
export function consoleHead(title: string, here: string): string {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${title}</title>
<link rel="preconnect" href="https://fonts.googleapis.com"><link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Geist+Mono:wght@400;500&family=Instrument+Sans:wght@400;500;600&display=swap">
<style>
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
.go{color:var(--green)}.stop{color:var(--warn)}.sig{color:var(--purple)}.empty td{color:var(--fg3);font-family:var(--sans);font-size:14px;padding:22px 16px}
@media (max-width:760px){.stats{grid-template-columns:repeat(2,minmax(0,1fr))}.stats div:nth-child(3){border-left:0}.stats div:nth-child(n+3){border-top:1px solid var(--line)}.live{display:none}}
</style></head><body>
<header><span class="brand"><svg width="22" height="22" viewBox="0 0 24 24" aria-hidden="true"><defs><linearGradient id="g" x1="2" y1="18" x2="22" y2="6" gradientUnits="userSpaceOnUse"><stop offset="0" stop-color="#9945ff"/><stop offset=".5" stop-color="#5f8ff2"/><stop offset="1" stop-color="#14f195"/></linearGradient></defs><ellipse cx="12" cy="12" rx="10.2" ry="4.3" fill="none" stroke="url(#g)" stroke-width="1.3"/><ellipse cx="12" cy="12" rx="10.2" ry="4.3" fill="none" stroke="url(#g)" stroke-width="1.3" opacity=".6" transform="rotate(62 12 12)"/><circle cx="12" cy="12" r="2.5" fill="#f5f5f5"/><circle cx="20.6" cy="9.7" r="1.7" fill="#14f195"/></svg><span class="grad">${NAME}</span></span><span class="here">${here}</span><span class="live"><i></i>live from this computer</span></header>`;
}

export function consolePage(): string {
  return `${consoleHead(`${NAME} router`, 'Router console')}
<main>
<div><h1><span>Your router.</span> Every request, straight to a provider.</h1><p class="lede">Point any OpenAI-compatible tool at <code id="base">http://127.0.0.1/v1</code>, or an Anthropic client at the same address without <code>/v1</code>. Each answer is paid from your channel to the machine that served it; nothing in between.</p></div>
<div class="stats" id="sum"></div>
<section><h2>Recent requests</h2><div class="wrap"><table><thead><tr><th>time</th><th>route</th><th>model</th><th>provider</th><th>tokens</th><th>paid</th><th>first token</th></tr></thead><tbody id="trips"></tbody></table></div></section>
<section><h2>Last 24 hours, by model</h2><div class="wrap"><table><thead><tr><th>model</th><th>answers</th><th>tokens in</th><th>tokens out</th><th>paid</th><th>kept for cache</th></tr></thead><tbody id="spend"></tbody></table></div></section>
<section><h2>Providers</h2><div class="wrap"><table><thead><tr><th>name</th><th>models</th><th>settled on chain</th><th>enclave</th><th>model server</th><th>seen</th><th>state</th></tr></thead><tbody id="prov"></tbody></table></div></section>
<section><h2>Channels</h2><div class="wrap"><table><thead><tr><th>provider</th><th>channel</th><th>deposit</th><th>spent</th><th>left</th></tr></thead><tbody id="ch"></tbody></table></div></section>
</main><script>
const esc=s=>String(s??'').replace(/[&<>"]/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c]));
async function tick(){try{const s=await (await fetch('/orrery/status')).json();
document.getElementById('base').textContent='http://127.0.0.1:'+location.port+'/v1';
document.getElementById('sum').innerHTML='<div><b>'+esc(s.privateOnly?'private only':s.route)+'</b><span class=cap>'+(s.privateOnly?'every request sealed':'default route')+'</span></div><div><b class=go>$'+esc(s.spentToday)+'</b><span class=cap>spent today</span></div><div><b>'+s.providers.length+'</b><span class=cap>providers</span></div><div><b>'+s.channels.length+'</b><span class=cap>open channels</span></div>';
document.getElementById('trips').innerHTML=s.trips.map(t=>'<tr><td>'+new Date(t.at).toLocaleTimeString()+'</td><td>'+esc(t.route)+(t.sealed?' <span class=go>sealed'+(t.enclave?' · '+esc(t.enclave.kind):'')+'</span>':t.wire?' <span class=sig>wire</span>':'')+(t.off?' <span class=go>holder −'+(t.off/100)+'%</span>':'')+'</td><td>'+esc(t.model)+'</td><td>'+esc(t.providerName)+(t.fellThrough?' <span class=sig>after '+t.fellThrough+' failed</span>':'')+(t.cacheKept?' <span class=go>kept for its cache</span>':'')+'</td><td>'+t.inputTokens+'+'+t.outputTokens+'</td><td class=go>$'+esc(t.cost)+'</td><td>'+t.ttftMs+' ms</td></tr>').join('')||'<tr class=empty><td colspan=7>No requests yet. Point a tool at http://127.0.0.1:'+location.port+'/v1</td></tr>';
document.getElementById('prov').innerHTML=s.providers.map(p=>'<tr><td>'+esc(p.name||p.address.slice(0,8))+'</td><td>'+p.models+'</td><td>$'+esc(p.settled)+' · '+p.redeems+' redeems</td><td>'+(p.tee?(p.tee.verified?'<span class=go>verified</span>':'<span class=stop>'+esc(p.tee.reason)+'</span>'):'—')+'</td><td>'+(p.modelServer==='up'?'<span class=go>up</span>'+(p.healthMs!=null?' · '+p.healthMs+' ms':''):p.modelServer==='down'?'<span class=stop>down, skipped</span>':'—')+'</td><td>'+p.observed.ok+' ok / '+p.observed.fail+' failed</td><td>'+(p.problem?'<span class=stop>'+esc(p.problem)+'</span>':p.active?'<span class=go>open</span>':'closed')+'</td></tr>').join('');
try{const sp=await (await fetch('/orrery/spend?since=24h&by=model')).json();const rows=[...sp.rows,{...sp.total,key:'total'}];document.getElementById('spend').innerHTML=sp.total.answers?rows.map(r=>'<tr><td>'+esc(r.key)+'</td><td>'+r.answers+'</td><td>'+Number(r.inputTokens).toLocaleString('en-US')+'</td><td>'+Number(r.outputTokens).toLocaleString('en-US')+'</td><td class=go>$'+esc(r.usd)+'</td><td>'+(r.cacheKept||'—')+'</td></tr>').join(''):'<tr class=empty><td colspan=6>Nothing paid in the last 24 hours.</td></tr>';}catch(e){}
document.getElementById('ch').innerHTML=s.channels.map(c=>'<tr><td>'+esc(c.provider.slice(0,8))+'</td><td>'+esc(c.channel.slice(0,8))+'</td><td>$'+esc(c.deposit)+'</td><td>$'+esc(c.spent)+'</td><td>$'+esc(c.left)+'</td></tr>').join('')||'<tr class=empty><td colspan=5>None yet. The first request to a provider opens one.</td></tr>';
}catch(e){}}tick();setInterval(tick,2000);
</script></body></html>`;
}
