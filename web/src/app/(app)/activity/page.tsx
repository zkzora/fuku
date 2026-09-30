"use client";

import { Suspense, useState } from "react";
import { useSearchParams } from "next/navigation";
import { Card, PageHeader } from "@/components/bits";
import { ActivityTimeline } from "@/components/app/activity-timeline";
import { OnChainFeed } from "@/components/app/onchain-feed";
import { Skeleton } from "@/components/ui/skeleton";
import { useJson } from "@/lib/client";
import type { AgentView } from "@/lib/services/agents";
import type { ActivityItem } from "@/lib/services/activity";
import { cn } from "@/lib/utils";

type Tab = "ledger" | "onchain";

export default function ActivityPage() {
  return (
    <Suspense>
      <Activity />
    </Suspense>
  );
}

function Activity() {
  const params = useSearchParams();
  const [tab, setTab] = useState<Tab>(params.get("tab") === "onchain" ? "onchain" : "ledger");
  const [agentId, setAgentId] = useState<string>("");
  const [decision, setDecision] = useState<"" | "ALLOWED" | "BLOCKED">("");
  const agents = useJson<{ agents: AgentView[] }>("/api/agents");
  const chain = useJson<{ chain: { mode: string; explorer: string } }>("/api/integrations");
  const qs = new URLSearchParams({ limit: "100" });
  if (agentId) qs.set("agentId", agentId);
  if (decision) qs.set("decision", decision);
  const { data, loading } = useJson<{ activity: ActivityItem[] }>(`/api/activity?${qs.toString()}`);

  return (
    <div className="space-y-6">
      <PageHeader
        title="Activity"
        subtitle="Every agent action, its permission result, the transaction proof and the trust impact."
        actions={
          <div className="flex flex-wrap items-center gap-2">
            <select value={agentId} onChange={(e) => setAgentId(e.target.value)} className={selectCls}>
              <option value="">All agents</option>
              {agents.data?.agents.map((a) => (
                <option key={a.id} value={a.id}>
                  {a.name}
                </option>
              ))}
            </select>
            {tab === "ledger" && (
              <div className="flex rounded-xl bg-white p-1 ring-1 ring-line">
                {(["", "ALLOWED", "BLOCKED"] as const).map((d) => (
                  <button
                    key={d}
                    onClick={() => setDecision(d)}
                    className={cn(
                      "rounded-lg px-3 py-1.5 text-[13px] font-medium transition",
                      decision === d ? (d === "BLOCKED" ? "bg-block-soft text-block" : d === "ALLOWED" ? "bg-allow-soft text-allow" : "bg-surface text-ink") : "text-ink-3",
                    )}
                  >
                    {d === "" ? "All" : d === "ALLOWED" ? "Allowed" : "Blocked"}
                  </button>
                ))}
              </div>
            )}
          </div>
        }
      />

      <div className="flex gap-1 border-b border-line">
        {(
          [
            ["ledger", "Fuku ledger"],
            ["onchain", "On-chain · Envio"],
          ] as const
        ).map(([key, label]) => (
          <button
            key={key}
            onClick={() => setTab(key)}
            className={cn(
              "-mb-px border-b-2 px-3 pb-2.5 text-[14px] font-medium transition",
              tab === key ? "border-violet text-violet" : "border-transparent text-ink-3 hover:text-ink",
            )}
          >
            {label}
          </button>
        ))}
      </div>

      <Card>
        {tab === "ledger" ? (
          loading && !data ? (
            <Skeleton className="h-[400px]" />
          ) : (
            <ActivityTimeline items={data?.activity ?? []} />
          )
        ) : (
          <OnChainFeed agentId={agentId || undefined} explorer={chain.data?.chain.explorer ?? "https://testnet.monadexplorer.com"} />
        )}
      </Card>
    </div>
  );
}

const selectCls = "h-9 rounded-xl border border-line bg-white px-3 text-[13px] text-ink outline-none focus:border-violet";
