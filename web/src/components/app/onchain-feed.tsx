"use client";

import { ExternalLink } from "lucide-react";
import { Empty, Mono } from "@/components/bits";
import { Skeleton } from "@/components/ui/skeleton";
import { useJson } from "@/lib/client";
import type { OnChainFeed as Feed } from "@/lib/integrations/envio";
import { fmtWhen } from "@/lib/format";
import { shortHex } from "@/lib/ids";
import { cn } from "@/lib/utils";

const toneDot = { allow: "bg-allow", block: "bg-block", violet: "bg-violet", neutral: "bg-ink-3" } as const;

/** Registry events on Monad for this identity and its agents, indexed by Envio HyperSync. */
export function OnChainFeed({ agentId, explorer }: { agentId?: string; explorer: string }) {
  const qs = new URLSearchParams({ limit: "100" });
  if (agentId) qs.set("agentId", agentId);
  const { data, loading, error } = useJson<Feed>(`/api/onchain?${qs.toString()}`);

  if (loading && !data) return <Skeleton className="h-[360px]" />;
  if (error) return <Empty title="On-chain index unavailable" body={error} />;
  if (!data || data.events.length === 0) {
    return <Empty title="No on-chain events yet" body="Run an agent action in live mode; its decision and score change are indexed here within seconds." />;
  }

  return (
    <div>
      <div className="mb-4 flex flex-wrap items-center justify-between gap-2 rounded-xl bg-surface px-4 py-2.5 text-[12.5px] text-ink-3">
        <span>
          Indexed by <strong className="text-ink">Envio HyperSync</strong> from the Fuku registries on Monad testnet ·{" "}
          {data.events.length} events
        </span>
        <span>
          blocks {data.fromBlock.toLocaleString("en-US")} → {data.height.toLocaleString("en-US")}
        </span>
      </div>
      <ol>
        {data.events.map((e, i) => (
          <li key={e.id} className="relative flex gap-4">
            <div className="flex flex-col items-center">
              <span className={cn("mt-1.5 size-2.5 shrink-0 rounded-full ring-4 ring-white", toneDot[e.tone])} />
              {i !== data.events.length - 1 && <span className="w-px flex-1 bg-line" />}
            </div>
            <div className="flex min-w-0 flex-1 items-start justify-between gap-3 pb-4">
              <div className="min-w-0">
                <div className="text-[14px] font-medium text-ink">{e.title}</div>
                <div className="mt-0.5 truncate text-[12.5px] text-ink-3">
                  <Mono className="text-[11.5px]">{e.kind}</Mono>
                  {e.detail ? ` · ${e.detail}` : ""}
                </div>
              </div>
              <div className="flex shrink-0 flex-col items-end gap-0.5 text-right">
                <a
                  href={`${explorer}/tx/${e.txHash}`}
                  target="_blank"
                  rel="noreferrer"
                  className="inline-flex items-center gap-1 text-[12px] text-violet hover:underline"
                >
                  <Mono className="text-[11.5px] text-violet">{shortHex(e.txHash, 8, 4)}</Mono>
                  <ExternalLink className="size-3" />
                </a>
                <span className="text-[11.5px] text-ink-3">
                  block {e.blockNumber.toLocaleString("en-US")}
                  {e.timestamp ? ` · ${fmtWhen(e.timestamp)}` : ""}
                </span>
              </div>
            </div>
          </li>
        ))}
      </ol>
    </div>
  );
}
