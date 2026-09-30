"use client";

import { motion } from "framer-motion";
import { Card, CardTitle, Delta, Pill } from "@/components/bits";
import { TrustScore } from "@/components/trust-score";
import type { ScoreBreakdownLine } from "@/lib/engine/reputation";
import type { Intelligence } from "@/lib/integrations";
import { fmtWhen } from "@/lib/format";
import { cn } from "@/lib/utils";

export interface Report {
  agent: { id: string; name: string; status: string };
  score: number;
  level: "High" | "Medium" | "Low";
  breakdown: ScoreBreakdownLine[];
  counts: { successes: number; violations: number; securityEvents: number };
  intelligence: Intelligence;
  explanation: string | null;
  explanationProvider: string | null;
  events: { id: string; kind: string; delta: number; note: string; createdAt: string }[];
}

export function ReputationReport({ report }: { report: Report }) {
  const max = 40;
  return (
    <div className="grid gap-4 lg:grid-cols-[1fr_1.3fr]">
      <div className="space-y-4">
        <Card className="flex items-center gap-6">
          <TrustScore score={report.score} size={132} stroke={10} label="Trust score" />
          <div className="space-y-2">
            <div className="text-[18px] font-semibold text-ink">{report.agent.name}</div>
            <Pill tone={report.level === "High" ? "allow" : report.level === "Medium" ? "warn" : "block"} dot>
              Security level {report.level}
            </Pill>
            <p className="text-[12.5px] text-ink-3">Portable: any application can read this score through the Fuku SDK.</p>
          </div>
        </Card>
        <div className="grid grid-cols-3 gap-3">
          <Stat label="Successful" value={report.counts.successes} tone="allow" />
          <Stat label="Failed / blocked" value={report.counts.violations} tone="block" />
          <Stat label="Security events" value={report.counts.securityEvents} tone={report.counts.securityEvents ? "block" : "neutral"} />
        </div>
        <Card>
          <CardTitle
            action={
              <Pill tone="neutral" className="normal-case tracking-normal">
                {report.intelligence.provider === "nansen" ? "Nansen" : "Fuku ledger"} · risk {report.intelligence.riskLevel}
              </Pill>
            }
          >
            Behavioural intelligence
          </CardTitle>
          {report.intelligence.note && <p className="mb-3 text-[12.5px] text-ink-3">{report.intelligence.note}</p>}
          <div className="grid grid-cols-2 gap-3">
            {report.intelligence.signals.map((s) => (
              <div key={s.label} className="rounded-xl bg-surface p-3">
                <div className="text-[11px] font-semibold uppercase tracking-[0.08em] text-ink-3">{s.label}</div>
                <div
                  className={cn(
                    "mt-1 text-[15px] font-semibold",
                    s.tone === "good" ? "text-allow" : s.tone === "bad" ? "text-block" : s.tone === "warn" ? "text-warn" : "text-ink",
                  )}
                >
                  {s.value}
                </div>
              </div>
            ))}
          </div>
        </Card>
      </div>

      <div className="space-y-4">
        <Card>
          <CardTitle
            action={
              report.explanationProvider && (
                <Pill tone="violet" className="normal-case tracking-normal">
                  Explained by {report.explanationProvider}
                </Pill>
              )
            }
          >
            Why this score exists
          </CardTitle>
          <p className="text-pretty text-[15px] leading-[1.6] text-ink">{report.explanation ?? "Explanation unavailable."}</p>
        </Card>
        <Card>
          <CardTitle>Score breakdown</CardTitle>
          <div className="space-y-3">
            {report.breakdown.map((b) => (
              <div key={b.key}>
                <div className="flex items-center justify-between text-[13.5px]">
                  <span className="font-medium text-ink">{b.label}</span>
                  <Delta value={b.points} />
                </div>
                <div className="mt-1 h-1.5 overflow-hidden rounded-full bg-surface">
                  <motion.div
                    initial={{ width: 0 }}
                    animate={{ width: `${Math.min(100, (Math.abs(b.points) / max) * 100)}%` }}
                    transition={{ duration: 0.6, ease: [0.22, 1, 0.36, 1] }}
                    className={cn("h-full rounded-full", b.points >= 0 ? "bg-violet" : "bg-block")}
                  />
                </div>
                <div className="mt-1 text-[12px] text-ink-3">{b.detail}</div>
              </div>
            ))}
          </div>
        </Card>
        <Card>
          <CardTitle>Recent reputation events</CardTitle>
          <div className="divide-y divide-line">
            {report.events.slice(0, 8).map((e) => (
              <div key={e.id} className="flex items-center justify-between gap-3 py-2 text-[13.5px] first:pt-0 last:pb-0">
                <span className="truncate text-ink-2">{e.note}</span>
                <span className="flex shrink-0 items-center gap-3">
                  <Delta value={e.delta} />
                  <span className="text-[12px] text-ink-3">{fmtWhen(e.createdAt)}</span>
                </span>
              </div>
            ))}
            {report.events.length === 0 && <p className="text-[13.5px] text-ink-3">No events yet.</p>}
          </div>
        </Card>
      </div>
    </div>
  );
}

function Stat({ label, value, tone }: { label: string; value: number; tone: "allow" | "block" | "neutral" }) {
  return (
    <div className="fuku-card p-4">
      <div className="text-[11px] font-semibold uppercase tracking-[0.08em] text-ink-3">{label}</div>
      <div className={cn("mt-1 text-[26px] font-semibold leading-none", tone === "allow" ? "text-allow" : tone === "block" ? "text-block" : "text-ink")}>
        {value}
      </div>
    </div>
  );
}
