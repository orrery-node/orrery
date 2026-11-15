import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { fontFaces } from '../devtools/fonts.ts';
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
});
