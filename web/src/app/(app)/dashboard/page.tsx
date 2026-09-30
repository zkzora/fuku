"use client";

import Link from "next/link";
import { useState } from "react";
import { Plus } from "lucide-react";
import { useRouter } from "next/navigation";
import { Card, CardTitle, Mono, StatusPill } from "@/components/bits";
import { IdentityCard } from "@/components/app/identity-card";
import { TrustScore } from "@/components/trust-score";
import { ActivityTimeline } from "@/components/app/activity-timeline";
import { RunAction } from "@/components/app/run-action";
import { DEMO_RECIPIENTS } from "@/lib/cleanverse/demo";
import { RegisterAgentDialog } from "@/components/app/register-agent-dialog";
import { Skeleton } from "@/components/ui/skeleton";
import { useJson } from "@/lib/client";
import { greeting } from "@/lib/format";
import { labelFor } from "@/lib/engine/policy";
import type { AgentView } from "@/lib/services/agents";
import type { ActivityItem } from "@/lib/services/activity";

interface Overview {
  identity: { id: string; displayName: string; humanVerified: boolean; authMethod: string };
  passkeys: { label: string; deviceType: string }[];
  agents: AgentView[];
  activity: ActivityItem[];
  pendingRequests: number;
  trust: { overall: number | null; level: string | null; primaryAgentId: string | null; primaryScore: number | null };
}

export default function DashboardPage() {
  const { data, loading, refetch } = useJson<Overview>("/api/overview");
  const [registerOpen, setRegisterOpen] = useState(false);
  const router = useRouter();

  if (loading || !data) return <DashboardSkeleton />;

  const active = data.agents.filter((a) => a.status === "active").length;
  const paused = data.agents.filter((a) => a.status !== "active").length;
  const firstName = data.identity.displayName.split(" ")[0];
  const primary = data.agents.find((a) => a.id === data.trust.primaryAgentId);

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <h1 className="text-[28px] font-semibold leading-tight text-ink">
            {greeting()}, {firstName}
          </h1>
          <p className="mt-1 text-[14.5px] text-ink-3">Here is what your agents are allowed to do, and what they did.</p>
        </div>
        <button
          onClick={() => setRegisterOpen(true)}
          className="inline-flex h-10 items-center gap-2 rounded-xl bg-ink px-4 text-[14px] font-medium text-white hover:bg-ink-2"
        >
          <Plus className="size-4" /> Register agent
        </button>
      </div>

      <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-4">
        <IdentityCard identity={data.identity} passkeyLabel={data.passkeys[0]?.label} compact />

        <Link href="/reputation" className="fuku-card flex items-center gap-4 p-5 transition hover:ring-violet/40">
          <TrustScore score={data.trust.primaryScore} size={84} stroke={7} />
          <div>
            <div className="text-[11px] font-semibold uppercase tracking-[0.1em] text-ink-3">Trust score</div>
            <div className="mt-1 text-[15px] font-semibold text-ink">
              {primary ? primary.name : "No scored agent"}
            </div>
            <div className="text-[12.5px] text-ink-3">
              Security level {data.trust.level ?? "—"} · tap for explanation
            </div>
          </div>
        </Link>

        <Link href="/agents" className="fuku-card p-5 transition hover:ring-violet/40">
          <div className="text-[11px] font-semibold uppercase tracking-[0.1em] text-ink-3">Agents</div>
          <div className="mt-2 text-[34px] font-semibold leading-none text-ink">{data.agents.length}</div>
          <div className="mt-2 text-[12.5px] text-ink-3">
            {active} active · {paused} paused or pending
          </div>
        </Link>

        <Link href="/memory" className="fuku-card p-5 transition hover:ring-violet/40">
          <div className="text-[11px] font-semibold uppercase tracking-[0.1em] text-ink-3">Memory vault</div>
          <div className="mt-2 text-[34px] font-semibold leading-none text-ink">{data.pendingRequests}</div>
          <div className="mt-2 text-[12.5px] text-ink-3">{data.pendingRequests === 1 ? "access request awaiting review" : "access requests awaiting review"}</div>
        </Link>
      </div>

      <div className="grid gap-4 lg:grid-cols-[1fr_1.4fr]">
        <div className="space-y-4">
          <Card>
            <CardTitle
              action={
                <Link href="/permissions" className="text-[13px] font-medium text-violet hover:underline">
                  Manage
                </Link>
              }
            >
              Permission status
            </CardTitle>
            <div className="divide-y divide-line">
              {data.agents.map((a) => (
                <div key={a.id} className="flex items-center justify-between gap-3 py-3 first:pt-0 last:pb-0">
                  <div className="min-w-0">
                    <div className="truncate text-[14px] font-medium text-ink">{a.name}</div>
                    <div className="truncate text-[12.5px] text-ink-3">
                      {a.policy
                        ? a.policy.allowed
                            .map((r) => `${labelFor(r.action)}${r.limitUsdcPerDay ? ` · ${r.limitUsdcPerDay.toLocaleString("en-US")} USDC/day` : ""}`)
                            .slice(0, 2)
                            .join(" · ")
                        : "No policy attached"}
                    </div>
                  </div>
                  <StatusPill status={a.status} />
                </div>
              ))}
              {data.agents.length === 0 && <p className="text-[13.5px] text-ink-3">Register an agent to attach a passport.</p>}
            </div>
          </Card>

          <RunAction
            agents={data.agents}
            onDone={() => refetch({ silent: true })}
            preset={{
              agentName: "Trading Assistant",
              action: "withdraw",
              amountUsdc: 4800,
              app: "Monad DEX",
              title: "Run an unauthorized action",
              body: "Trading Assistant will attempt to withdraw 4,800 USDC. Fuku should block it, anchor the proof and explain why.",
            }}
          />
          <RunAction
            agents={data.agents}
            onDone={() => refetch({ silent: true })}
            preset={{
              agentName: "Payments Agent",
              action: "transfer",
              amountUsdc: 250,
              to: DEMO_RECIPIENTS[0].address,
              asset: "aUSDC",
              title: "Pay a verified supplier",
              body: "Payments Agent sends 250 aUSDC to Nusantara Supplies. Fuku checks both A-Passes with Cleanverse (simulator until the API invite lands), then moves the token through FukuSpendGuard.",
            }}
          />
        </div>

        <Card>
          <CardTitle
            action={
              <Link href="/activity" className="text-[13px] font-medium text-violet hover:underline">
                View all
              </Link>
            }
          >
            Recent activity
          </CardTitle>
          <ActivityTimeline items={data.activity} compact />
          {data.activity.length > 0 && (
            <div className="mt-2 border-t border-line pt-3">
              <Mono>Every decision is hashed and anchored on Monad. Open the timeline for proofs.</Mono>
            </div>
          )}
        </Card>
      </div>

      <RegisterAgentDialog
        open={registerOpen}
        onOpenChange={setRegisterOpen}
        onRegistered={(agent) => {
          refetch({ silent: true });
          router.push(`/permissions?agent=${encodeURIComponent(agent.id)}`);
        }}
      />
    </div>
  );
}

function DashboardSkeleton() {
  return (
    <div className="space-y-6">
      <Skeleton className="h-10 w-72" />
      <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-4">
        {[0, 1, 2, 3].map((i) => (
          <Skeleton key={i} className="h-[132px] rounded-2xl" />
        ))}
      </div>
      <div className="grid gap-4 lg:grid-cols-[1fr_1.4fr]">
        <Skeleton className="h-[360px] rounded-2xl" />
        <Skeleton className="h-[360px] rounded-2xl" />
      </div>
    </div>
  );
}
