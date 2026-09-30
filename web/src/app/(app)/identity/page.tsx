"use client";

import { useState } from "react";
import dynamic from "next/dynamic";
import { ExternalLink, Wallet } from "lucide-react";
import { toast } from "sonner";
import { Card, CardTitle, Mono, PageHeader, Pill, Row, StatusPill } from "@/components/bits";
import { IdentityCard } from "@/components/app/identity-card";
import { Skeleton } from "@/components/ui/skeleton";
import { api, useJson } from "@/lib/client";
import { fmtDate } from "@/lib/format";
import { shortHex } from "@/lib/ids";

const DynamicLogin = dynamic(() => import("@/components/dynamic/dynamic-login"), {
  ssr: false,
  loading: () => <div className="h-11 animate-pulse rounded-xl bg-surface" />,
});
const DYNAMIC_ENABLED = Boolean(process.env.NEXT_PUBLIC_DYNAMIC_ENV_ID);

interface IdentityData {
  identity: {
    id: string;
    displayName: string;
    humanVerified: boolean;
    authMethod: string;
    network: string;
    proofHash: string | null;
    proofTxHash: string | null;
    proofBlock: number | null;
    walletAddress: string | null;
    dynamicUserId: string | null;
    email: string | null;
    createdAt: string;
  };
  agentCount: number;
  chain: { mode: string; explorer: string; network: string };
  passkeys: { id: string; label: string; deviceType: string; backedUp: boolean; createdAt: string }[];
  connectedApps: { id: string; name: string; scopes: string[]; status: string; connectedAt: string }[];
  credentials: { id: string; issuer: string; kind: string; status: string; validUntil: string | null }[];
  accessRequests: { id: string; app: string; resource: string; status: string; createdAt: string }[];
}

export default function IdentityPage() {
  const { data, loading, refetch } = useJson<IdentityData>("/api/identity");
  const [linking, setLinking] = useState(false);
  if (loading || !data) return <Skeleton className="h-[480px] rounded-2xl" />;

  const pending = data.accessRequests.filter((r) => r.status === "pending");

  async function disconnect(id: string) {
    await api("/api/identity/apps", { method: "POST", json: { op: "disconnect", id } });
    toast.success("Application disconnected.");
    refetch({ silent: true });
  }
  async function review(requestId: string, status: "approved" | "denied") {
    await api("/api/identity/apps", { method: "POST", json: { op: "review", requestId, status } });
    toast.success(status === "approved" ? "Access approved." : "Access denied.");
    refetch({ silent: true });
  }

  return (
    <div className="space-y-6">
      <PageHeader title="Identity" subtitle="The verified human behind your agents." />
      <div className="grid gap-4 lg:grid-cols-[1.1fr_1fr]">
        <div className="space-y-4">
          <IdentityCard identity={data.identity} passkeyLabel={data.passkeys[0]?.label} />
          <Card>
            <Row label="Created" value={fmtDate(data.identity.createdAt)} />
            <Row label="Network" value={data.chain.network} />
            <Row label="Agents owned" value={data.agentCount} />
            <Row label="Identity id" value={data.identity.id} mono />
          </Card>

          <Card>
            <CardTitle>Authentication method</CardTitle>
            {data.passkeys.length === 0 ? (
              <p className="text-[13.5px] text-ink-3">
                {data.identity.authMethod === "passkey"
                  ? "No passkeys on record."
                  : "This identity signed in without a passkey. Create a passkey identity to become human-verified."}
              </p>
            ) : (
              <div className="divide-y divide-line">
                {data.passkeys.map((p) => (
                  <div key={p.id} className="flex items-center justify-between py-3 first:pt-0 last:pb-0">
                    <div>
                      <div className="text-[14px] font-medium text-ink">Passkey · WebAuthn (P-256)</div>
                      <div className="text-[12.5px] text-ink-3">
                        {p.label} · {p.deviceType === "multiDevice" ? "synced" : "device-bound"} · added {fmtDate(p.createdAt)}
                      </div>
                    </div>
                    <Pill tone="allow" dot>
                      Active
                    </Pill>
                  </div>
                ))}
              </div>
            )}
          </Card>

          <Card>
            <CardTitle>Owner wallet</CardTitle>
            {data.identity.walletAddress ? (
              <div className="flex items-start gap-3">
                <span className="grid size-9 shrink-0 place-items-center rounded-xl bg-violet-soft">
                  <Wallet className="size-4 text-violet" />
                </span>
                <div className="min-w-0">
                  <Mono className="block break-all text-ink">{data.identity.walletAddress}</Mono>
                  <div className="mt-0.5 text-[12.5px] text-ink-3">
                    {data.identity.dynamicUserId
                      ? `Embedded EVM wallet via Dynamic${data.identity.email ? ` · ${data.identity.email}` : ""}`
                      : "Wallet recorded on this identity"}
                  </div>
                </div>
              </div>
            ) : (
              <p className="text-[13.5px] text-ink-3">No wallet is linked to this identity yet.</p>
            )}
            {DYNAMIC_ENABLED && !data.identity.dynamicUserId && (
              <div className="mt-4 border-t border-line pt-4">
                {linking ? (
                  <DynamicLogin
                    mode="link"
                    onLinked={() => {
                      setLinking(false);
                      refetch({ silent: true });
                    }}
                  />
                ) : (
                  <button
                    onClick={() => setLinking(true)}
                    className="inline-flex h-10 items-center gap-2 rounded-xl bg-ink px-4 text-[14px] font-medium text-white hover:bg-ink-2"
                  >
                    <Wallet className="size-4" /> {data.identity.walletAddress ? "Link a Dynamic wallet instead" : "Connect wallet with Dynamic"}
                  </button>
                )}
              </div>
            )}
          </Card>

          <Card>
            <CardTitle>Ownership proof</CardTitle>
            <div className="flex items-start justify-between gap-4">
              <div>
                <div className="text-[14px] font-medium text-ink">Signed &amp; anchored on Monad</div>
                <div className="mt-0.5 text-[12.5px] text-ink-3">
                  tx <Mono>{shortHex(data.identity.proofTxHash, 8, 4)}</Mono>
                  {data.identity.proofBlock ? ` · block ${data.identity.proofBlock.toLocaleString("en-US")}` : ""}
                  {data.chain.mode === "mock" ? " · mock receipt" : ""}
                </div>
                <div className="mt-2 text-[12px] text-ink-3">
                  Proof hash <Mono className="break-all">{data.identity.proofHash}</Mono>
                </div>
              </div>
              {data.identity.proofTxHash && (
                <a
                  href={`${data.chain.explorer}/tx/${data.identity.proofTxHash}`}
                  target="_blank"
                  rel="noreferrer"
                  className="inline-flex shrink-0 items-center gap-1 rounded-lg px-3 py-1.5 text-[13px] font-medium text-violet hover:bg-violet-soft"
                >
                  View proof <ExternalLink className="size-3.5" />
                </a>
              )}
            </div>
          </Card>
        </div>

        <div className="space-y-4">
          <Card>
            <CardTitle>Credentials</CardTitle>
            {data.credentials.length === 0 ? (
              <p className="text-[13.5px] text-ink-3">No credentials attached.</p>
            ) : (
              data.credentials.map((c) => (
                <div key={c.id} className="flex items-center justify-between py-1">
                  <div>
                    <div className="text-[14px] font-medium text-ink">{c.kind}</div>
                    <div className="text-[12.5px] text-ink-3">
                      Issued by {c.issuer}
                      {c.validUntil ? ` · valid to ${fmtDate(c.validUntil, { day: undefined })}` : ""}
                    </div>
                  </div>
                  <StatusPill status={c.status} />
                </div>
              ))
            )}
          </Card>

          <Card>
            <CardTitle>
              Connected applications{" "}
              <span className="font-normal text-ink-3">· {data.connectedApps.filter((a) => a.status === "active").length} can verify your identity</span>
            </CardTitle>
            <div className="divide-y divide-line">
              {pending.map((r) => (
                <div key={r.id} className="flex items-center justify-between gap-3 py-3 first:pt-0">
                  <div>
                    <div className="text-[14px] font-medium text-ink">{r.app}</div>
                    <div className="text-[12.5px] text-ink-3">Requested {fmtDate(r.createdAt)} · {scopeLabel(r.resource)}</div>
                  </div>
                  <div className="flex items-center gap-2">
                    <StatusPill status="pending" />
                    <button onClick={() => review(r.id, "denied")} className="rounded-lg px-2.5 py-1.5 text-[13px] font-medium text-ink-3 hover:bg-surface">
                      Deny
                    </button>
                    <button onClick={() => review(r.id, "approved")} className="rounded-lg bg-ink px-2.5 py-1.5 text-[13px] font-medium text-white hover:bg-ink-2">
                      Approve
                    </button>
                  </div>
                </div>
              ))}
              {data.connectedApps
                .filter((a) => a.status !== "revoked")
                .map((a) => (
                  <div key={a.id} className="flex items-center justify-between gap-3 py-3 first:pt-0 last:pb-0">
                    <div>
                      <div className="text-[14px] font-medium text-ink">{a.name}</div>
                      <div className="text-[12.5px] text-ink-3">
                        Connected {fmtDate(a.connectedAt, { year: undefined })} · {a.scopes.map(scopeLabel).join(" · ")}
                      </div>
                    </div>
                    <div className="flex items-center gap-2">
                      <StatusPill status={a.status} />
                      <button onClick={() => disconnect(a.id)} className="rounded-lg px-2.5 py-1.5 text-[13px] font-medium text-ink-3 hover:bg-surface hover:text-block">
                        Disconnect
                      </button>
                    </div>
                  </div>
                ))}
              {data.connectedApps.length === 0 && pending.length === 0 && (
                <p className="text-[13.5px] text-ink-3">No applications connected yet.</p>
              )}
            </div>
          </Card>
        </div>
      </div>
    </div>
  );
}

function scopeLabel(scope: string) {
  if (scope.startsWith("vault:")) return `Vault: ${scope.slice(6).replace(/^\w/, (c) => c.toUpperCase())}`;
  return scope.replace(/_/g, " ").replace(/^\w/, (c) => c.toUpperCase());
}
