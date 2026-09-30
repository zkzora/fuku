"use client";

import { Landmark } from "lucide-react";
import { Card, CardTitle, Mono, Pill } from "@/components/bits";
import { Skeleton } from "@/components/ui/skeleton";
import { useJson } from "@/lib/client";
import type { MandateView } from "@/lib/chain";

interface MandateResponse {
  mandate: MandateView | null;
  wallet: string | null;
  reason: "mock-chain" | "guard-not-configured" | "no-wallet" | "read-failed" | null;
  error?: string;
}

const REASON_TEXT: Record<NonNullable<MandateResponse["reason"]>, string> = {
  "mock-chain": "The chain is mocked, so there is no on-chain mandate. Transfers return mock receipts.",
  "guard-not-configured": "FUKU_SPEND_GUARD is not set, so A-Token transfers are blocked (R10 GUARD_NOT_CONFIGURED).",
  "no-wallet": "Link the owner's wallet: the mandate is opened from it.",
  "read-failed": "Could not read the mandate from the chain.",
};

/**
 * The owner's FukuSpendGuard mandate for an agent: which token it may move from the owner's wallet,
 * the daily cap and what it spent this UTC day, read straight from the contract.
 */
export function MandatePanel({ agentId }: { agentId: string }) {
  const { data, loading } = useJson<MandateResponse>(`/api/agents/${encodeURIComponent(agentId)}/mandate`);
  const m = data?.mandate;
  const pct = m && m.dailyCapUsdc > 0 ? Math.min(100, (m.spentTodayUsdc / m.dailyCapUsdc) * 100) : 0;

  return (
    <Card>
      <CardTitle action={m ? <Pill tone={m.active ? "allow" : "block"} dot>{m.active ? "Mandate open" : "No mandate"}</Pill> : null}>
        On-chain mandate
      </CardTitle>
      {loading || !data ? (
        <Skeleton className="h-20" />
      ) : !m ? (
        <p className="text-[13.5px] text-ink-3">{data.reason ? REASON_TEXT[data.reason] : "No mandate."}{data.error ? ` (${data.error})` : ""}</p>
      ) : (
        <div className="flex items-start gap-3">
          <span className="grid size-9 shrink-0 place-items-center rounded-xl bg-violet-soft">
            <Landmark className="size-4 text-violet" />
          </span>
          <div className="min-w-0 flex-1 space-y-1.5 text-[13px]">
            {m.active ? (
              <>
                <div className="text-[14px] font-medium text-ink">
                  {m.spentTodayUsdc.toLocaleString("en-US")} / {m.dailyCapUsdc.toLocaleString("en-US")} aUSDC today (UTC)
                </div>
                <div className="h-1.5 overflow-hidden rounded-full bg-surface">
                  <div className="h-full rounded-full bg-violet" style={{ width: `${pct}%` }} />
                </div>
              </>
            ) : (
              <div className="text-[14px] font-medium text-ink">The owner has not opened a mandate for this agent, so the guard rejects every transfer (NoMandate).</div>
            )}
            {m.active && (
              <div className="flex flex-wrap gap-1.5">
                <Pill tone="neutral" className="normal-case tracking-normal">
                  {m.maxPerTxUsdc ? `max ${m.maxPerTxUsdc.toLocaleString("en-US")} per transfer` : "no per-transfer limit"}
                </Pill>
                <Pill tone={m.restrictPayees ? "allow" : "warn"} className="normal-case tracking-normal">
                  {m.restrictPayees ? "approved payees only" : "any eligible payee"}
                </Pill>
                <Pill tone="neutral" className="normal-case tracking-normal">
                  {m.validUntil ? `valid to ${new Date(m.validUntil * 1000).toISOString().slice(0, 10)}` : "no expiry"}
                </Pill>
                <Pill tone="violet" className="normal-case tracking-normal">
                  version {m.version}
                </Pill>
              </div>
            )}
            <div className="text-ink-3">
              From <Mono className="break-all">{m.wallet}</Mono> · set by the owner&apos;s own wallet, enforced by the guard
            </div>
            <div className="text-ink-3">
              Token <Mono className="break-all">{m.token}</Mono> · guard <Mono>{m.guard}</Mono>
            </div>
          </div>
        </div>
      )}
    </Card>
  );
}
