"use client";

import { useState } from "react";
import { Plus } from "lucide-react";
import { useRouter } from "next/navigation";
import { Empty, PageHeader } from "@/components/bits";
import { AgentCard } from "@/components/app/agent-card";
import { RegisterAgentDialog } from "@/components/app/register-agent-dialog";
import { Skeleton } from "@/components/ui/skeleton";
import { useJson } from "@/lib/client";
import type { AgentView } from "@/lib/services/agents";

export default function AgentsPage() {
  const { data, loading, refetch } = useJson<{ agents: AgentView[] }>("/api/agents");
  const [open, setOpen] = useState(false);
  const router = useRouter();

  return (
    <div className="space-y-6">
      <PageHeader
        title="Agents"
        subtitle={data ? `${data.agents.length} registered · ERC-8004 compatible identities` : "Loading…"}
        actions={
          <button onClick={() => setOpen(true)} className="inline-flex h-10 items-center gap-2 rounded-xl bg-ink px-4 text-[14px] font-medium text-white hover:bg-ink-2">
            <Plus className="size-4" /> Register agent
          </button>
        }
      />
      {loading || !data ? (
        <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
          {[0, 1, 2].map((i) => (
            <Skeleton key={i} className="h-[240px] rounded-2xl" />
          ))}
        </div>
      ) : data.agents.length === 0 ? (
        <Empty
          title="No agents yet"
          body="Register your first AI agent. It gets a portable identity owned by you and stays inactive until you attach a permission passport."
          action={
            <button onClick={() => setOpen(true)} className="rounded-xl bg-ink px-4 py-2.5 text-[14px] font-medium text-white hover:bg-ink-2">
              Register agent
            </button>
          }
        />
      ) : (
        <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
          {data.agents.map((a) => (
            <AgentCard key={a.id} agent={a} />
          ))}
        </div>
      )}
      <RegisterAgentDialog
        open={open}
        onOpenChange={setOpen}
        onRegistered={(agent) => {
          refetch({ silent: true });
          router.push(`/permissions?agent=${encodeURIComponent(agent.id)}`);
        }}
      />
    </div>
  );
}
