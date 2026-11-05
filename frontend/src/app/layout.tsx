import type { Metadata } from "next";
import { Inter } from "next/font/google";
import Link from "next/link";
import "./globals.css";
import Providers from "./providers";

const inter = Inter({ subsets: ["latin"] });

export const metadata: Metadata = {
  title: "BookishApp",
  description: "Your personal reading assistant",
};

function Nav() {
  const items = [
    { label: "Library", href: "/" },
    { label: "Chat", href: "/chat" },
    { label: "ARC Tracker", href: "/arcs" },
    { label: "Settings", href: "/settings" },
  ];

  return (
    <nav className="border-b border-zinc-800 bg-zinc-950/80 backdrop-blur supports-[backdrop-filter]:bg-zinc-950/60">
      <div className="max-w-7xl mx-auto px-4 flex h-14 items-center gap-6">
        <Link href="/" className="text-xl font-bold tracking-tight text-yellow-400 mr-4 select-none">
          BookishApp
        </Link>
        {items.map((it) => (
          <Link
            key={it.href}
            href={it.href}
            className="text-sm text-zinc-300 hover:text-white transition-colors"
          >
            {it.label}
          </Link>
        ))}
      </div>
    </nav>
  );
}

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body className={inter.className}>
        <Providers>
          <Nav />
          <main className="max-w-7xl mx-auto px-4 py-6">{children}</main>
        </Providers>
      </body>
    </html>
  );
}
