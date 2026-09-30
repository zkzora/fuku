"use client";

import { useEffect, useMemo, useState } from "react";
import { KeyRound, Lock, Plus, Trash2, Unlock } from "lucide-react";
import { toast } from "sonner";
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "@/components/ui/dialog";
import { Card, CardTitle, Empty, Mono, PageHeader, Pill, StatusPill } from "@/components/bits";
import { Skeleton } from "@/components/ui/skeleton";
import { api, useJson } from "@/lib/client";
import {
  decryptText,
  deriveVaultKey,
  DEMO_VAULT_PASSPHRASE,
  encryptText,
  MIN_VAULT_PASSPHRASE_LENGTH,
  VAULT_CHECK_PLAINTEXT,
  vaultKeyMatches,
} from "@/lib/vault-crypto";
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
  vault: { mode: "demo" | "passphrase"; hasPassphrase: boolean; check: { ciphertext: string; iv: string } | null };
  items: { id: string; category: string; title: string; ciphertext: string; iv: string; sizeBytes: number; createdAt: string }[];
  requests: { id: string; app: string; resource: string; status: string; createdAt: string }[];
  approvedApps: { id: string; name: string; scopes: string[] }[];
}

/** Unlocked vault keys, in memory only for this tab (never the passphrase, never localStorage). */
const unlockedKeys = new Map<string, CryptoKey>();

export default function MemoryPage() {
  const { data, loading, refetch } = useJson<VaultData>("/api/memory");
  const [category, setCategory] = useState<string>("preferences");
  const [unlockedKey, setUnlockedKey] = useState<CryptoKey | null>(null);
  const [demoKey, setDemoKey] = useState<CryptoKey | null>(null);
  const [plain, setPlain] = useState<Record<string, string>>({});
  const [addOpen, setAddOpen] = useState(false);
  const [changing, setChanging] = useState(false);
  const identityId = data?.identityId;
  const mode = data?.vault.mode;

  // The key is derived on this device. The seeded demo opens with its public passphrase; everyone
  // else unlocks with their own, which is never stored.
  useEffect(() => {
    if (!identityId || !mode) return;
    try {
      localStorage.removeItem(`fuku:vault:${identityId}`); // earlier builds kept a passphrase here
    } catch {}
    if (mode === "demo") deriveVaultKey(identityId, DEMO_VAULT_PASSPHRASE).then(setDemoKey);
  }, [identityId, mode]);
  const key = mode === "demo" ? demoKey : (unlockedKey ?? (identityId ? (unlockedKeys.get(identityId) ?? null) : null));

  function unlocked(k: CryptoKey) {
    if (!identityId) return;
    unlockedKeys.set(identityId, k);
    setUnlockedKey(k);
    setChanging(false);
  }
  function lock() {
    if (identityId) unlockedKeys.delete(identityId);
    setUnlockedKey(null);
    setPlain({});
  }

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
          <>
            {data.vault.mode === "passphrase" && key && (
              <>
                <button onClick={() => setChanging(true)} className="inline-flex h-10 items-center rounded-xl bg-surface px-4 text-[14px] font-medium text-ink hover:bg-line">
                  Change passphrase
                </button>
                <button onClick={lock} className="inline-flex h-10 items-center gap-2 rounded-xl bg-surface px-4 text-[14px] font-medium text-ink hover:bg-line">
                  <Lock className="size-4" /> Lock
                </button>
              </>
            )}
            <button
              onClick={() => setAddOpen(true)}
              disabled={!key}
              className="inline-flex h-10 items-center gap-2 rounded-xl bg-ink px-4 text-[14px] font-medium text-white hover:bg-ink-2 disabled:opacity-50"
            >
              <Plus className="size-4" /> Add to vault
            </button>
          </>
        }
      />
      {data.vault.mode === "demo" && (
        <p className="-mt-2 text-[12.5px] text-ink-3">
          Demo vault: it opens with a public demo passphrase, so it is not secret. Your own identity uses a passphrase only you know.
        </p>
      )}
      <div className="grid gap-4 lg:grid-cols-[1.4fr_1fr]">
        <div className="space-y-4">
          {data.vault.mode === "passphrase" && (!key || changing) && (
            <VaultGate data={data} currentKey={changing ? key : null} onUnlocked={unlocked} onCancel={changing ? () => setChanging(false) : undefined} onChanged={() => refetch({ silent: true })} />
          )}
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

/**
 * Unlock, create or change the vault passphrase. Creating one over items from earlier builds (which
 * used the public demo passphrase for every identity) re-encrypts them under the new key first.
 */
function VaultGate({
  data,
  currentKey,
  onUnlocked,
  onCancel,
  onChanged,
}: {
  data: VaultData;
  currentKey: CryptoKey | null;
  onUnlocked: (k: CryptoKey) => void;
  onCancel?: () => void;
  onChanged: () => void;
}) {
  const creating = currentKey !== null || !data.vault.hasPassphrase;
  const legacy = currentKey === null && !data.vault.hasPassphrase && data.items.length > 0;
  const [pass, setPass] = useState("");
  const [again, setAgain] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function unlock() {
    setBusy(true);
    setError(null);
    try {
      const k = await deriveVaultKey(data.identityId, pass);
      if (data.vault.check && (await vaultKeyMatches(k, data.vault.check))) onUnlocked(k);
      else setError("That passphrase does not open this vault.");
    } finally {
      setBusy(false);
    }
  }

  async function save() {
    setError(null);
    if (pass.length < MIN_VAULT_PASSPHRASE_LENGTH) return setError(`Use at least ${MIN_VAULT_PASSPHRASE_LENGTH} characters.`);
    if (pass !== again) return setError("The two passphrases differ.");
    if (pass === DEMO_VAULT_PASSPHRASE) return setError("That is the public demo passphrase. Choose your own.");
    setBusy(true);
    try {
      const next = await deriveVaultKey(data.identityId, pass);
      // Re-encrypt every item under the new key: from the current key, or the demo key for old items.
      const from = currentKey ?? (legacy ? await deriveVaultKey(data.identityId, DEMO_VAULT_PASSPHRASE) : null);
      const items = [];
      for (const it of data.items) {
        if (!from) throw new Error("Unlock the vault first.");
        let text: string;
        try {
          text = await decryptText(from, it.ciphertext, it.iv);
        } catch {
          throw new Error(`"${it.title}" cannot be decrypted, so it cannot be moved to the new passphrase.`);
        }
        const enc = await encryptText(next, text);
        items.push({ id: it.id, ciphertext: enc.ciphertext, iv: enc.iv });
      }
      const check = await encryptText(next, VAULT_CHECK_PLAINTEXT);
      await api("/api/memory/vault", { method: "POST", json: { check: { ciphertext: check.ciphertext, iv: check.iv }, items } });
      toast.success(legacy ? "Your vault is now encrypted under your own passphrase." : currentKey ? "Passphrase changed." : "Vault passphrase set.");
      onUnlocked(next);
      onChanged();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  async function reset() {
    if (!window.confirm("Delete every item in your vault and choose a new passphrase? Without the old passphrase they cannot be recovered.")) return;
    try {
      await api("/api/memory/vault", { method: "DELETE", json: { confirm: true } });
      toast.success("Vault emptied. Choose a new passphrase.");
      onChanged();
    } catch (err) {
      toast.error((err as Error).message);
    }
  }

  return (
    <Card>
      <CardTitle action={onCancel ? <button onClick={onCancel} className="text-[13px] font-medium text-ink-3 hover:underline">Cancel</button> : null}>
        {currentKey ? "Change your vault passphrase" : creating ? "Choose a vault passphrase" : "Unlock your vault"}
      </CardTitle>
      <div className="flex items-start gap-3">
        <span className="grid size-9 shrink-0 place-items-center rounded-xl bg-violet-soft">
          <KeyRound className="size-4 text-violet" />
        </span>
        <div className="min-w-0 flex-1 space-y-3">
          <p className="text-[13px] text-ink-3">
            {creating
              ? legacy
                ? "Your items were encrypted with the shared demo passphrase. Choose your own: they are re-encrypted in this browser before anything is sent."
                : "The key is derived from it in this browser. Fuku never sees it and cannot recover it."
              : "Enter your passphrase. It stays in this browser; Fuku only checks it against an encrypted value."}
          </p>
          <input type="password" value={pass} onChange={(e) => setPass(e.target.value)} placeholder="Passphrase" autoComplete={creating ? "new-password" : "current-password"} className={inputCls} />
          {creating && <input type="password" value={again} onChange={(e) => setAgain(e.target.value)} placeholder="Repeat passphrase" autoComplete="new-password" className={inputCls} />}
          {error && <p className="text-[13px] text-block">{error}</p>}
          <div className="flex flex-wrap items-center gap-2">
            <button onClick={creating ? save : unlock} disabled={busy || !pass} className="inline-flex items-center gap-2 rounded-xl bg-ink px-4 py-2.5 text-[14px] font-medium text-white hover:bg-ink-2 disabled:opacity-50">
              <Unlock className="size-4" /> {busy ? "Working…" : creating ? "Save passphrase" : "Unlock"}
            </button>
            {!creating && (
              <button onClick={reset} className="rounded-xl px-3 py-2.5 text-[13px] font-medium text-ink-3 hover:bg-surface">
                Forgot it? Start over
              </button>
            )}
          </div>
        </div>
      </div>
    </Card>
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
