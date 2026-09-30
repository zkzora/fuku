"use client";

import { Suspense, useState } from "react";
import { useSearchParams } from "next/navigation";
import { Empty, PageHeader } from "@/components/bits";
import { ReputationReport, type Report } from "@/components/app/reputation-report";
import { Skeleton } from "@/components/ui/skeleton";
import { useJson } from "@/lib/client";
import type { AgentView } from "@/lib/services/agents";
import { cn } from "@/lib/utils";

export default function ReputationPage() {
  return (
    <Suspense>
      <Reputation />
    </Suspense>
  );
}

function Reputation() {
  const params = useSearchParams();
  const [agentId, setAgentId] = useState<string | null>(params.get("agent"));
  const { data, loading } = useJson<{ agents: AgentView[]; report: Report | null }>(
    `/api/reputation${agentId ? `?agentId=${encodeURIComponent(agentId)}` : ""}`,
  );

  return (
    <div className="space-y-6">
      <PageHeader title="Reputation" subtitle="Trust analytics for every agent you own, with a plain-language explanation." />
      {data && data.agents.length > 0 && (
        <div className="flex flex-wrap gap-2">
          {data.agents.map((a) => {
            const active = a.id === (agentId ?? data.report?.agent.id);
            return (
              <button
                key={a.id}
                onClick={() => setAgentId(a.id)}
                className={cn(
                  "rounded-full px-4 py-2 text-[13.5px] font-medium transition",
                  active ? "bg-ink text-white" : "bg-white text-ink-2 ring-1 ring-line hover:bg-surface",
                )}
              >
                {a.name} <span className={active ? "text-white/70" : "text-ink-3"}>· {a.trustScore ?? "—"}</span>
              </button>
            );
          })}
        </div>
      )}
      {loading && !data ? (
        <Skeleton className="h-[560px] rounded-2xl" />
      ) : !data || !data.report ? (
        <Empty title="No reputation yet" body="Register an agent and run actions; the score builds from its execution history." />
      ) : (
        <div className={cn(loading && "opacity-60 transition")}>
          <ReputationReport report={data.report} />
        </div>
      )}
    </div>
  );
}
