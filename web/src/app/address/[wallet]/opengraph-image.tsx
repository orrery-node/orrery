import { ImageResponse } from 'next/og';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { usd } from '@/lib/rehearsal';
import { validAddress, wallet } from '@/lib/wallet';

export const size = { width: 1200, height: 630 };
export const contentType = 'image/png';
export const alt = 'What this address did on Orrery, read from the program on Solana';

const short = (a: string) => `${a.slice(0, 4)}…${a.slice(-4)}`;
const money = (u: bigint) => {
  const [w, f] = usd(u).split('.');
  const t = f.replace(/0+$/, '');
  return `$${w}.${t.length < 2 ? t.padEnd(2, '0') : t}`;
};
const day = (s: number) => (s ? new Date(s * 1000).toISOString().slice(0, 10) : '—');

export default async function Image({ params }: { params: Promise<{ wallet: string }> }) {
  const { wallet: raw } = await params;
  const address = validAddress(raw) ?? raw;
  const [sans, mono] = await Promise.all([
    readFile(join(process.cwd(), 'src/og/InstrumentSans-Medium.ttf')),
    readFile(join(process.cwd(), 'src/og/GeistMono-Regular.ttf')),
  ]);
  const w = validAddress(raw) ? await wallet(address) : null;
  const node = w?.nodes[0];
  const title = node ? node.name ?? `Node ${short(node.address)}` : `Wallet ${short(address)}`;
  const stats: [string, string, boolean][] = node
    ? [
        ['Earned on chain', money(BigInt(node.settled)), true],
        ['Redeems', String(node.redeems), false],
        ['Channels opened to it', String(node.channels), false],
        ['Listed', day(node.registeredAt), false],
      ]
    : [
        ['Paid out to nodes', money((w?.channels ?? []).reduce((a, c) => a + BigInt(c.redeemed), 0n)), true],
        ['Channels on chain', String(w?.channels.length ?? 0), false],
        ['Deposited', money((w?.channels ?? []).reduce((a, c) => a + BigInt(c.deposit), 0n)), false],
      ];

  return new ImageResponse(
    (
      <div style={{ width: '100%', height: '100%', display: 'flex', flexDirection: 'column', justifyContent: 'space-between', background: '#000', color: '#f7f7f7', padding: '64px 72px', fontFamily: 'Instrument Sans' }}>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 14, fontSize: 30 }}>
            <div style={{ width: 14, height: 14, borderRadius: 7, background: '#9945ff' }} />
            Orrery
          </div>
          <div style={{ display: 'flex', fontFamily: 'Geist Mono', fontSize: 20, color: '#14f195' }}>READ FROM SOLANA MAINNET</div>
        </div>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 18 }}>
          <div style={{ display: 'flex', fontSize: 30, color: '#9c9c9c' }}>{node ? 'A node on Orrery' : 'A wallet on Orrery'}</div>
          <div style={{ display: 'flex', fontSize: 84, letterSpacing: '-0.035em', lineHeight: 1 }}>{title}</div>
          <div style={{ display: 'flex', fontFamily: 'Geist Mono', fontSize: 22, color: '#858585' }}>{address}</div>
        </div>
        <div style={{ display: 'flex', borderTop: '1px solid #2e2e2e', paddingTop: 28 }}>
          {stats.map(([k, v, green], i) => (
            <div key={k} style={{ display: 'flex', flexDirection: 'column', flex: 1, paddingLeft: i ? 28 : 0, borderLeft: i ? '1px solid #2e2e2e' : 'none', gap: 10 }}>
              <div style={{ display: 'flex', fontSize: 22, color: '#9c9c9c' }}>{k}</div>
              <div style={{ display: 'flex', fontFamily: 'Geist Mono', fontSize: 40, color: green ? '#14f195' : '#f7f7f7' }}>{v}</div>
            </div>
          ))}
        </div>
      </div>
    ),
    {
      ...size,
      fonts: [
        { name: 'Instrument Sans', data: sans, weight: 500, style: 'normal' },
        { name: 'Geist Mono', data: mono, weight: 400, style: 'normal' },
      ],
    },
  );
}
