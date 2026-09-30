"use client";

import { useState } from "react";
import { Plus } from "lucide-react";
import { toast } from "sonner";
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "@/components/ui/dialog";
import { api } from "@/lib/client";
import { ACTIONS, labelFor } from "@/lib/engine/policy";
import type { AgentView } from "@/lib/services/agents";
import { cn } from "@/lib/utils";

export function RegisterAgentDialog({
  open,
  onOpenChange,
  onRegistered,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onRegistered: (agent: AgentView) => void;
}) {
  const [name, setName] = useState("");
  const [version, setVersion] = useState("1.0");
  const [description, setDescription] = useState("");
  const [caps, setCaps] = useState<string[]>(["swap", "read_balances"]);
  const [busy, setBusy] = useState(false);

  function toggle(c: string) {
    setCaps((prev) => (prev.includes(c) ? prev.filter((x) => x !== c) : [...prev, c]));
  }

  async function submit() {
    if (name.trim().length < 2) return toast.error("Give the agent a name.");
    if (caps.length === 0) return toast.error("Pick at least one capability.");
    setBusy(true);
    try {
      const res = await api<{ agent: AgentView }>("/api/agents", {
        method: "POST",
        json: { name: name.trim(), version: version.trim() || "1.0", capabilities: caps, description: description.trim() || undefined },
      });
      toast.success(`${res.agent.name} registered. Attach a passport to activate it.`);
      onRegistered(res.agent);
      onOpenChange(false);
      setName("");
      setDescription("");
    } catch (err) {
      toast.error((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-[520px] p-7 sm:max-w-[520px]">
        <DialogTitle className="text-[20px] font-semibold">Register an AI agent</DialogTitle>
        <DialogDescription className="text-[13.5px] text-ink-3">
          The agent gets a portable Fuku identity owned by you. It stays inactive until you attach a permission passport.
        </DialogDescription>
        <div className="mt-2 space-y-4">
          <div className="grid grid-cols-[1fr_96px] gap-3">
            <L label="Name">
              <input value={name} onChange={(e) => setName(e.target.value)} placeholder="Portfolio Rebalancer" className={inputCls} autoFocus />
            </L>
            <L label="Version">
              <input value={version} onChange={(e) => setVersion(e.target.value)} className={inputCls} />
            </L>
          </div>
          <L label="What it does (optional)">
            <input value={description} onChange={(e) => setDescription(e.target.value)} placeholder="Proposes rebalancing swaps toward the target allocation." className={inputCls} />
          </L>
          <L label="Declared capabilities">
            <div className="flex flex-wrap gap-2">
              {ACTIONS.map((c) => (
                <button
                  key={c}
                  type="button"
                  onClick={() => toggle(c)}
                  className={cn(
                    "rounded-full px-3 py-1.5 text-[13px] font-medium transition",
                    caps.includes(c) ? "bg-violet-soft text-violet ring-1 ring-violet/30" : "bg-surface text-ink-2 hover:bg-line",
                  )}
                >
                  {labelFor(c)}
                </button>
              ))}
            </div>
          </L>
          <div className="flex justify-end gap-2 pt-2">
            <button onClick={() => onOpenChange(false)} className="rounded-xl px-4 py-2.5 text-[14px] font-medium text-ink-2 hover:bg-surface">
              Cancel
            </button>
            <button
              onClick={submit}
              disabled={busy}
              className="inline-flex items-center gap-2 rounded-xl bg-ink px-4 py-2.5 text-[14px] font-medium text-white hover:bg-ink-2 disabled:opacity-50"
            >
              <Plus className="size-4" /> {busy ? "Registering on Monad…" : "Register agent"}
            </button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}

const inputCls =
  "h-10 w-full rounded-xl border border-input bg-white px-3 text-[14px] text-ink outline-none placeholder:text-ink-3/60 focus:border-violet focus:ring-3 focus:ring-violet/20";

function L({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className="block text-[12.5px] font-medium text-ink-2">
      {label}
      <div className="mt-1.5">{children}</div>
    </label>
  );
}
