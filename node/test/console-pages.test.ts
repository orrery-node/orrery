import { describe, it } from 'node:test';
import { runInNewContext } from 'node:vm';
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

  it('the node’s console lists its payouts to the wallet, with the code that writes them', () => {
    const html = providerConsolePage();
    assert.ok(html.includes('id="payouts"'), 'a table for the payouts');
    assert.ok(html.includes('const payoutRows=') && html.includes('payoutRows(s.payouts)'), 'the rows from /orrery/status');
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
});
