import type { Metadata } from "next";
import { Geist, Geist_Mono, Inter } from "next/font/google";
import "./globals.css";
// The design system, verbatim from the design file. Loaded AFTER globals so
// its tokens and component rules win where the two overlap.
/*
 * workspace.css is imported by globals.css into `layer(mockup)` — see the
 * layer-order note there. Importing it here as well would reintroduce it
 * unlayered, which is the bug that note describes.
 */
import "./shell.css";

const inter = Inter({
  subsets: ["latin"],
  variable: "--font-inter",
  display: "swap",
});

/*
 * The OS typeface (30 Sep). workspace.css asked for a family literally named
 * 'Inter', which next/font never registers under that name — so every screen
 * silently rendered in the machine's system font (SF Pro on a Mac, Segoe on
 * Windows). Geist is loaded here and wired in ds.css as --sans / --mono.
 */
const geist = Geist({ subsets: ["latin"], variable: "--font-geist", display: "swap" });
const geistMono = Geist_Mono({ subsets: ["latin"], variable: "--font-geist-mono", display: "swap" });

export const metadata: Metadata = {
  title: "BrokerStaffer — Command Center",
  description: "One front door to the BrokerStaffer stack.",
  robots: { index: false, follow: false },
};

export default function RootLayout({
  children,
}: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="en" className={`${inter.variable} ${geist.variable} ${geistMono.variable}`}>
      <body>{children}</body>
    </html>
  );
}
