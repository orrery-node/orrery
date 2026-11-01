// The page at http://127.0.0.1:7171/ — what the router did, read from /yard/status. Plain HTML, no build step.
import { NAME } from '../brand.ts';

export function consolePage(): string {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${NAME} router</title>
<style>
:root{--bg:#111312;--panel:#181b1a;--line:#2a2f2d;--fg:#e8ebe9;--dim:#8d9692;--go:#7fd18b;--stop:#f08a6c;--sig:#f2c14e}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--fg);font:14px/1.5 ui-monospace,SFMono-Regular,Menlo,monospace;padding:24px 16px}
main{max-width:1100px;margin:0 auto;display:grid;gap:24px}h1{font-size:15px;font-weight:600;margin:0;letter-spacing:.02em}
.row{display:flex;gap:24px;flex-wrap:wrap;color:var(--dim)}.row b{color:var(--fg);font-weight:600}
table{width:100%;border-collapse:collapse;font-variant-numeric:tabular-nums}th,td{text-align:left;padding:7px 10px;border-bottom:1px solid var(--line);white-space:nowrap}
th{color:var(--dim);font-weight:500;font-size:12px;text-transform:uppercase;letter-spacing:.06em}.wrap{overflow-x:auto;border:1px solid var(--line);background:var(--panel)}
.go{color:var(--go)}.stop{color:var(--stop)}.sig{color:var(--sig)}h2{font-size:12px;color:var(--dim);font-weight:500;text-transform:uppercase;letter-spacing:.08em;margin:0 0 8px}
</style></head><body><main>
<h1>${NAME} · router on this computer</h1>
<div class="row" id="sum"></div>
<section><h2>Recent requests</h2><div class="wrap"><table><thead><tr><th>time</th><th>route</th><th>model</th><th>provider</th><th>tokens</th><th>paid</th><th>first token</th></tr></thead><tbody id="trips"></tbody></table></div></section>
<section><h2>Providers</h2><div class="wrap"><table><thead><tr><th>name</th><th>models</th><th>settled on chain</th><th>enclave</th><th>seen</th><th>state</th></tr></thead><tbody id="prov"></tbody></table></div></section>
<section><h2>Channels</h2><div class="wrap"><table><thead><tr><th>provider</th><th>channel</th><th>deposit</th><th>spent</th><th>left</th></tr></thead><tbody id="ch"></tbody></table></div></section>
</main><script>
const esc=s=>String(s??'').replace(/[&<>"]/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c]));
async function tick(){try{const s=await (await fetch('/yard/status')).json();
document.getElementById('sum').innerHTML='<span>route <b>'+esc(s.route)+'</b></span><span>spent today <b>$'+esc(s.spentToday)+'</b></span><span>providers <b>'+s.providers.length+'</b></span><span>channels <b>'+s.channels.length+'</b></span>';
document.getElementById('trips').innerHTML=s.trips.map(t=>'<tr><td>'+new Date(t.at).toLocaleTimeString()+'</td><td>'+esc(t.route)+(t.sealed?' <span class=go>sealed</span>':'')+'</td><td>'+esc(t.model)+'</td><td>'+esc(t.providerName)+(t.fellThrough?' <span class=sig>after '+t.fellThrough+' failed</span>':'')+'</td><td>'+t.inputTokens+'+'+t.outputTokens+'</td><td>$'+esc(t.cost)+'</td><td>'+t.ttftMs+' ms</td></tr>').join('')||'<tr><td colspan=7>No requests yet. Point a tool at http://127.0.0.1:'+location.port+'/v1</td></tr>';
document.getElementById('prov').innerHTML=s.providers.map(p=>'<tr><td>'+esc(p.name||p.address.slice(0,8))+'</td><td>'+p.models+'</td><td>$'+esc(p.settled)+' · '+p.redeems+' redeems</td><td>'+(p.tee?(p.tee.verified?'<span class=go>verified</span>':'<span class=stop>'+esc(p.tee.reason)+'</span>'):'—')+'</td><td>'+p.observed.ok+' ok / '+p.observed.fail+' failed</td><td>'+(p.problem?'<span class=stop>'+esc(p.problem)+'</span>':p.active?'<span class=go>open</span>':'closed')+'</td></tr>').join('');
document.getElementById('ch').innerHTML=s.channels.map(c=>'<tr><td>'+esc(c.provider.slice(0,8))+'</td><td>'+esc(c.channel.slice(0,8))+'</td><td>$'+esc(c.deposit)+'</td><td>$'+esc(c.spent)+'</td><td>$'+esc(c.left)+'</td></tr>').join('')||'<tr><td colspan=5>None yet. The first request to a provider opens one.</td></tr>';
}catch(e){}}tick();setInterval(tick,2000);
</script></body></html>`;
}
