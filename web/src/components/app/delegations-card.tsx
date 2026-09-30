"use client";

import { useState } from "react";
import { toast } from "sonner";
import { Card, CardTitle, Mono, Pill } from "@/components/bits";
import { api, useJson } from "@/lib/client";
import { shortId } from "@/lib/ids";

const SCOPES = [
  { key: "agents:register", label: "Register agents for me" },
  { key: "agents:manage", label: "Change passports and status" },
  { key: "agents:execute", label: "Run my agents' actions" },
] as const;

interface Delegation {
  id: string;
  direction: "granted" | "received";
  owner: { id: string; displayName: string };
  delegate: { id: string; displayName: string };
  scopes: string[];
  expiresAt: string | null;
  revokedAt: string | null;
  active: boolean;
}

/**
 * Delegations let another identity (an application's API identity) act for you with specific
 * scopes. Only you can grant or revoke them, from a signed-in session; an API key can never grant
 * itself rights. Without one, calls for your agents from other keys are refused (403).
 */
export function DelegationsCard({ selfId }: { selfId: string | null }) {
  const { data, refetch } = useJson<{ delegations: Delegation[] }>("/api/delegations");
  const [delegateId, setDelegateId] = useState("");
  const [scopes, setScopes] = useState<string[]>(["agents:execute"]);
  const [days, setDays] = useState("30");
  const [busy, setBusy] = useState(false);

  async function grant() {
    if (!delegateId.trim() || scopes.length === 0) return toast.error("Enter the delegate's identity id and pick at least one scope.");
    setBusy(true);
    try {
      await api("/api/delegations", { method: "POST", json: { delegateId: delegateId.trim(), scopes, expiresInDays: Number(days) || undefined } });
      toast.success("Delegation granted.");
      setDelegateId("");
      refetch({ silent: true });
    } catch (err) {
      toast.error((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  async function revoke(id: string) {
    try {
      await api(`/api/delegations/${encodeURIComponent(id)}`, { method: "DELETE" });
      toast.success("Delegation revoked. It stops working on the next request.");
      refetch({ silent: true });
    } catch (err) {
      toast.error((err as Error).message);
    }
  }

  return (
    <Card>
      <CardTitle>Delegations</CardTitle>
      <p className="text-[13px] text-ink-3">
        Let an application act for you with specific scopes. Other API keys cannot touch your agents without one.
        {selfId && (
          <>
            {" "}
            Your identity id, to receive one: <Mono className="break-all">{selfId}</Mono>
          </>
        )}
      </p>
      <div className="mt-4 grid gap-3 md:grid-cols-[1.4fr_1fr_auto] md:items-end">
        <label className="block text-[12px] font-medium text-ink-3">
          Delegate identity id
          <input
            value={delegateId}
            onChange={(e) => setDelegateId(e.target.value)}
            placeholder="fuku:id:0x…"
            className="mono mt-1.5 h-10 w-full rounded-xl border border-input px-3 text-[13px] text-ink outline-none focus:border-violet"
          />
        </label>
        <label className="block text-[12px] font-medium text-ink-3">
          Expires in (days)
          <input
            value={days}
            onChange={(e) => setDays(e.target.value)}
            inputMode="numeric"
            className="mt-1.5 h-10 w-full rounded-xl border border-input px-3 text-[13px] text-ink outline-none focus:border-violet"
          />
        </label>
        <button onClick={grant} disabled={busy} className="h-10 rounded-xl bg-ink px-4 text-[14px] font-medium text-white hover:bg-ink-2 disabled:opacity-50">
          {busy ? "Granting…" : "Grant"}
        </button>
      </div>
      <div className="mt-3 flex flex-wrap gap-2">
        {SCOPES.map((s) => {
          const on = scopes.includes(s.key);
          return (
            <button
              key={s.key}
              type="button"
              onClick={() => setScopes((cur) => (on ? cur.filter((x) => x !== s.key) : [...cur, s.key]))}
              className={on ? "rounded-lg bg-violet px-2.5 py-1 text-[12.5px] font-medium text-white" : "rounded-lg bg-surface px-2.5 py-1 text-[12.5px] font-medium text-ink-3 hover:text-ink"}
            >
              {s.label}
            </button>
          );
        })}
      </div>
      <div className="mt-4 divide-y divide-line">
        {(data?.delegations ?? []).map((d) => (
          <div key={d.id} className="flex items-center justify-between gap-3 py-2.5">
            <div className="min-w-0 text-[13px]">
              <div className="font-medium text-ink">
                {d.direction === "granted" ? `To ${d.delegate.displayName}` : `From ${d.owner.displayName}`}{" "}
                <Mono className="text-[11.5px]">{shortId(d.direction === "granted" ? d.delegate.id : d.owner.id)}</Mono>
              </div>
              <div className="text-ink-3">
                {d.scopes.join(", ")}
                {d.expiresAt ? ` · until ${d.expiresAt.slice(0, 10)}` : " · no expiry"}
              </div>
            </div>
            <div className="flex items-center gap-2">
              <Pill tone={d.active ? "allow" : "neutral"}>{d.active ? "active" : d.revokedAt ? "revoked" : "expired"}</Pill>
              {d.active && d.direction === "granted" && (
                <button onClick={() => revoke(d.id)} className="rounded-lg px-2.5 py-1.5 text-[13px] font-medium text-ink-3 hover:bg-surface hover:text-block">
                  Revoke
                </button>
              )}
            </div>
          </div>
        ))}
        {data && data.delegations.length === 0 && <p className="py-2 text-[13px] text-ink-3">No delegations yet.</p>}
      </div>
    </Card>
  );
}
