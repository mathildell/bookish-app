import type { Metadata } from "next";
import { Inter } from "next/font/google";
import Link from "next/link";
import "./globals.css";
import { NAV_SEARCH_SLOT_ID } from "@/lib/navSearchSlot";
import { BookmarkIcon, ChevronIcon, GearIcon } from "@/components/icons";
import Providers from "./providers";

const inter = Inter({ subsets: ["latin"] });

export const metadata: Metadata = {
  title: "BookishApp",
  description: "Your personal reading assistant",
};

type NavLinkItem = { label: string; href: string };

const READ_LINKS: NavLinkItem[] = [
  { label: "Library", href: "/" },
  { label: "Chat", href: "/chat" },
  { label: "ARC Tracker", href: "/arcs" },
];

const WRITE_LINKS: NavLinkItem[] = [
  { label: "Characters", href: "/characters" },
  { label: "Sandbox", href: "/write" },
];

const navLinkClass =
  "block rounded px-2 py-1.5 text-sm text-muted transition-colors hover:bg-card hover:text-foreground";

function NavDropdown({ label, items }: { label: string; items: NavLinkItem[] }) {
  return (
    <div className="group relative">
      <button
        type="button"
        aria-haspopup="true"
        className="flex items-center gap-1 rounded px-2 py-1.5 text-sm text-foreground/80 transition-colors hover:text-foreground group-hover:text-foreground group-focus-within:text-foreground"
      >
        {label}
        <ChevronIcon className="h-3.5 w-3.5 transition-transform duration-150 group-hover:rotate-180 group-focus-within:rotate-180" />
      </button>
      {/* pt-1 keeps the menu reachable while the pointer travels down from the label */}
      <div className="invisible absolute left-0 top-full z-10 pt-1 opacity-0 transition-opacity duration-150 group-hover:visible group-hover:opacity-100 group-focus-within:visible group-focus-within:opacity-100">
        <div className="min-w-44 rounded-lg shadow-sm shadow-border bg-background/95 p-1 shadow-lg backdrop-blur-md">
          {items.map((it) => (
            <Link key={it.href} href={it.href} className={navLinkClass}>
              {it.label}
            </Link>
          ))}
        </div>
      </div>
    </div>
  );
}

function Nav() {
  return (
    <nav className="sticky top-0 z-[60] pt-2 bg-background/90 backdrop-blur-md">
      <div className="max-w-7xl mx-auto grid h-14 grid-cols-[1fr_auto_1fr] items-center gap-4">
        <div className="flex min-w-0 items-center">
          <Link href="/" className="text-accent font-bold tracking-tight select-none text-shadow-sm text-shadow-highlight">
            BookishApp
          </Link>
          <div className="ml-5 flex items-center gap-1 border-l border-border pl-5">
            <NavDropdown label="Read" items={READ_LINKS} />
            <NavDropdown label="Write" items={WRITE_LINKS} />
          </div>
        </div>
        {/* Pages portal their search bar here; empty on pages without one. */}
        <div id={NAV_SEARCH_SLOT_ID} className="flex w-[18rem] max-w-[28vw] min-w-0 justify-center" />
        <div className="flex justify-end gap-2">
          <Link
            href="/bookmarks"
            aria-label="Bookmarks"
            title="Bookmarks"
            className="flex h-9 w-9 items-center justify-center bg-card rounded-full text-foreground/80 transition-colors hover:bg-highlight hover:text-accent"
          >
            <BookmarkIcon />
          </Link>
          <Link
            href="/settings"
            aria-label="Settings"
            title="Settings"
            className="flex h-9 w-9 items-center justify-center bg-card rounded-full text-foreground/80 transition-colors hover:bg-highlight hover:text-accent"
          >
            <GearIcon />
          </Link>
        </div>
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
          <div className="bg-background" style={{ height: "calc(100vh_-_3.5rem)" }}>
            <main className="max-w-7xl mx-auto h-full px-0 pb-6">{children}</main>
          </div>
        </Providers>
      </body>
    </html>
  );
}
