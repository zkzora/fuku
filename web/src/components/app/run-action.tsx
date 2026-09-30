"use client";

import { useState } from "react";
import { Play } from "lucide-react";
import { toast } from "sonner";
import { api } from "@/lib/client";
import { ACTIONS, labelFor, VALUE_ACTIONS } from "@/lib/engine/policy";
import type { ActionResult } from "@/lib/services/actions";
import type { AgentView } from "@/lib/services/agents";
import { ActionResultDialog } from "./action-result-dialog";
import { cn } from "@/lib/utils";

/**
 * Runs an agent action through the full Fuku workflow and shows the outcome.
 * `preset` powers the one-click demo climax (Trading Assistant tries to withdraw 4,800 USDC).
 */
export function RunAction({
  agents,
  onDone,
  preset,
  compact,
}: {
  agents: AgentView[];
  onDone?: () => void;
  preset?: { agentName: string; action: string; amountUsdc?: number; app?: string; title: string; body: string };
  compact?: boolean;
}) {
  const presetAgent = preset ? agents.find((a) => a.name === preset.agentName) : undefined;
  const [agentId, setAgentId] = useState(presetAgent?.id ?? agents[0]?.id ?? "");
  const [action, setAction] = useState(preset?.action ?? "swap");
  const [amount, setAmount] = useState<string>(preset?.amountUsdc ? String(preset.amountUsdc) : "1200");
  const [app, setApp] = useState(preset?.app ?? "Monad DEX");
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<ActionResult | null>(null);

  async function run(overrides?: { agentId?: string; action?: string; amountUsdc?: number; app?: string }) {
    const target = overrides?.agentId ?? agentId;
    if (!target) return toast.error("Register an agent first.");
    const act = overrides?.action ?? action;
    setBusy(true);
    try {
      const res = await api<ActionResult>(`/api/agents/${encodeURIComponent(target)}/actions`, {
        method: "POST",
        json: {
          action: act,
          amountUsdc: VALUE_ACTIONS.has(act) ? (overrides?.amountUsdc ?? (Number(amount) || 0)) : null,
          app: overrides?.app ?? app ?? null,
        },
      });
      setResult(res);
      onDone?.();
    } catch (err) {
      toast.error((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      {preset ? (
        <div className={cn("fuku-card flex flex-col gap-4 p-5", compact && "p-4")}>
          <div>
            <div className="text-[11px] font-semibold uppercase tracking-[0.1em] text-violet">Demo</div>
            <div className="mt-1 text-[16px] font-semibold text-ink">{preset.title}</div>
            <p className="mt-1 text-[13.5px] text-ink-3">{preset.body}</p>
          </div>
          <button
            onClick={() =>
              run({ agentId: presetAgent?.id, action: preset.action, amountUsdc: preset.amountUsdc, app: preset.app })
            }
            disabled={busy || !presetAgent}
            className="inline-flex h-10 items-center justify-center gap-2 rounded-xl bg-ink px-4 text-[14px] font-medium text-white transition hover:bg-ink-2 disabled:opacity-50"
          >
            <Play className="size-4" />
            {busy ? "Running through Fuku…" : "Run agent action"}
          </button>
        </div>
      ) : (
        <div className="fuku-card p-5">
          <div className="grid gap-3 md:grid-cols-[1.2fr_1fr_0.8fr_1fr_auto] md:items-end">
            <Field label="Agent">
              <select value={agentId} onChange={(e) => setAgentId(e.target.value)} className={inputCls}>
                {agents.map((a) => (
                  <option key={a.id} value={a.id}>
                    {a.name} · {a.status}
                  </option>
                ))}
              </select>
            </Field>
            <Field label="Action">
              <select value={action} onChange={(e) => setAction(e.target.value)} className={inputCls}>
                {ACTIONS.map((a) => (
                  <option key={a} value={a}>
                    {labelFor(a)}
                  </option>
                ))}
              </select>
            </Field>
            <Field label="Amount (USDC)">
              <input
                value={amount}
                onChange={(e) => setAmount(e.target.value)}
                disabled={!VALUE_ACTIONS.has(action)}
                inputMode="decimal"
                className={cn(inputCls, "disabled:opacity-40")}
              />
            </Field>
            <Field label="Application">
              <input value={app} onChange={(e) => setApp(e.target.value)} className={inputCls} />
            </Field>
            <button
              onClick={() => run()}
              disabled={busy}
              className="inline-flex h-10 items-center justify-center gap-2 rounded-xl bg-ink px-4 text-[14px] font-medium text-white transition hover:bg-ink-2 disabled:opacity-50"
            >
              <Play className="size-4" />
              {busy ? "Running…" : "Run"}
            </button>
          </div>
        </div>
      )}
      <ActionResultDialog result={result} onClose={() => setResult(null)} />
    </>
  );
}

const inputCls =
  "h-10 w-full rounded-xl border border-input bg-white px-3 text-[14px] text-ink outline-none focus:border-violet focus:ring-3 focus:ring-violet/20";

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className="block text-[12px] font-medium text-ink-3">
      {label}
      <div className="mt-1.5">{children}</div>
    </label>
  );
}
