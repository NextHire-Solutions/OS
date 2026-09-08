import type { Metadata } from "next";
import { Inter } from "next/font/google";
import "./globals.css";
// The design system, verbatim from the design file. Loaded AFTER globals so
// its tokens and component rules win where the two overlap.
import "./workspace.css";
import "./shell.css";

const inter = Inter({
  subsets: ["latin"],
  variable: "--font-inter",
  display: "swap",
});

export const metadata: Metadata = {
  title: "BrokerStaffer — Command Center",
  description: "One front door to the BrokerStaffer stack.",
  robots: { index: false, follow: false },
};

export default function RootLayout({
  children,
}: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="en" className={inter.variable}>
      <body>{children}</body>
    </html>
  );
}
