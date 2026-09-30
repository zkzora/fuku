"use client";

import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import {
  Activity,
  Bot,
  Code2,
  Fingerprint,
  LayoutDashboard,
  Lock,
  LogOut,
  ShieldCheck,
  Sparkles,
} from "lucide-react";
import { Logo } from "@/components/brand";
import { Avatar } from "@/components/bits";
import { fmtLongDate } from "@/lib/format";
import { api } from "@/lib/client";
import { cn } from "@/lib/utils";

export const NAV = [
  { href: "/dashboard", label: "Dashboard", icon: LayoutDashboard },
  { href: "/identity", label: "Identity", icon: Fingerprint },
  { href: "/agents", label: "Agents", icon: Bot },
  { href: "/permissions", label: "Permissions", icon: ShieldCheck },
  { href: "/reputation", label: "Reputation", icon: Sparkles },
  { href: "/activity", label: "Activity", icon: Activity },
  { href: "/memory", label: "Memory Vault", icon: Lock },
  { href: "/developers", label: "Developer Console", icon: Code2 },
];

export function Shell({
  identity,
  children,
}: {
  identity: { id: string; displayName: string; humanVerified: boolean };
  children: React.ReactNode;
}) {
  const pathname = usePathname();
  const router = useRouter();

  async function signOut() {
    await api("/api/auth/logout", { method: "POST" });
    router.push("/");
    router.refresh();
  }

  return (
    <div className="flex min-h-screen bg-[#f7f7f9]">
      <aside className="sticky top-0 hidden h-screen w-[240px] shrink-0 flex-col border-r border-line bg-white px-4 py-5 md:flex">
        <Logo href="/dashboard" className="px-2" />
        <nav className="mt-8 flex flex-1 flex-col gap-0.5">
          {NAV.map((n) => {
            const active = pathname === n.href || pathname.startsWith(n.href + "/");
            const Icon = n.icon;
            return (
              <Link
                key={n.href}
                href={n.href}
                className={cn(
                  "flex items-center gap-3 rounded-xl px-3 py-2.5 text-[14px] font-medium transition",
                  active ? "bg-violet-soft text-violet" : "text-ink-2 hover:bg-surface hover:text-ink",
                )}
              >
                <Icon className="size-[18px]" />
                {n.label}
              </Link>
            );
          })}
        </nav>
        <div className="flex items-center gap-3 rounded-xl border border-line p-3">
          <Avatar name={identity.displayName} size={34} />
          <div className="min-w-0 flex-1">
            <div className="truncate text-[13.5px] font-semibold text-ink">{identity.displayName}</div>
            <div className={cn("text-[12px]", identity.humanVerified ? "text-allow" : "text-warn")}>
              {identity.humanVerified ? "Human verified" : "Not verified"}
            </div>
          </div>
          <button onClick={signOut} title="Sign out" className="rounded-lg p-1.5 text-ink-3 hover:bg-surface hover:text-ink">
            <LogOut className="size-4" />
          </button>
        </div>
      </aside>

      <div className="flex min-w-0 flex-1 flex-col">
        <header className="fuku-glass sticky top-0 z-10 flex h-[60px] items-center justify-between border-b border-line px-5 md:px-8">
          <div className="flex items-center gap-3 md:hidden">
            <Logo href="/dashboard" wordmark={false} />
          </div>
          <MobileNav pathname={pathname} />
          <div className="ml-auto flex items-center gap-4 text-[13px] text-ink-3">
            <span className="hidden sm:inline">{fmtLongDate()}</span>
            <span className="hidden items-center gap-1.5 rounded-full bg-surface px-2.5 py-1 text-[12px] font-medium text-ink-2 sm:inline-flex">
              <span className="size-1.5 rounded-full bg-violet" /> Monad testnet
            </span>
          </div>
        </header>
        <main className="mx-auto w-full max-w-[1180px] flex-1 px-4 py-6 md:px-8 md:py-8">{children}</main>
      </div>
    </div>
  );
}

function MobileNav({ pathname }: { pathname: string }) {
  return (
    <nav className="flex gap-1 overflow-x-auto md:hidden">
      {NAV.map((n) => (
        <Link
          key={n.href}
          href={n.href}
          className={cn(
            "whitespace-nowrap rounded-full px-3 py-1.5 text-[12.5px] font-medium",
            pathname.startsWith(n.href) ? "bg-violet-soft text-violet" : "text-ink-3",
          )}
        >
          {n.label}
        </Link>
      ))}
    </nav>
  );
}
