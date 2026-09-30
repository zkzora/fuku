"use client";

import { useMemo, useState } from "react";
import { Check, ShieldCheck, ShieldOff } from "lucide-react";
import { toast } from "sonner";
import { Mono, Pill, StatusPill } from "@/components/bits";
import { api } from "@/lib/client";
import { ACTIONS, DEFAULT_BLOCKED, labelFor, VALUE_ACTIONS, type PolicyDoc } from "@/lib/engine/policy";
import type { AgentView } from "@/lib/services/agents";
import { shortHex, shortId } from "@/lib/ids";
import { cn } from "@/lib/utils";

type RuleState = "allowed" | "blocked" | "off";

/**
 * PermissionCard: the Agent Permission Passport editor. Reads like security settings:
 * each capability is Allowed (with an optional daily USDC limit), Blocked, or simply not granted.
 */
export function PolicyEditor({ agent, onSaved }: { agent: AgentView; onSaved: () => void }) {
  const initial = useMemo(() => fromPolicy(agent.policy, agent.capabilities), [agent.policy, agent.capabilities]);
  const [rules, setRules] = useState(initial.rules);
  const [limits, setLimits] = useState(initial.limits);
  const [scope, setScope] = useState(initial.scope);
  const [busy, setBusy] = useState<null | "save" | "revoke">(null);
  // The parent remounts this editor (via `key`) whenever the agent or its passport changes.

  const dirty = JSON.stringify({ rules, limits, scope }) !== JSON.stringify(initial);

  function setRule(action: string, state: RuleState) {
    setRules((r) => ({ ...r, [action]: state }));
  }

  async function save() {
    const doc: PolicyDoc = {
      allowed: ACTIONS.filter((a) => rules[a] === "allowed").map((a) => ({
        action: a,
        ...(VALUE_ACTIONS.has(a) && limits[a] ? { limitUsdcPerDay: Number(limits[a]) } : {}),
      })),
      blocked: ACTIONS.filter((a) => rules[a] === "blocked"),
      scopeApps: scope.split(",").map((s) => s.trim()).filter(Boolean),
      assets: agent.policy?.assets ?? [],
    };
    if (doc.allowed.length === 0) return toast.error("Allow at least one capability.");
    setBusy("save");
    try {
      await api(`/api/agents/${encodeURIComponent(agent.id)}/policy`, { method: "PUT", json: doc });
      toast.success("Passport approved and anchored on Monad.");
      onSaved();
    } catch (err) {
      toast.error((err as Error).message);
    } finally {
      setBusy(null);
    }
  }

  async function revoke() {
    setBusy("revoke");
    try {
      await api(`/api/agents/${encodeURIComponent(agent.id)}/policy`, { method: "DELETE" });
      toast.success("Passport revoked. Agent paused.");
      onSaved();
    } catch (err) {
      toast.error((err as Error).message);
    } finally {
      setBusy(null);
    }
  }

  const allowedCount = Object.values(rules).filter((r) => r === "allowed").length;
  const blockedCount = Object.values(rules).filter((r) => r === "blocked").length;

  return (
    <div className="fuku-card overflow-hidden">
      <div className="flex flex-wrap items-center justify-between gap-3 border-b border-line px-6 py-5">
        <div className="flex items-center gap-3">
          <span className="grid size-10 place-items-center rounded-xl bg-violet-soft text-[15px] font-semibold text-violet">{agent.name[0]}</span>
          <div>
            <div className="flex items-center gap-2">
              <span className="text-[16px] font-semibold text-ink">{agent.name}</span>
              <StatusPill status={agent.status} />
            </div>
            <Mono>
              {shortId(agent.id)} · v{agent.version}
              {agent.policy ? ` · passport v${agent.policy.version}` : " · no passport"}
            </Mono>
          </div>
        </div>
        <div className="flex items-center gap-2 text-[12.5px] text-ink-3">
          <Pill tone="allow">{allowedCount} allowed</Pill>
          <Pill tone="block">{blockedCount} blocked</Pill>
        </div>
      </div>

      <div className="divide-y divide-line">
        {ACTIONS.map((a) => {
          const state = rules[a];
          const declared = agent.capabilities.includes(a);
          return (
            <div key={a} className={cn("grid items-center gap-3 px-6 py-3 md:grid-cols-[1.3fr_auto_1fr]", state === "off" && "opacity-70")}>
              <div>
                <div className="text-[14px] font-medium text-ink">
                  {labelFor(a)}
                  {declared && <span className="ml-2 text-[11px] font-semibold uppercase tracking-[0.06em] text-violet">declared</span>}
                </div>
                <div className="text-[12px] text-ink-3">
                  {state === "allowed" ? "Agent may perform this." : state === "blocked" ? "Hard block. Attempts are recorded as violations." : "Not granted. Denied by default."}
                </div>
              </div>
              <div className="flex rounded-lg bg-surface p-0.5 text-[12.5px] font-medium">
                {(["allowed", "off", "blocked"] as RuleState[]).map((s) => (
                  <button
                    key={s}
                    onClick={() => setRule(a, s)}
                    className={cn(
                      "rounded-md px-2.5 py-1.5 transition",
                      state === s
                        ? s === "allowed"
                          ? "bg-allow-soft text-allow shadow-sm"
                          : s === "blocked"
                            ? "bg-block-soft text-block shadow-sm"
                            : "bg-white text-ink shadow-sm"
                        : "text-ink-3 hover:text-ink",
                    )}
                  >
                    {s === "off" ? "Not granted" : s === "allowed" ? "Allow" : "Block"}
                  </button>
                ))}
              </div>
              <div className="flex items-center justify-end gap-2">
                {VALUE_ACTIONS.has(a) && state === "allowed" && (
                  <label className="flex items-center gap-2 text-[12.5px] text-ink-3">
                    Limit
                    <input
                      value={limits[a] ?? ""}
                      onChange={(e) => setLimits((l) => ({ ...l, [a]: e.target.value }))}
                      placeholder="none"
                      inputMode="decimal"
                      className="h-8 w-24 rounded-lg border border-input px-2 text-right text-[13px] text-ink outline-none focus:border-violet"
                    />
                    USDC/day
                  </label>
                )}
              </div>
            </div>
          );
        })}
      </div>

      <div className="grid gap-4 border-t border-line px-6 py-5 md:grid-cols-[1fr_auto] md:items-end">
        <label className="block text-[12.5px] font-medium text-ink-2">
          Application scope <span className="font-normal text-ink-3">(comma separated, empty = any app)</span>
          <input
            value={scope}
            onChange={(e) => setScope(e.target.value)}
            placeholder="Monad DEX, Notion"
            className="mt-1.5 h-10 w-full rounded-xl border border-input px-3 text-[14px] text-ink outline-none focus:border-violet focus:ring-3 focus:ring-violet/20"
          />
        </label>
        <div className="flex items-center gap-2">
          {agent.policy?.active && (
            <button
              onClick={revoke}
              disabled={busy !== null}
              className="inline-flex h-10 items-center gap-2 rounded-xl px-4 text-[14px] font-medium text-block hover:bg-block-soft disabled:opacity-50"
            >
              <ShieldOff className="size-4" /> {busy === "revoke" ? "Revoking…" : "Revoke"}
            </button>
          )}
          <button
            onClick={save}
            disabled={busy !== null || (!dirty && Boolean(agent.policy?.active))}
            className="inline-flex h-10 items-center gap-2 rounded-xl bg-ink px-4 text-[14px] font-medium text-white hover:bg-ink-2 disabled:opacity-40"
          >
            {agent.policy?.active ? <Check className="size-4" /> : <ShieldCheck className="size-4" />}
            {busy === "save" ? "Anchoring…" : agent.policy?.active ? "Approve changes" : "Approve passport"}
          </button>
        </div>
      </div>
      {agent.policy?.txHash && (
        <div className="border-t border-line bg-surface/60 px-6 py-3 text-[12px] text-ink-3">
          Passport hash anchored on Monad · <Mono>{shortHex(agent.policy.txHash, 10, 6)}</Mono>
        </div>
      )}
    </div>
  );
}

function fromPolicy(policy: AgentView["policy"], capabilities: string[]) {
  const rules: Record<string, RuleState> = {};
  const limits: Record<string, string> = {};
  for (const a of ACTIONS) rules[a] = "off";
  if (policy) {
    for (const r of policy.allowed) {
      rules[r.action] = "allowed";
      if (r.limitUsdcPerDay !== undefined) limits[r.action] = String(r.limitUsdcPerDay);
    }
    for (const b of policy.blocked) rules[b] = "blocked";
  } else {
    // Sensible defaults for a new passport: declared capabilities allowed, dangerous actions blocked.
    for (const c of capabilities) rules[c] = "allowed";
    for (const b of DEFAULT_BLOCKED) if (rules[b] !== "allowed") rules[b] = "blocked";
    if (rules.swap === "allowed") limits.swap = "5000";
  }
  return { rules, limits, scope: policy?.scopeApps.join(", ") ?? "" };
}

// Re-exported so the permissions page can render the simple on/off summary used on the dashboard.
export function PolicySummary({ policy }: { policy: AgentView["policy"] }) {
  if (!policy) return <span className="text-[13px] text-ink-3">No policy attached</span>;
  return (
    <div className="flex flex-wrap gap-1.5">
      {policy.allowed.map((r) => (
        <Pill key={r.action} tone="allow" className="normal-case tracking-normal">
          {labelFor(r.action)}
          {r.limitUsdcPerDay ? ` · ${r.limitUsdcPerDay.toLocaleString("en-US")}/day` : ""}
        </Pill>
      ))}
      {policy.blocked.map((b) => (
        <Pill key={b} tone="block" className="normal-case tracking-normal">
          {labelFor(b)}
        </Pill>
      ))}
    </div>
  );
}

