"use client";

import Link from "next/link";
import { Mono, StatusPill } from "@/components/bits";
import { labelFor } from "@/lib/engine/policy";
import type { AgentView } from "@/lib/services/agents";
import { shortId } from "@/lib/ids";

export function AgentCard({ agent }: { agent: AgentView }) {
  return (
    <div className="fuku-card flex flex-col gap-4 p-5">
      <div className="flex items-start justify-between gap-3">
        <span className="grid size-11 place-items-center rounded-xl bg-violet-soft text-[16px] font-semibold text-violet">{agent.name[0]}</span>
        <StatusPill status={agent.status} />
      </div>
      <div>
        <div className="text-[16px] font-semibold text-ink">{agent.name}</div>
        <Mono>
          {shortId(agent.id)} · v{agent.version}
        </Mono>
      </div>
      <div className="flex flex-wrap gap-1.5">
        {agent.capabilities.map((c) => (
          <span key={c} className="rounded-full bg-surface px-2.5 py-1 text-[12px] font-medium text-ink-2">
            {labelFor(c)}
          </span>
        ))}
      </div>
      <div className="mt-auto flex items-center justify-between border-t border-line pt-4">
        <div className="text-[13px] text-ink-3">
          Trust <span className="text-[16px] font-semibold text-ink">{agent.trustScore ?? "—"}</span>
        </div>
        <div className="flex gap-2 text-[13px] font-medium">
          {agent.policy ? (
            <>
              <Link href={`/permissions?agent=${encodeURIComponent(agent.id)}`} className="rounded-lg px-3 py-1.5 text-ink-2 hover:bg-surface">
                Permissions
              </Link>
              <Link href={`/agents/${encodeURIComponent(agent.id)}`} className="rounded-lg bg-ink px-3 py-1.5 text-white hover:bg-ink-2">
                View
              </Link>
            </>
          ) : (
            <Link href={`/permissions?agent=${encodeURIComponent(agent.id)}`} className="rounded-lg bg-violet px-3 py-1.5 text-white hover:bg-violet/90">
              Set permissions
            </Link>
          )}
        </div>
      </div>
    </div>
  );
}
