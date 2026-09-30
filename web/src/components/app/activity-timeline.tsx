"use client";

import { useState } from "react";
import { ChevronDown } from "lucide-react";
import { Delta, Empty, Mono, Pill } from "@/components/bits";
import { labelFor, pastTense } from "@/lib/engine/policy";
import type { ActivityItem } from "@/lib/services/activity";
import { fmtWhen } from "@/lib/format";
import { shortHex } from "@/lib/ids";
import { cn } from "@/lib/utils";
import { VerifyOnChain } from "./verify-onchain";

export function ActivityTimeline({ items, compact, emptyBody }: { items: ActivityItem[]; compact?: boolean; emptyBody?: string }) {
  const [open, setOpen] = useState<string | null>(null);
  if (items.length === 0) {
    return <Empty title="No activity yet" body={emptyBody ?? "Run an agent action and every decision will show up here with its proof."} />;
  }
  return (
    <ol className="relative">
      {items.map((it, i) => {
        const blocked = it.decision === "BLOCKED";
        const expanded = open === it.id;
        return (
          <li key={it.id} className={cn("relative flex gap-4", i !== items.length - 1 && "pb-1")}>
            <div className="flex flex-col items-center">
              <span className={cn("mt-1.5 size-2.5 shrink-0 rounded-full ring-4 ring-white", blocked ? "bg-block" : "bg-allow")} />
              {i !== items.length - 1 && <span className="w-px flex-1 bg-line" />}
            </div>
            <div className="min-w-0 flex-1 pb-4">
              <button onClick={() => !compact && setOpen(expanded ? null : it.id)} className="flex w-full items-start justify-between gap-3 text-left">
                <div className="min-w-0">
                  <div className="text-[14px] text-ink">
                    <span className="font-semibold">{it.agentName}</span>{" "}
                    <span className="text-ink-2">
                      {blocked ? `tried to ${labelFor(it.action).toLowerCase()}` : pastTense(it.action)}
                      {it.amountUsdc ? ` · ${it.amountUsdc.toLocaleString("en-US")} USDC` : ""}
                    </span>
                  </div>
                  <div className={cn("mt-0.5 text-[12.5px]", blocked ? "text-block" : "text-ink-3")}>
                    {blocked ? "Blocked by policy · proof recorded" : `Allowed${it.app ? ` · via ${it.app}` : ""}`}
                    {it.ruleId ? ` · rule ${it.ruleId}` : ""}
                    {it.orchestrator === "chainlink-cre" ? " · via Chainlink CRE" : ""}
                  </div>
                </div>
                <div className="flex shrink-0 items-center gap-3">
                  {!compact && (
                    <span className="hidden text-[12.5px] sm:inline">
                      <Delta value={it.trustDelta} />
                    </span>
                  )}
                  <span className="text-[12px] text-ink-3">{fmtWhen(it.createdAt)}</span>
                  {!compact && <ChevronDown className={cn("size-4 text-ink-3 transition", expanded && "rotate-180")} />}
                </div>
              </button>
              {expanded && (
                <div className="mt-3 grid gap-3 rounded-xl bg-surface p-4 text-[13px] md:grid-cols-2">
                  <div className="space-y-2">
                    <div>
                      <div className="text-[11px] font-semibold uppercase tracking-[0.08em] text-ink-3">Permission result</div>
                      <div className="mt-1 flex items-center gap-2">
                        <Pill tone={blocked ? "block" : "allow"}>{it.decision}</Pill>
                        <span className="text-ink-2">{it.reason}</span>
                      </div>
                    </div>
                    {it.explanation && (
                      <div>
                        <div className="text-[11px] font-semibold uppercase tracking-[0.08em] text-ink-3">Explanation</div>
                        <p className="mt-1 text-pretty text-ink-2">{it.explanation}</p>
                      </div>
                    )}
                  </div>
                  <div className="space-y-2">
                    <div>
                      <div className="text-[11px] font-semibold uppercase tracking-[0.08em] text-ink-3">Transaction proof</div>
                      <Mono className="text-ink">{it.txHash ? shortHex(it.txHash, 12, 8) : "pending"}</Mono>
                    </div>
                    <div>
                      <div className="text-[11px] font-semibold uppercase tracking-[0.08em] text-ink-3">Decision hash</div>
                      <Mono className="break-all text-ink">{it.proofHash}</Mono>
                    </div>
                    <div>
                      <div className="text-[11px] font-semibold uppercase tracking-[0.08em] text-ink-3">Trust impact</div>
                      <div className="mt-0.5">
                        <Delta value={it.trustDelta} />
                      </div>
                    </div>
                    {it.txHash && <VerifyOnChain actionId={it.id} />}
                  </div>
                </div>
              )}
            </div>
          </li>
        );
      })}
    </ol>
  );
}

