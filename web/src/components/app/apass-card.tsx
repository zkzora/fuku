"use client";

import { useState } from "react";
import { BadgeCheck, RefreshCw } from "lucide-react";
import { toast } from "sonner";
import { Card, CardTitle, Mono, Pill } from "@/components/bits";
import { api } from "@/lib/client";
import { fmtDate } from "@/lib/format";
import { shortHex } from "@/lib/ids";
import type { APassView } from "@/lib/services/cleanverse";

/**
 * The owner's Cleanverse A-Pass (CVI), as last read from the provider and persisted. The source
 * badge says who answered: Cleanverse itself, or Fuku's simulator. Fuku never collects KYC data;
 * the pass is issued in the Cleanverse app and only read here.
 */
export function APassCard({ apass, onChanged, onLinkWallet }: { apass: APassView; onChanged: () => void; onLinkWallet?: () => void }) {
  const [busy, setBusy] = useState(false);
  const sim = apass.source === "simulated";

  async function refresh() {
    setBusy(true);
    try {
      await api("/api/identity/apass", { method: "POST" });
      toast.success(sim ? "Re-read from the Cleanverse simulator." : "Re-read from Cleanverse.");
      onChanged();
    } catch (err) {
      toast.error((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  const p = apass.pass;
  const expired = Boolean(p?.expired);
  const state = !p ? null : p.status === 2 ? "frozen" : expired ? "expired" : p.status === 1 ? "active" : `status ${p.status}`;

  return (
    <Card>
      <CardTitle
        action={
          apass.mode !== "off" && apass.wallet ? (
            <button
              onClick={refresh}
              disabled={busy}
              className="inline-flex items-center gap-1.5 rounded-lg px-2.5 py-1.5 text-[13px] font-medium text-violet hover:bg-violet-soft disabled:opacity-50"
            >
              <RefreshCw className={busy ? "size-3.5 animate-spin" : "size-3.5"} /> Refresh
            </button>
          ) : null
        }
      >
        Cleanverse A-Pass
      </CardTitle>

      <div className="mb-3 flex flex-wrap items-center gap-2">
        {apass.mode === "off" ? (
          <Pill tone="neutral">Cleanverse off</Pill>
        ) : sim ? (
          <Pill tone="warn" className="normal-case tracking-normal">Cleanverse simulator</Pill>
        ) : (
          <Pill tone="violet" className="normal-case tracking-normal">Read from Cleanverse</Pill>
        )}
        {state && <Pill tone={state === "active" ? "allow" : "block"} dot>{state}</Pill>}
      </div>

      {!apass.wallet ? (
        <div className="text-[13.5px] text-ink-3">
          An A-Pass is bound to a wallet. Link one first.
          {onLinkWallet && (
            <button onClick={onLinkWallet} className="ml-1 font-medium text-violet hover:underline">
              Link a wallet
            </button>
          )}
        </div>
      ) : apass.mode === "off" ? (
        <p className="text-[13.5px] text-ink-3">Cleanverse is switched off, so A-Token transfers are blocked (R7 PROVIDER_OFF).</p>
      ) : !p ? (
        <p className="text-[13.5px] text-ink-3">
          {apass.checkedAt
            ? sim
              ? "No A-Pass was issued to this wallet in the simulator."
              : "Cleanverse reports no A-Pass for this wallet. Get one in the Cleanverse app, then refresh."
            : "Not checked yet. Refresh to read it."}
        </p>
      ) : (
        <div className="flex items-start gap-3">
          <span className="grid size-9 shrink-0 place-items-center rounded-xl bg-violet-soft">
            <BadgeCheck className="size-4 text-violet" />
          </span>
          <div className="min-w-0 flex-1 space-y-1 text-[13px]">
            <div className="text-[14px] font-medium text-ink">
              Tier {p.tier ?? "?"}.{p.subTier ?? 0}
              {p.group ? ` · ${p.group}${p.subGroup ? ` / ${p.subGroup}` : ""}` : ""}
            </div>
            <div className="text-ink-3">
              Record <Mono>{p.cvRecordId && p.cvRecordId.length > 24 ? shortHex(p.cvRecordId, 10, 6) : p.cvRecordId}</Mono>
              {p.expiresAt ? ` · ${expired ? "expired" : "valid to"} ${fmtDate(new Date(p.expiresAt * 1000).toISOString())}` : " · no expiry"}
            </div>
            <div className="text-ink-3">
              Wallet <Mono className="break-all">{apass.wallet}</Mono>
            </div>
          </div>
        </div>
      )}
      {apass.checkedAt && <div className="mt-3 text-[11.5px] text-ink-3">Last read {fmtDate(apass.checkedAt)}</div>}
    </Card>
  );
}
