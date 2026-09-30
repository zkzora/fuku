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

const STATUS_TEXT: Partial<Record<ActivityItem["status"], string>> = {
  AUTHORIZED: "Authorized (decision only)",
  CONFIRMED: "Executed on-chain",
  SIMULATED: "Simulated (mock chain)",
  PENDING: "Broadcast, pending",
  SUBMITTED: "Broadcast, pending",
  FAILED: "Allowed, execution failed",
};

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
                    {blocked ? "Blocked by policy · proof recorded" : `${STATUS_TEXT[it.status] ?? "Allowed"}${it.app ? ` · via ${it.app}` : ""}`}
                    {it.ruleId ? ` · rule ${it.ruleId}` : ""}
                    {it.orchestrator ? ` · declared via ${it.orchestrator === "chainlink-cre" ? "Chainlink CRE" : it.orchestrator}` : ""}
                    {it.receiptMode !== "live" ? ` · ${it.receiptMode === "mock" ? "mock receipt" : "legacy receipt"}` : ""}
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
                      <div className="text-[11px] font-semibold uppercase tracking-[0.08em] text-ink-3">Execution</div>
                      <div className="mt-1 flex flex-wrap items-center gap-1.5">
                        <Pill tone={it.status === "CONFIRMED" ? "allow" : it.status === "DENIED" || it.status === "FAILED" ? "block" : it.status === "AUTHORIZED" ? "neutral" : "warn"}>
                          {it.status}
                        </Pill>
                        <Pill tone={it.receiptMode === "live" ? "violet" : "neutral"} className="normal-case tracking-normal">
                          {it.receiptMode === "live" ? `live · chain ${it.chainId ?? "?"}` : it.receiptMode === "mock" ? "mock: no transaction" : "legacy: verify on-chain"}
                        </Pill>
                        {it.anchorStatus && it.anchorStatus !== "anchored" && it.anchorStatus !== "mock" && (
                          <Pill tone="warn" className="normal-case tracking-normal">
                            anchor {it.anchorStatus}
                          </Pill>
                        )}
                      </div>
                    </div>
                    <div>
                      <div className="text-[11px] font-semibold uppercase tracking-[0.08em] text-ink-3">Transaction proof</div>
                      <Mono className="text-ink">{it.txHash ? shortHex(it.txHash, 12, 8) : it.anchorStatus === "failed" ? "not anchored (retrying)" : "pending"}</Mono>
                      {it.transferTxHash && it.transferTxHash !== it.txHash && (
                        <div className="mt-1 text-[12px] text-ink-3">
                          transfer <Mono>{shortHex(it.transferTxHash, 10, 6)}</Mono>
                        </div>
                      )}
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
                    {it.txHash && it.receiptMode !== "mock" && <VerifyOnChain actionId={it.id} />}
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

