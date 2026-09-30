"use client";

import Link from "next/link";
import { useParams } from "next/navigation";
import { Pause, Play } from "lucide-react";
import { toast } from "sonner";
import { Card, CardTitle, Mono, PageHeader, StatusPill } from "@/components/bits";
import { ActivityTimeline } from "@/components/app/activity-timeline";
import { Erc8004Card } from "@/components/app/erc8004-card";
import { ScoreVerifyCard } from "@/components/app/score-verify-card";
import { PolicySummary } from "@/components/app/policy-editor";
import { ReputationReport, type Report } from "@/components/app/reputation-report";
import { Skeleton } from "@/components/ui/skeleton";
import { api, useJson } from "@/lib/client";
import type { AgentView } from "@/lib/services/agents";
import type { ActivityItem } from "@/lib/services/activity";
import { shortId } from "@/lib/ids";

type Detail = Report & { agent: AgentView; activity: ActivityItem[] };

export default function AgentDetailPage() {
  const { id } = useParams<{ id: string }>();
  const { data, loading, refetch } = useJson<Detail>(`/api/agents/${encodeURIComponent(id)}`);
  if (loading || !data) return <Skeleton className="h-[520px] rounded-2xl" />;
  const a = data.agent;

  async function setStatus(status: "active" | "paused") {
    try {
      await api(`/api/agents/${encodeURIComponent(id)}`, { method: "PATCH", json: { status } });
      toast.success(status === "active" ? "Agent activated." : "Agent paused.");
      refetch({ silent: true });
    } catch (err) {
      toast.error((err as Error).message);
    }
  }

  return (
    <div className="space-y-6">
      <PageHeader
        title={a.name}
        subtitle={
          <span className="flex flex-wrap items-center gap-2">
            <Mono>{shortId(a.id)} · v{a.version}</Mono>
            <StatusPill status={a.status} />
          </span>
        }
        actions={
          <>
            {a.status === "active" ? (
              <button onClick={() => setStatus("paused")} className="inline-flex h-10 items-center gap-2 rounded-xl bg-surface px-4 text-[14px] font-medium text-ink hover:bg-line">
                <Pause className="size-4" /> Pause
              </button>
            ) : (
              <button onClick={() => setStatus("active")} className="inline-flex h-10 items-center gap-2 rounded-xl bg-surface px-4 text-[14px] font-medium text-ink hover:bg-line">
                <Play className="size-4" /> Activate
              </button>
            )}
            <Link href={`/permissions?agent=${encodeURIComponent(a.id)}`} className="inline-flex h-10 items-center rounded-xl bg-ink px-4 text-[14px] font-medium text-white hover:bg-ink-2">
              Manage permissions
            </Link>
          </>
        }
      />
      <Card>
        <CardTitle>Permission passport</CardTitle>
        <PolicySummary policy={a.policy} />
        {a.description && <p className="mt-3 text-[13.5px] text-ink-3">{a.description}</p>}
      </Card>
      <ReputationReport report={data} />
      <ScoreVerifyCard agentId={a.id} />
      <Erc8004Card agentId={a.id} />
      <Card>
        <CardTitle>Execution history</CardTitle>
        <ActivityTimeline items={data.activity} />
      </Card>
    </div>
  );
}
