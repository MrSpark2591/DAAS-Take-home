import type { Metadata } from 'next';
import { Geist, Geist_Mono } from 'next/font/google';
import type { ReactNode } from 'react';
import { Providers } from './providers';

const geistSans = Geist({ variable: '--font-geist-sans', subsets: ['latin'] });
const geistMono = Geist_Mono({ variable: '--font-geist-mono', subsets: ['latin'] });

export const metadata: Metadata = {
  title: 'DaaS — Purchasing',
  description: 'Purchase order receiving and stock on hand',
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en" className={`${geistSans.variable} ${geistMono.variable}`}>
      {/*
        Browser extensions (ColorZilla, Grammarly and friends) inject attributes
        onto <body> before React hydrates, which React reports as a mismatch.
        This suppresses the diff for this element's own attributes only --
        mismatches inside the app still surface normally.
      */}
      <body suppressHydrationWarning>
        {/*
          Only the store and theme live here. The app chrome and the session
          guard belong to the (app) route group, so /login can render without
          either of them.
        */}
        <Providers>{children}</Providers>
      </body>
    </html>
  );
}
