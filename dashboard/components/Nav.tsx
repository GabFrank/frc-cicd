"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { cn } from "@/lib/utils";

const LINKS = [
  { href: "/dashboard", label: "Overview" },
  { href: "/dashboard/cicd", label: "CI/CD" },
  { href: "/dashboard/filiales", label: "Filiales" },
  { href: "/dashboard/central", label: "Central" },
  { href: "/dashboard/replicacion", label: "Replicación" },
  { href: "/dashboard/alertas", label: "Alertas" },
];

export function Nav() {
  const pathname = usePathname();
  return (
    <nav className="flex items-center gap-1 flex-wrap">
      {LINKS.map((l) => {
        const active = pathname === l.href || (l.href !== "/dashboard" && pathname?.startsWith(l.href));
        return (
          <Link key={l.href} href={l.href} className={cn("nav-link", active && "nav-link-active")}>
            {l.label}
          </Link>
        );
      })}
    </nav>
  );
}
