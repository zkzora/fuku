import type { ReactNode } from "react";
import { cn } from "@/lib/utils";

type Tone = "allow" | "block" | "violet" | "neutral" | "warn";

const toneClass: Record<Tone, string> = {
  allow: "bg-allow-soft text-allow",
  block: "bg-block-soft text-block",
  violet: "bg-violet-soft text-violet",
  warn: "bg-warn-soft text-warn",
  neutral: "bg-surface text-ink-3",
};

export function Pill({ tone = "neutral", children, className, dot }: { tone?: Tone; children: ReactNode; className?: string; dot?: boolean }) {
  return (
    <span
      className={cn(
        "inline-flex shrink-0 items-center gap-1.5 whitespace-nowrap rounded-full px-2.5 py-1 text-[11px] font-semibold uppercase tracking-[0.06em]",
        toneClass[tone],
        className,
      )}
    >
      {dot && <span className="size-1.5 rounded-full bg-current" />}
      {children}
    </span>
  );
}

export function statusTone(status: string): Tone {
  switch (status) {
    case "active":
    case "ALLOWED":
    case "valid":
    case "approved":
      return "allow";
    case "BLOCKED":
    case "revoked":
    case "denied":
      return "block";
    case "pending":
    case "paused":
      return "warn";
    case "registered":
      return "violet";
    default:
      return "neutral";
  }
}

export function StatusPill({ status, className }: { status: string; className?: string }) {
  const label = status === "registered" ? "Just registered" : status.toLowerCase();
  return (
    <Pill tone={statusTone(status)} className={className} dot>
      {label}
    </Pill>
  );
}

export function Mono({ children, className }: { children: ReactNode; className?: string }) {
  return <span className={cn("mono text-[12.5px] text-ink-3", className)}>{children}</span>;
}

export function PageHeader({ title, subtitle, actions }: { title: string; subtitle?: ReactNode; actions?: ReactNode }) {
  return (
    <div className="flex flex-wrap items-end justify-between gap-4">
      <div className="space-y-1">
        <h1 className="text-[28px] font-semibold leading-tight text-ink">{title}</h1>
        {subtitle && <p className="text-[14.5px] text-ink-3">{subtitle}</p>}
      </div>
      {actions && <div className="flex items-center gap-2">{actions}</div>}
    </div>
  );
}

export function Card({ children, className, ...rest }: { children: ReactNode; className?: string } & React.HTMLAttributes<HTMLDivElement>) {
  return (
    <div className={cn("fuku-card p-5", className)} {...rest}>
      {children}
    </div>
  );
}

export function CardTitle({ children, action, className }: { children: ReactNode; action?: ReactNode; className?: string }) {
  return (
    <div className={cn("mb-4 flex items-center justify-between gap-3", className)}>
      <h2 className="text-[15px] font-semibold text-ink">{children}</h2>
      {action}
    </div>
  );
}

export function Row({ label, value, mono }: { label: string; value: ReactNode; mono?: boolean }) {
  return (
    <div className="flex items-center justify-between gap-4 border-b border-line py-2.5 text-[13.5px] last:border-b-0">
      <span className="text-ink-3">{label}</span>
      <span className={cn("min-w-0 text-right font-medium text-ink", mono && "mono break-all text-[12px] font-normal")}>{value}</span>
    </div>
  );
}

export function Empty({ title, body, action }: { title: string; body?: string; action?: ReactNode }) {
  return (
    <div className="flex flex-col items-center justify-center gap-2 rounded-2xl border border-dashed border-line px-6 py-12 text-center">
      <p className="text-[15px] font-medium text-ink">{title}</p>
      {body && <p className="max-w-sm text-[13.5px] text-ink-3">{body}</p>}
      {action && <div className="mt-2">{action}</div>}
    </div>
  );
}

export function Avatar({ name, size = 36, className }: { name: string; size?: number; className?: string }) {
  const letter = name.trim()[0]?.toUpperCase() ?? "?";
  return (
    <span
      className={cn("inline-grid shrink-0 place-items-center rounded-xl bg-violet-soft font-semibold text-violet", className)}
      style={{ width: size, height: size, fontSize: size * 0.42 }}
    >
      {letter}
    </span>
  );
}

export function Delta({ value }: { value: number }) {
  if (value === 0) return <span className="text-ink-3">±0</span>;
  return (
    <span className={cn("font-medium", value > 0 ? "text-allow" : "text-block")}>
      {value > 0 ? "+" : ""}
      {value}
    </span>
  );
}
