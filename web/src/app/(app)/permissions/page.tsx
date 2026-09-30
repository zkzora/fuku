"use client";

import { Suspense, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { Empty, PageHeader, StatusPill } from "@/components/bits";
import { PolicyEditor } from "@/components/app/policy-editor";
import { RunAction } from "@/components/app/run-action";
import { Skeleton } from "@/components/ui/skeleton";
import { useJson } from "@/lib/client";
import type { AgentView } from "@/lib/services/agents";
import { cn } from "@/lib/utils";

export default function PermissionsPage() {
  return (
    <Suspense>
      <Permissions />
    </Suspense>
  );
}

function Permissions() {
  const { data, loading, refetch } = useJson<{ agents: AgentView[] }>("/api/agents");
  const params = useSearchParams();
  const router = useRouter();
  const [chosen, setSelected] = useState<string | null>(params.get("agent"));
  const selected = chosen ?? data?.agents[0]?.id ?? null;
  const agent = data?.agents.find((a) => a.id === selected) ?? null;

  return (
    <div className="space-y-6">
      <PageHeader title="Permission Manager" subtitle="What is each agent allowed to do? Allowances, limits and hard blocks, enforced before execution." />
      {loading || !data ? (
        <Skeleton className="h-[520px] rounded-2xl" />
      ) : data.agents.length === 0 ? (
        <Empty title="No agents to manage" body="Register an agent first, then attach a passport here." />
      ) : (
        <div className="grid gap-4 lg:grid-cols-[260px_1fr]">
          <div className="fuku-card self-start p-2">
            {data.agents.map((a) => (
              <button
                key={a.id}
                onClick={() => {
                  setSelected(a.id);
                  router.replace(`/permissions?agent=${encodeURIComponent(a.id)}`);
                }}
                className={cn(
                  "flex w-full items-center justify-between gap-2 rounded-xl px-3 py-2.5 text-left transition",
                  selected === a.id ? "bg-violet-soft" : "hover:bg-surface",
                )}
              >
                <div className="min-w-0">
                  <div className={cn("truncate text-[14px] font-medium", selected === a.id ? "text-violet" : "text-ink")}>{a.name}</div>
                  <div className="truncate text-[12px] text-ink-3">{a.policy ? `Passport v${a.policy.version}` : "No passport"}</div>
                </div>
                <StatusPill status={a.status} />
              </button>
            ))}
          </div>
          <div className="space-y-4">
            {agent && <PolicyEditor key={agent.id + (agent.policy?.updatedAt ?? "")} agent={agent} onSaved={() => refetch({ silent: true })} />}
            <div>
              <div className="mb-2 text-[11px] font-semibold uppercase tracking-[0.1em] text-ink-3">Test an action against the passport</div>
              <RunAction agents={data.agents} onDone={() => refetch({ silent: true })} />
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
