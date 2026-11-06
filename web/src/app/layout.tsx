import type { Metadata, Viewport } from 'next';
import { Geist_Mono, Instrument_Sans } from 'next/font/google';
import { NAME, SITE_URL } from '@/brand';
import './globals.css';
import './site.css';

const sans = Instrument_Sans({ subsets: ['latin'], weight: ['400', '500', '600'], variable: '--font-sans', display: 'swap' });
const mono = Geist_Mono({ subsets: ['latin'], weight: ['400', '500'], variable: '--font-mono', display: 'swap' });

export const metadata: Metadata = {
  metadataBase: new URL(SITE_URL),
  title: `${NAME} — AI inference, peer to peer`,
  description: `${NAME} is a peer-to-peer AI inference network on Solana. A router on your computer picks a provider for every request and pays it directly. The program takes 0%.`,
  openGraph: {
    title: `${NAME} — AI inference, peer to peer`,
    description: 'A router on your computer, providers anyone can run, payments straight to them on Solana. Zero cut in between.',
    images: [{ url: '/og.jpg', width: 1280, height: 640, alt: `${NAME}: AI inference, peer to peer. Zero cut in between.` }],
  },
  twitter: { card: 'summary_large_image', site: '@OrreryNode', creator: '@OrreryNode', images: ['/og.jpg'] },
};

export const viewport: Viewport = { themeColor: '#000000', colorScheme: 'dark' };

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" className={`${sans.variable} ${mono.variable}`}>
      <body>
        {children}
      </body>
    </html>
  );
}
