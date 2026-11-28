import { describe, it } from 'node:test';
import { runInNewContext, Script } from 'node:vm';
import assert from 'node:assert/strict';
import { fontFaces } from '../devtools/fonts.ts';
import * as routerConsole from '../src/router/console.ts';
import { consolePage } from '../src/router/console.ts';
import { FONT_FACES } from '../src/router/fonts.ts';
import { consoleKeyPage, providerConsolePage } from '../src/provider/console.ts';

/** Every address a page could make a browser ask: http(s) URLs and protocol-relative ones, apart from this computer. */
const outside = (html: string) => [...html.matchAll(/(?:https?:)?\/\/([A-Za-z0-9.-]+\.[A-Za-z]{2,})/g)].map((m) => m[1]).filter((h) => h !== '127.0.0.1');

describe('the local console pages', () => {
  const pages = { router: consolePage(), node: providerConsolePage(), 'node, asking for its key': consoleKeyPage() };

  it('ask nothing of any other computer: no font link, no script, no image from outside', () => {
    for (const [name, html] of Object.entries(pages)) {
      assert.deepEqual(outside(html), [], `${name} console`);
      assert.ok(!/<link\b/i.test(html), `${name} console has no <link>`);
      assert.ok(!/<script[^>]+src=/i.test(html) && !/<img\b/i.test(html), `${name} console loads no script or image`);
    }
  });

  it('carry scripts that parse as JavaScript, so an escape lost in the page template cannot blank the console', () => {
    for (const [name, html] of Object.entries(pages)) {
      const scripts = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map((m) => m[1]);
      for (const [i, body] of scripts.entries()) assert.doesNotThrow(() => new Script(body), `${name} console, script ${i + 1}`);
    }
  });

  it('the router console says what it heard on its own network and what it says there, with the code the page runs', () => {
    const html = consolePage();
    assert.ok(html.includes('const lanBits=') && html.includes('bits.push(...lanBits(s))'), 'inlined and used');
    const status = { lan: { listening: '0.0.0.0:7373', heard: 2, nodes: 1, routers: [{ key: 'K', url: 'http://192.168.1.30:7171' }], peers: false }, lanAnnouncing: { to: '192.168.1.255:7373', url: 'http://192.168.1.20:7171', sent: 1 } };
    const want = ['listening on 0.0.0.0:7373 for nodes on this network: 2 heard, 1 reached there directly', '1 router heard on this network, each signed with its own key (--lan-peers reads them as peers)', 'this router says where its notes are on this network (http://192.168.1.20:7171): 1 beacon sent, signed with its key'];
    assert.deepEqual(routerConsole.lanBits(status), want);
    const src = html.slice(html.indexOf('const lanBits=') + 'const lanBits='.length, html.indexOf(';\nconst esc='));
    assert.deepEqual(JSON.parse(JSON.stringify(runInNewContext(`(${src})(s)`, { s: status }))), want, 'the inlined copy runs on its own');
    assert.deepEqual(routerConsole.lanBits({ lan: null, lanAnnouncing: null }), []);
  });

  it('the node console says where the node says it is on its network, with the code the page runs', () => {
    const html = providerConsolePage();
    assert.ok(html.includes('id="lan"') && html.includes('const lanSentence=') && html.includes('lanSentence(s.lan,Date.now())'), 'the line and its code');
    const at = html.indexOf('const lanSentence=') + 'const lanSentence='.length;
    const src = html.slice(at, html.indexOf(';\nconst ', at));
    const a = { to: '192.168.1.255:7373', url: 'http://192.168.1.20:7070', sent: 4, at: 1_000 };
    const want = 'On this network: saying where this node is to 192.168.1.255:7373 every 15 s, signed with the node key; routers there reach it at http://192.168.1.20:7070 (4 sent, the last 12 s ago).';
    assert.equal(String(runInNewContext(`(${src})(a, 13400)`, { a })), want, 'the inlined copy runs on its own');
    assert.equal(String(runInNewContext(`(${src})(null, 0)`, {})), '');
  });

  it('carry their two typefaces inside the page', () => {
    for (const [name, html] of Object.entries(pages)) {
      assert.equal((html.match(/@font-face/g) ?? []).length, 2, `${name} console`);
      assert.ok(html.includes("font-family:'Instrument Sans'") && html.includes("font-family:'Geist Mono'"), name);
      assert.ok(html.includes('url(data:font/woff2;base64,'), name);
    }
  });

  it('carry exactly the font files in assets/fonts', () => {
    assert.equal(FONT_FACES, fontFaces(), 'src/router/fonts.ts is written by devtools/fonts.ts; run it again');
  });

  it('would notice a font link coming back', () => {
    assert.deepEqual(outside('<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=X">'), ['fonts.googleapis.com']);
    assert.deepEqual(outside('<script src="//cdn.example.com/a.js"></script>'), ['cdn.example.com']);
  });

  it('carry no build helper in the code they inline, so it runs in a browser as it does here', () => {
    for (const [name, html] of Object.entries(pages)) assert.ok(!/__name\(|__defProp|__export\(/.test(html), `${name} console inlines a helper the browser does not have`);
    const html = providerConsolePage();
    const src = html.slice(html.indexOf('const payoutRows=') + 'const payoutRows='.length, html.indexOf(';\nconst esc='));
    const p = { day: { units: '120000', count: 1 }, recent: [{ at: 0, units: '120000', channels: 1, tx: '5GhKq2abcdefXYZ5GhKq2abcdefXYZ5GhKq2' }] };
    assert.match(String(runInNewContext(`(${src})(p)`, { p })), /\$0\.120000.*last 24 h/, 'the inlined payout rows run on their own');
  });

  it('the node’s console says whether anything outside is reaching the node, and the inlined sentence runs on its own', () => {
    const html = providerConsolePage();
    assert.ok(html.includes('id="reach"') && html.includes('const reachSentence=') && html.includes('reachSentence(s.reach,'), 'the line and its code');
    const src = html.slice(html.indexOf('const reachSentence=') + 'const reachSentence='.length, html.indexOf(';\nconst payoutRows='));
    assert.equal(String(runInNewContext(`(${src})(r, 1000)`, { r: { lastHour: 2, lastAt: 0, upMs: 5000 } })), 'Checked from outside this computer 2 times in the last hour, the last 1 s ago: routers can reach this node.');
  });

  it('the node’s console lists its payouts to the wallet, with the code that writes them', () => {
    const html = providerConsolePage();
    assert.ok(html.includes('id="payouts"'), 'a table for the payouts');
    assert.ok(html.includes('const payoutRows=') && html.includes('payoutRows(s.payouts)'), 'the rows from /orrery/status');
  });

  it('the node’s console checks its payouts against the chain when asked, and the inlined rows say what arrived', () => {
    const html = providerConsolePage();
    assert.ok(html.includes('id="check"') && html.includes("fetch('/orrery/payouts/check',K)") && html.includes('s.payouts.checked=Object.assign({},s.payouts.checked,checked)') && html.includes('<th>on chain</th>'), 'the button, the call and the column');
    const src = html.slice(html.indexOf('const payoutRows=') + 'const payoutRows='.length, html.indexOf(';\nconst esc='));
    const tx = '5GhKq2abcdefXYZ5GhKq2abcdefXYZ5GhKq2';
    const p = { day: { units: '120000', count: 1 }, recent: [{ at: 0, units: '120000', channels: 1, tx }], checked: { [tx]: { state: 'landed', units: '120000' } } };
    assert.match(String(runInNewContext(`(${src})(p)`, { p })), /<span class=go>arrived \$0\.120000<\/span>/, 'the inlined rows run on their own');
  });

  it('the node’s console shows what the wallet held after the last payout, per the chain, once the node has read it back', () => {
    const html = providerConsolePage();
    assert.ok(html.includes('in your wallet, per the chain') && html.includes("className=s.wallet?'stats five':'stats'") && html.includes('.stats.five{grid-template-columns:repeat(5,'), 'the stat, its layout and its code');
  });

  it('the node’s console says how many slots are answering and how often holders went ahead, and the inlined sentence runs on its own', () => {
    const html = providerConsolePage();
    assert.ok(html.includes('id="slots"') && html.includes('const slotsSentence=') && html.includes('slotsSentence(s.slots)'), 'the line and its code');
    const src = html.slice(html.indexOf('const slotsSentence=') + 'const slotsSentence='.length, html.indexOf(';\nconst checked='));
    assert.equal(String(runInNewContext(`(${src})(s)`, { s: { size: 4, busy: 4, waiting: 2, holdersWaiting: 1, holdersAhead: 3 } })), '4 of 4 answering, 2 waiting (1 a holder); holders went ahead 3 times since start');
  });

  it('the node’s console lays out the last seven days of its books, from the node’s own files', () => {
    const html = providerConsolePage();
    assert.ok(html.includes('Your books by day (UTC), last 7 days') && html.includes('id="days"') && html.includes("fetch('/orrery/books?since=7d',K)"), 'the table and its call');
  });

  it('the node’s console says how much fee money the node key has left for payouts, and warns when it runs low', () => {
    const html = providerConsolePage();
    assert.ok(html.includes('id="fees"') && html.includes("'Fee money for payouts: '+e.fees.line") && html.includes("e.fees.low?'lede stop':'lede'"), 'the line, its text and its warning');
  });

  it('the node’s console downloads its books as CSV from the node itself, a link to this computer only', () => {
    const html = providerConsolePage();
    assert.ok(html.includes('id="csv"') && html.includes('download="orrery-books.csv"') && html.includes("'/orrery/books?since=90d&format=csv&key='"), 'the link and where it points');
  });

  it('shows the router’s own record of each node, not only what it counted since it started', () => {
    const html = consolePage();
    assert.ok(html.includes('<th>this router’s record</th>'), 'a column for the record');
    assert.ok(html.includes('p.record'), 'the record lines from /orrery/status');
  });

  it('shows, beside what each answer cost, how the node’s bill compared with its listed prices, and that nodes which failed first were paid nothing', () => {
    const c = routerConsole as unknown as { paidCell?: (t: { cost: string; billed?: string; listed?: string }) => string; failedNote?: (n: number) => string };
    assert.equal(typeof c.paidCell, 'function', 'console.ts renders the paid cell');
    assert.equal(c.paidCell!({ cost: '0.000015', billed: '0.000020', listed: '0.000015' }), '$0.000015 <span class=sig>it asked $0.000020; paid its listed price</span>');
    assert.equal(c.paidCell!({ cost: '0.000012', billed: '0.000012', listed: '0.000015' }), '$0.000012 <span class=dim>under its list of $0.000015</span>');
    assert.equal(c.paidCell!({ cost: '0.000021', billed: '0.000021', listed: '0.000021' }), '$0.000021');
    assert.equal(c.paidCell!({ cost: '0.000021' }), '$0.000021', 'an answer logged before 0.1.18');
    assert.equal(c.failedNote!(1), ' <span class=sig>after 1 failed, which was paid nothing</span>');
    assert.equal(c.failedNote!(2), ' <span class=sig>after 2 failed, which were paid nothing</span>');
    assert.equal(c.failedNote!(0), '');
    const html = consolePage();
    assert.ok(html.includes('paidCell(t)') && html.includes('failedNote(t.fellThrough)'), 'the page uses both');
  });

  it('the node’s month card writes its books, cuts a long node name short of the month, and says billed before any payout', () => {
    const page = providerConsolePage();
    const src = page.slice(page.indexOf('function drawCard(m,node)'), page.indexOf("\ndocument.getElementById('cardsave')"));
    const draw = (m: Record<string, unknown>, node: string) => {
      const out: { t: string; at: number; align: string }[] = [];
      const ctx: Record<string, unknown> = { textAlign: 'left', fillText(t: string, at: number) { out.push({ t, at, align: String(ctx.textAlign) }); }, measureText: (t: string) => ({ width: t.length * 15.6 }), setTransform() {}, fillRect() {} };
      runInNewContext(`let cardMonth='';${src};drawCard(M,N)`, { M: m, N: node, document: { documentElement: {}, getElementById: () => ({ width: 2400, height: 1260, getContext: () => ctx }) }, getComputedStyle: () => ({ getPropertyValue: () => '' }), Number, Date });
      return out;
    };
    const month = { day: '2026-11', answers: 312, billed: '0.912500', payouts: 14, paid: '0.887250' };
    const texts = draw(month, 'Ironbridge Compute').map((o) => o.t);
    assert.deepEqual(texts.slice(0, 5), ['orrery node · Ironbridge Compute', 'November 2026 so far (UTC)', '$0.887250', 'paid out to my wallet in 14 payouts, for 312 answers', 'each answer paid on its own, $0.912500 billed']);
    const long = draw(month, 'A Very Long Node Name That Goes On And On Compute');
    const head = long[0].t, monthLabel = long[1].t;
    assert.ok(head.endsWith('…') && head.startsWith('orrery node · A Very'), head);
    assert.ok(64 + head.length * 15.6 <= 1200 - 64 - monthLabel.length * 15.6 - 40 + 15.6, `${head} runs into ${monthLabel}`);
    const unpaid = draw({ ...month, payouts: 0, paid: '0.000000' }, 'Ironbridge Compute').map((o) => o.t);
    assert.ok(unpaid.includes('$0.912500') && unpaid.includes('billed for 312 answers; the first payout goes out once it adds up') && !unpaid.some((t) => t.startsWith('each answer')), unpaid.join(' | '));
  });
});
