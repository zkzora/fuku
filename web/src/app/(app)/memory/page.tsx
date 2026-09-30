"use client";

import { useEffect, useMemo, useState } from "react";
import { Lock, Plus, Trash2, Unlock } from "lucide-react";
import { toast } from "sonner";
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "@/components/ui/dialog";
import { Card, CardTitle, Empty, Mono, PageHeader, Pill, StatusPill } from "@/components/bits";
import { Skeleton } from "@/components/ui/skeleton";
import { api, useJson } from "@/lib/client";
import { decryptText, deriveVaultKey, DEMO_VAULT_PASSPHRASE, encryptText } from "@/lib/vault-crypto";
import { fmtDate } from "@/lib/format";
import { cn } from "@/lib/utils";

const CATEGORIES = [
  { key: "preferences", label: "Preferences" },
  { key: "knowledge", label: "Knowledge" },
  { key: "workflow", label: "Workflow" },
  { key: "rules", label: "Rules" },
] as const;

interface VaultData {
  identityId: string;
  items: { id: string; category: string; title: string; ciphertext: string; iv: string; sizeBytes: number; createdAt: string }[];
  requests: { id: string; app: string; resource: string; status: string; createdAt: string }[];
  approvedApps: { id: string; name: string; scopes: string[] }[];
}

export default function MemoryPage() {
  const { data, loading, refetch } = useJson<VaultData>("/api/memory");
  const [category, setCategory] = useState<string>("preferences");
  const [key, setKey] = useState<CryptoKey | null>(null);
  const [plain, setPlain] = useState<Record<string, string>>({});
  const [addOpen, setAddOpen] = useState(false);

  // The vault key lives only on this device: derived from a passphrase kept in localStorage.
  useEffect(() => {
    if (!data?.identityId) return;
    let passphrase: string | null = null;
    try {
      passphrase = localStorage.getItem(`fuku:vault:${data.identityId}`);
    } catch {}
    if (!passphrase) {
      passphrase = DEMO_VAULT_PASSPHRASE;
      try {
        localStorage.setItem(`fuku:vault:${data.identityId}`, passphrase);
      } catch {}
    }
    deriveVaultKey(data.identityId, passphrase).then(setKey);
  }, [data?.identityId]);

  // Decrypt everything locally whenever the key or the item list changes.
  useEffect(() => {
    if (!key || !data) return;
    let cancelled = false;
    (async () => {
      const out: Record<string, string> = {};
      for (const it of data.items) {
        try {
          out[it.id] = await decryptText(key, it.ciphertext, it.iv);
        } catch {
          out[it.id] = "";
        }
      }
      if (!cancelled) setPlain(out);
    })();
    return () => {
      cancelled = true;
    };
  }, [key, data]);

  const items = useMemo(() => data?.items.filter((i) => i.category === category) ?? [], [data, category]);

  async function remove(id: string) {
    await api(`/api/memory/${id}`, { method: "DELETE" });
    toast.success("Removed from vault.");
    refetch({ silent: true });
  }
  async function review(requestId: string, status: "approved" | "denied") {
    await api("/api/identity/apps", { method: "POST", json: { op: "review", requestId, status } });
    toast.success(status === "approved" ? "Access approved." : "Access denied.");
    refetch({ silent: true });
  }
  async function simulateRequest() {
    await api("/api/memory/requests", { method: "POST", json: { app: "Research Agent", resource: `vault:${category}` } });
    toast("Research Agent is asking for access.", { description: `Scope: vault:${category}` });
    refetch({ silent: true });
  }

  if (loading || !data) return <Skeleton className="h-[520px] rounded-2xl" />;

  return (
    <div className="space-y-6">
      <PageHeader
        title="Memory Vault"
        subtitle="Your AI context, encrypted on this device. Applications and agents only read it with your approval."
        actions={
          <button onClick={() => setAddOpen(true)} className="inline-flex h-10 items-center gap-2 rounded-xl bg-ink px-4 text-[14px] font-medium text-white hover:bg-ink-2">
            <Plus className="size-4" /> Add to vault
          </button>
        }
      />
      <div className="grid gap-4 lg:grid-cols-[1.4fr_1fr]">
        <div className="space-y-4">
          <div className="flex flex-wrap gap-2">
            {CATEGORIES.map((c) => {
              const count = data.items.filter((i) => i.category === c.key).length;
              return (
                <button
                  key={c.key}
                  onClick={() => setCategory(c.key)}
                  className={cn(
                    "rounded-full px-4 py-2 text-[13.5px] font-medium transition",
                    category === c.key ? "bg-ink text-white" : "bg-white text-ink-2 ring-1 ring-line hover:bg-surface",
                  )}
                >
                  {c.label} <span className={category === c.key ? "text-white/70" : "text-ink-3"}>· {count}</span>
                </button>
              );
            })}
          </div>
          {items.length === 0 ? (
            <Empty title={`Nothing in ${category} yet`} body="Add preferences, knowledge, workflows or rules. They are encrypted before they leave this browser." />
          ) : (
            <div className="space-y-3">
              {items.map((it) => (
                <Card key={it.id} className="p-4">
                  <div className="flex items-start justify-between gap-3">
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center gap-2">
                        <span className="text-[14.5px] font-semibold text-ink">{it.title}</span>
                        {plain[it.id] ? (
                          <Pill tone="allow" className="normal-case tracking-normal">
                            <Unlock className="size-3" /> decrypted locally
                          </Pill>
                        ) : (
                          <Pill tone="neutral" className="normal-case tracking-normal">
                            <Lock className="size-3" /> encrypted
                          </Pill>
                        )}
                      </div>
                      <p className="mt-1.5 text-pretty text-[13.5px] leading-[1.55] text-ink-2">
                        {plain[it.id] || <Mono className="break-all">{it.ciphertext.slice(0, 96)}…</Mono>}
                      </p>
                      <div className="mt-2 text-[12px] text-ink-3">
                        AES-256-GCM · {it.sizeBytes} bytes · {fmtDate(it.createdAt)}
                      </div>
                    </div>
                    <button onClick={() => remove(it.id)} className="rounded-lg p-2 text-ink-3 hover:bg-block-soft hover:text-block" aria-label="Delete">
                      <Trash2 className="size-4" />
                    </button>
                  </div>
                </Card>
              ))}
            </div>
          )}
        </div>

        <div className="space-y-4">
          <Card>
            <CardTitle>Approved apps</CardTitle>
            {data.approvedApps.length === 0 ? (
              <p className="text-[13.5px] text-ink-3">No application can read your vault.</p>
            ) : (
              <div className="divide-y divide-line">
                {data.approvedApps.map((a) => (
                  <div key={a.id} className="flex items-center justify-between py-2.5 first:pt-0 last:pb-0">
                    <span className="text-[14px] font-medium text-ink">{a.name}</span>
                    <span className="flex gap-1">
                      {a.scopes
                        .filter((s) => s.startsWith("vault:"))
                        .map((s) => (
                          <Pill key={s} tone="violet" className="normal-case tracking-normal">
                            {s.slice(6)}
                          </Pill>
                        ))}
                    </span>
                  </div>
                ))}
              </div>
            )}
          </Card>
          <Card>
            <CardTitle
              action={
                <button onClick={simulateRequest} className="text-[13px] font-medium text-violet hover:underline">
                  Simulate request
                </button>
              }
            >
              Permission requests
            </CardTitle>
            <div className="divide-y divide-line">
              {data.requests.map((r) => (
                <div key={r.id} className="flex items-center justify-between gap-3 py-2.5 first:pt-0 last:pb-0">
                  <div className="min-w-0">
                    <div className="truncate text-[14px] font-medium text-ink">{r.app}</div>
                    <div className="text-[12px] text-ink-3">
                      {r.resource} · {fmtDate(r.createdAt)}
                    </div>
                  </div>
                  {r.status === "pending" ? (
                    <div className="flex gap-1.5">
                      <button onClick={() => review(r.id, "denied")} className="rounded-lg px-2.5 py-1.5 text-[13px] font-medium text-ink-3 hover:bg-surface">
                        Deny
                      </button>
                      <button onClick={() => review(r.id, "approved")} className="rounded-lg bg-ink px-2.5 py-1.5 text-[13px] font-medium text-white hover:bg-ink-2">
                        Approve
                      </button>
                    </div>
                  ) : (
                    <StatusPill status={r.status} />
                  )}
                </div>
              ))}
              {data.requests.length === 0 && <p className="text-[13.5px] text-ink-3">No requests yet.</p>}
            </div>
          </Card>
          <Card className="bg-surface/60">
            <div className="text-[12.5px] leading-[1.55] text-ink-3">
              <strong className="text-ink">How it works.</strong> Content is encrypted in your browser with a key derived from your passphrase (PBKDF2 → AES-GCM). The server stores only ciphertext. Agents read a category only when the request above is approved, and every read is recorded.
            </div>
          </Card>
        </div>
      </div>

      <AddItemDialog
        key={category}
        open={addOpen}
        onOpenChange={setAddOpen}
        category={category}
        cryptoKey={key}
        onAdded={() => refetch({ silent: true })}
      />
    </div>
  );
}

function AddItemDialog({
  open,
  onOpenChange,
  category,
  cryptoKey,
  onAdded,
}: {
  open: boolean;
  onOpenChange: (o: boolean) => void;
  category: string;
  cryptoKey: CryptoKey | null;
  onAdded: () => void;
}) {
  // Remounted by the parent (via `key`) when the selected category changes.
  const [cat, setCat] = useState(category);
  const [title, setTitle] = useState("");
  const [content, setContent] = useState("");
  const [busy, setBusy] = useState(false);

  async function submit() {
    if (!cryptoKey) return toast.error("Vault key not ready yet.");
    if (!title.trim() || !content.trim()) return toast.error("Add a title and some content.");
    setBusy(true);
    try {
      const enc = await encryptText(cryptoKey, content.trim());
      await api("/api/memory", { method: "POST", json: { category: cat, title: title.trim(), ...enc } });
      toast.success("Encrypted and stored.");
      onAdded();
      onOpenChange(false);
      setTitle("");
      setContent("");
    } catch (err) {
      toast.error((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-[520px] p-7 sm:max-w-[520px]">
        <DialogTitle className="text-[20px] font-semibold">Add to vault</DialogTitle>
        <DialogDescription className="text-[13.5px] text-ink-3">Encrypted on this device before upload.</DialogDescription>
        <div className="mt-2 space-y-4">
          <div className="flex gap-2">
            {CATEGORIES.map((c) => (
              <button
                key={c.key}
                onClick={() => setCat(c.key)}
                className={cn("rounded-full px-3 py-1.5 text-[13px] font-medium", cat === c.key ? "bg-violet-soft text-violet" : "bg-surface text-ink-2")}
              >
                {c.label}
              </button>
            ))}
          </div>
          <input value={title} onChange={(e) => setTitle(e.target.value)} placeholder="Title" className={inputCls} />
          <textarea
            value={content}
            onChange={(e) => setContent(e.target.value)}
            placeholder="Never move more than 5% of the portfolio in one trade."
            rows={4}
            className={cn(inputCls, "h-auto py-2.5")}
          />
          <div className="flex justify-end gap-2">
            <button onClick={() => onOpenChange(false)} className="rounded-xl px-4 py-2.5 text-[14px] font-medium text-ink-2 hover:bg-surface">
              Cancel
            </button>
            <button onClick={submit} disabled={busy} className="inline-flex items-center gap-2 rounded-xl bg-ink px-4 py-2.5 text-[14px] font-medium text-white hover:bg-ink-2 disabled:opacity-50">
              <Lock className="size-4" /> {busy ? "Encrypting…" : "Encrypt & store"}
            </button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}

const inputCls =
  "h-10 w-full rounded-xl border border-input bg-white px-3 text-[14px] text-ink outline-none placeholder:text-ink-3/60 focus:border-violet focus:ring-3 focus:ring-violet/20";
