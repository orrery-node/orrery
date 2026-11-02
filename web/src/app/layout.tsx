import type { Metadata, Viewport } from 'next';
import { Fragment_Mono, Hanken_Grotesk } from 'next/font/google';
import { NAME, SITE_URL } from '@/brand';
import './globals.css';
import './site.css';

const sans = Hanken_Grotesk({ subsets: ['latin'], weight: ['400', '500', '600'], variable: '--font-sans', display: 'swap' });
const mono = Fragment_Mono({ subsets: ['latin'], weight: ['400'], variable: '--font-mono', display: 'swap' });

export const metadata: Metadata = {
  metadataBase: new URL(SITE_URL),
  title: `${NAME} — AI inference, peer to peer`,
  description: `${NAME} is a peer-to-peer AI inference network on Solana. A router on your computer picks a provider for every request and pays it directly. The program takes 0%.`,
  openGraph: { title: `${NAME} — AI inference, peer to peer`, description: 'A router on your computer, providers anyone can run, payments straight to them on Solana. Zero cut in between.' },
};

export const viewport: Viewport = { themeColor: '#08080a', colorScheme: 'dark' };

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" className={`${sans.variable} ${mono.variable}`}>
      <body>
        {children}
      </body>
    </html>
  );
}
