import type { Metadata } from "next";
import Link from "next/link";
import "./globals.css";
import { QueryProvider } from "@/components/QueryProvider";
import { Nav } from "@/components/Nav";

export const metadata: Metadata = {
  title: "FRC Dashboard",
  description: "Monitoreo FRC Comercial",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="es" className="dark">
      <body>
        <QueryProvider>
          <div className="min-h-screen flex flex-col">
            <header className="border-b border-border-subtle bg-bg-surface">
              <div className="max-w-7xl mx-auto px-4 py-3 flex items-center gap-6">
                <Link href="/dashboard" className="font-bold text-text-primary">
                  FRC · Dashboard
                </Link>
                <Nav />
                <div className="flex-1" />
                <Link
                  href="/tv"
                  className="nav-link border border-border-subtle"
                  target="_blank"
                >
                  TV ↗
                </Link>
              </div>
            </header>
            <main className="flex-1 max-w-7xl w-full mx-auto px-4 py-6">{children}</main>
            <footer className="border-t border-border-subtle text-xs text-text-muted">
              <div className="max-w-7xl mx-auto px-4 py-3">
                FRC Sistemas Informáticos · v0.1
              </div>
            </footer>
          </div>
        </QueryProvider>
      </body>
    </html>
  );
}
