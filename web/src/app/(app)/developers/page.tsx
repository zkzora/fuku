"use client";

import { useState } from "react";
import { Copy, KeyRound, Play, Trash2 } from "lucide-react";
import { toast } from "sonner";
import { Card, CardTitle, Mono, PageHeader, Pill } from "@/components/bits";
import { Skeleton } from "@/components/ui/skeleton";
import { api, useJson } from "@/lib/client";
import type { IntegrationStatus } from "@/lib/integrations";
import type { AgentView } from "@/lib/services/agents";
import { fmtDate } from "@/lib/format";
import { cn } from "@/lib/utils";

interface Keys {
  keys: { id: string; name: string; prefix: string; createdAt: string; lastUsedAt: string | null }[];
}
interface Integrations {
  integrations: IntegrationStatus[];
  chain: { mode: string; chainId: number; network: string; rpc: string; explorer: string; contracts: Record<string, string> | null };
}

const SDK_SNIPPET = `import { Fuku } from "@fuku/sdk";

const fuku = new Fuku({ apiKey: process.env.FUKU_API_KEY!, baseUrl: "${process.env.NEXT_PUBLIC_APP_URL ?? "http://localhost:3001"}" });

// 1. Who is behind this agent, and is it safe to work with?
const check = await fuku.verifyAgent("fuku:agent:0x7a3f…9c21");
//    { verified: true, owner: { humanVerified: true }, trust: { score: 96, level: "High" } }

// 2. Would this action be allowed? (dry run, nothing recorded)
await fuku.checkPermission(agentId, { action: "withdraw", amountUsdc: 4800 });
//    { allowed: false, ruleId: "R2", reason: "Withdraw funds is on the hard block list…" }

// 3. Execute through Fuku: evaluated, anchored on Monad, scored, explained.
const result = await fuku.executeAction(agentId, { action: "swap", amountUsdc: 1200, app: "Monad DEX" });

// 4. Register your own agent and attach a passport.
const { agent } = await fuku.registerAgent({ name: "Support Agent", capabilities: ["read_vault", "summarize"] });
await fuku.requestPermission(agent.id, { allowed: [{ action: "read_vault" }], blocked: ["withdraw"] });
const trust = await fuku.getTrustScore(agent.id);

// 5. Pay with a Cleanverse A-Token: both A-Passes are checked, then FukuSpendGuard moves the token.
const pay = await fuku.executeAction(paymentsAgentId, { action: "transfer", amountUsdc: 250, asset: "aUSDC", to: supplierWallet });
//    pay.compliance: { asset, owner, counterparty, complianceRef } · pay.transfer?.txHash`;

export default function DevelopersPage() {
  const keys = useJson<Keys>("/api/dev/keys");
  const integrations = useJson<Integrations>("/api/integrations");
  const agents = useJson<{ agents: AgentView[] }>("/api/agents");
  const [newKey, setNewKey] = useState<string | null>(null);
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);

  async function createKey() {
    setBusy(true);
    try {
      const res = await api<{ raw: string }>("/api/dev/keys", { method: "POST", json: { name: name.trim() || "Default" } });
      setNewKey(res.raw);
      setName("");
      keys.refetch({ silent: true });
    } catch (err) {
      toast.error((err as Error).message);
    } finally {
      setBusy(false);
    }
  }
  async function deleteKey(id: string) {
    await api(`/api/dev/keys/${id}`, { method: "DELETE" });
    keys.refetch({ silent: true });
    toast.success("Key revoked.");
  }
  function copy(text: string) {
    navigator.clipboard?.writeText(text).then(() => toast.success("Copied."));
  }

  return (
    <div className="space-y-6">
      <PageHeader title="Developer Console" subtitle="Integrate trust without building the infrastructure. Five calls cover identity, registration, permissions and scoring." />

      <div className="grid gap-4 lg:grid-cols-[1fr_1fr]">
        <Card>
          <CardTitle>API keys</CardTitle>
          <div className="flex gap-2">
            <input
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="Key name (e.g. Monad DEX backend)"
              className="h-10 flex-1 rounded-xl border border-input px-3 text-[14px] text-ink outline-none placeholder:text-ink-3/60 focus:border-violet focus:ring-3 focus:ring-violet/20"
            />
            <button onClick={createKey} disabled={busy} className="inline-flex h-10 items-center gap-2 rounded-xl bg-ink px-4 text-[14px] font-medium text-white hover:bg-ink-2 disabled:opacity-50">
              <KeyRound className="size-4" /> Create key
            </button>
          </div>
          {newKey && (
            <div className="mt-3 rounded-xl bg-violet-soft p-3">
              <div className="text-[12px] font-semibold text-violet">Copy this key now. It will not be shown again.</div>
              <div className="mt-1 flex items-center gap-2">
                <Mono className="break-all text-ink">{newKey}</Mono>
                <button onClick={() => copy(newKey)} className="rounded-lg p-1.5 text-violet hover:bg-white/60" aria-label="Copy key">
                  <Copy className="size-4" />
                </button>
              </div>
            </div>
          )}
          <div className="mt-4 divide-y divide-line">
            {keys.data?.keys.map((k) => (
              <div key={k.id} className="flex items-center justify-between gap-3 py-2.5 first:pt-0 last:pb-0">
                <div>
                  <div className="text-[14px] font-medium text-ink">{k.name}</div>
                  <div className="text-[12px] text-ink-3">
                    <Mono>{k.prefix}…</Mono> · created {fmtDate(k.createdAt)}
                    {k.lastUsedAt ? ` · last used ${fmtDate(k.lastUsedAt)}` : " · never used"}
                  </div>
                </div>
                <button onClick={() => deleteKey(k.id)} className="rounded-lg p-2 text-ink-3 hover:bg-block-soft hover:text-block" aria-label="Revoke">
                  <Trash2 className="size-4" />
                </button>
              </div>
            ))}
            {keys.data && keys.data.keys.length === 0 && <p className="text-[13.5px] text-ink-3">No keys yet.</p>}
            {!keys.data && <Skeleton className="h-16" />}
          </div>
          <p className="mt-4 text-[12px] text-ink-3">
            Demo key for the seeded identity: <Mono>fk_live_demo_ava_chen_2026</Mono>
          </p>
        </Card>

        <Sandbox agents={agents.data?.agents ?? []} />
      </div>

      <Card>
        <CardTitle
          action={
            <button onClick={() => copy(SDK_SNIPPET)} className="inline-flex items-center gap-1.5 text-[13px] font-medium text-violet hover:underline">
              <Copy className="size-3.5" /> Copy
            </button>
          }
        >
          SDK reference
        </CardTitle>
        <pre className="mono overflow-x-auto rounded-xl bg-ink p-5 text-[12.5px] leading-[1.7] text-white/85">{SDK_SNIPPET}</pre>
        <div className="mt-4 grid gap-2 text-[13px] text-ink-2 md:grid-cols-2">
          <Endpoint method="POST" path="/api/v1/identities" fn="createIdentity()" />
          <Endpoint method="POST" path="/api/v1/agents" fn="registerAgent()" />
          <Endpoint method="GET" path="/api/v1/agents/:id" fn="verifyAgent()" />
          <Endpoint method="GET" path="/api/v1/agents/:id/trust" fn="getTrustScore()" />
          <Endpoint method="PUT" path="/api/v1/agents/:id/permissions" fn="requestPermission()" />
          <Endpoint method="POST" path="/api/v1/agents/:id/check" fn="checkPermission()" />
          <Endpoint method="POST" path="/api/v1/agents/:id/execute" fn="executeAction()" />
        </div>
        <p className="mt-3 text-[12.5px] text-ink-3">
          Authenticate with <Mono>Authorization: Bearer fk_live_…</Mono>. The SDK source lives in <Mono>/sdk</Mono>.
        </p>
      </Card>

      <Card>
        <CardTitle
          action={
            integrations.data && (
              <Pill tone={integrations.data.chain.mode === "live" ? "allow" : "warn"} className="normal-case tracking-normal">
                {integrations.data.chain.network} · chain {integrations.data.chain.chainId} · {integrations.data.chain.mode} settlement
              </Pill>
            )
          }
        >
          Integration status
        </CardTitle>
        {!integrations.data ? (
          <Skeleton className="h-40" />
        ) : (
          <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">
            {integrations.data.integrations.map((i) => (
              <div key={i.key} className="rounded-xl bg-surface p-4">
                <div className="flex items-center justify-between">
                  <div className="text-[14px] font-semibold text-ink">{i.name}</div>
                  <div className="flex items-center gap-1.5">
                    {i.badge && (
                      <Pill tone="warn" className="normal-case tracking-normal">
                        {i.badge}
                      </Pill>
                    )}
                    <Pill tone={i.mode === "live" ? "allow" : i.mode === "off" ? "block" : i.mode === "configured" ? "warn" : "neutral"} dot>
                      {i.mode}
                    </Pill>
                  </div>
                </div>
                <div className="mt-0.5 text-[11px] font-semibold uppercase tracking-[0.08em] text-ink-3">{i.category}</div>
                <div className="mt-2 text-[13px] text-ink-2">{i.role}</div>
                <div className="mt-1.5 text-[12px] text-ink-3">{i.detail}</div>
                {i.endpoints && i.endpoints.length > 0 && (
                  <div className="mt-2 flex flex-wrap gap-1">
                    {i.endpoints.map((e) => (
                      <Mono key={e} className="rounded bg-white px-1.5 py-0.5 text-[10.5px]">
                        /{e}
                      </Mono>
                    ))}
                  </div>
                )}
                {i.envVars.length > 0 && (
                  <div className="mt-2 text-[11px] text-ink-3">
                    env: <Mono className="text-[11px]">{i.envVars.join(", ")}</Mono>
                  </div>
                )}
              </div>
            ))}
          </div>
        )}
      </Card>
    </div>
  );
}

function Endpoint({ method, path, fn }: { method: string; path: string; fn: string }) {
  return (
    <div className="flex items-center gap-3 rounded-lg bg-surface px-3 py-2">
      <span className={cn("w-11 text-[11px] font-bold", method === "GET" ? "text-allow" : method === "PUT" ? "text-warn" : "text-violet")}>{method}</span>
      <Mono className="text-ink">{path}</Mono>
      <span className="ml-auto text-[12px] text-ink-3">{fn}</span>
    </div>
  );
}

/** Runs the demo flow against the public v1 API with the demo key, from the browser. */
function Sandbox({ agents }: { agents: AgentView[] }) {
  const [log, setLog] = useState<{ title: string; body: string; ok: boolean }[]>([]);
  const [busy, setBusy] = useState(false);
  const target = agents.find((a) => a.name === "Trading Assistant") ?? agents[0];

  async function call(method: string, path: string, body?: unknown) {
    const res = await fetch(path, {
      method,
      headers: { "content-type": "application/json", authorization: "Bearer fk_live_demo_ava_chen_2026" },
      body: body ? JSON.stringify(body) : undefined,
    });
    return { status: res.status, json: await res.json() };
  }

  async function run() {
    if (!target) return toast.error("No agent available.");
    setBusy(true);
    setLog([]);
    const id = encodeURIComponent(target.id);
    const steps: { title: string; run: () => Promise<{ status: number; json: unknown }> }[] = [
      { title: `GET /api/v1/agents/:id  · verifyAgent`, run: () => call("GET", `/api/v1/agents/${id}`) },
      { title: `POST …/check  · checkPermission withdraw 4,800`, run: () => call("POST", `/api/v1/agents/${id}/check`, { action: "withdraw", amountUsdc: 4800 }) },
      { title: `POST …/execute  · executeAction swap 250`, run: () => call("POST", `/api/v1/agents/${id}/execute`, { action: "swap", amountUsdc: 250, app: "Monad DEX" }) },
      { title: `GET …/trust  · getTrustScore`, run: () => call("GET", `/api/v1/agents/${id}/trust?explain=0`) },
    ];
    for (const s of steps) {
      try {
        const r = await s.run();
        setLog((l) => [...l, { title: s.title, body: JSON.stringify(r.json, null, 2).slice(0, 900), ok: r.status < 400 || r.status === 403 }]);
      } catch (err) {
        setLog((l) => [...l, { title: s.title, body: (err as Error).message, ok: false }]);
      }
    }
    setBusy(false);
  }

  return (
    <Card>
      <CardTitle
        action={
          <button onClick={run} disabled={busy} className="inline-flex h-9 items-center gap-2 rounded-xl bg-ink px-3.5 text-[13px] font-medium text-white hover:bg-ink-2 disabled:opacity-50">
            <Play className="size-3.5" /> {busy ? "Running…" : "Run demo flow"}
          </button>
        }
      >
        Testing environment
      </CardTitle>
      <p className="text-[13px] text-ink-3">
        Calls the public API with the demo key against {target ? <strong className="text-ink">{target.name}</strong> : "your first agent"}: verify → dry-run a withdrawal → execute a swap → read the trust score.
      </p>
      <div className="mt-3 max-h-[380px] space-y-2 overflow-y-auto">
        {log.map((l, i) => (
          <details key={i} open={i === log.length - 1} className="rounded-xl bg-surface p-3">
            <summary className="flex cursor-pointer items-center gap-2 text-[13px] font-medium text-ink">
              <span className={cn("size-2 rounded-full", l.ok ? "bg-allow" : "bg-block")} />
              {l.title}
            </summary>
            <pre className="mono mt-2 overflow-x-auto text-[11.5px] leading-[1.6] text-ink-2">{l.body}</pre>
          </details>
        ))}
        {log.length === 0 && !busy && <p className="rounded-xl border border-dashed border-line p-4 text-center text-[13px] text-ink-3">Output appears here.</p>}
      </div>
    </Card>
  );
}
