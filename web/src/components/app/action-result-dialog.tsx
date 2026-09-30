"use client";

import { motion } from "framer-motion";
import { Check, ShieldAlert, ShieldCheck, X } from "lucide-react";
import { Dialog, DialogContent, DialogTitle } from "@/components/ui/dialog";
import { Mono, Pill } from "@/components/bits";
import { labelFor } from "@/lib/engine/policy";
import type { ActionResult, ComplianceView } from "@/lib/services/actions";
import { shortHex } from "@/lib/ids";
import { cn } from "@/lib/utils";

export function ActionResultDialog({
  result,
  onClose,
}: {
  result: ActionResult | null;
  onClose: () => void;
}) {
  const blocked = result?.decision === "BLOCKED";
  return (
    <Dialog open={Boolean(result)} onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="max-w-[640px] gap-0 overflow-hidden p-0 sm:max-w-[640px]" showCloseButton={false}>
        {result && (
          <>
            <div className={cn("px-7 pb-6 pt-7", blocked ? "bg-block-soft" : "bg-allow-soft")}>
              <div className="flex items-start justify-between gap-4">
                <div className="flex items-center gap-3">
                  <motion.span
                    initial={{ scale: 0.6, opacity: 0 }}
                    animate={{ scale: 1, opacity: 1 }}
                    transition={{ type: "spring", stiffness: 260, damping: 18 }}
                    className={cn("grid size-11 place-items-center rounded-2xl text-white", blocked ? "bg-block" : "bg-allow")}
                  >
                    {blocked ? <ShieldAlert className="size-5" /> : <ShieldCheck className="size-5" />}
                  </motion.span>
                  <div>
                    <DialogTitle className={cn("text-[22px] font-semibold leading-tight", blocked ? "text-block" : "text-allow")}>
                      {blocked ? "Action blocked by Fuku" : "Action allowed"}
                    </DialogTitle>
                    <p className="mt-0.5 text-[13.5px] text-ink-2">
                      {result.agentName} · {labelFor(result.action)}
                      {result.amountUsdc ? ` · ${result.amountUsdc.toLocaleString("en-US")} ${result.asset ?? "USDC"}` : ""}
                      {result.to ? ` · to ${shortHex(result.to, 6, 4)}` : ""}
                      {result.app && !result.to ? ` · ${result.app}` : ""}
                    </p>
                  </div>
                </div>
                <button onClick={onClose} className="rounded-lg p-1.5 text-ink-3 hover:bg-white/60 hover:text-ink" aria-label="Close">
                  <X className="size-4" />
                </button>
              </div>
              <p className="mt-5 text-pretty text-[15px] leading-[1.55] text-ink">{result.explanation}</p>
              <div className="mt-3 flex flex-wrap items-center gap-2">
                <Pill tone={blocked ? "block" : "allow"}>
                  Rule {result.ruleId}
                  {result.subCode ? ` · ${result.subCode}` : ""}
                </Pill>
                {result.compliance?.mode === "simulated" && (
                  <Pill tone="warn" className="normal-case tracking-normal">Cleanverse simulator</Pill>
                )}
                <Pill tone="neutral" className="normal-case tracking-normal">Explained by {result.explanationProvider}</Pill>
                <Pill tone="violet" className="normal-case tracking-normal">
                  Trust {result.scoreBefore} → {result.scoreAfter} ({result.trustDelta >= 0 ? "+" : ""}
                  {result.trustDelta})
                </Pill>
              </div>
            </div>

            <div className="grid gap-6 px-7 py-6 md:grid-cols-[1.2fr_1fr]">
              <div>
                <div className="mb-3 text-[11px] font-semibold uppercase tracking-[0.1em] text-ink-3">Workflow trace</div>
                <ol className="space-y-2.5">
                  {result.workflow.map((s, i) => (
                    <motion.li
                      key={s.step}
                      initial={{ opacity: 0, x: -6 }}
                      animate={{ opacity: 1, x: 0 }}
                      transition={{ delay: 0.08 * i }}
                      className="flex items-start gap-3"
                    >
                      <span
                        className={cn(
                          "mt-0.5 grid size-5 shrink-0 place-items-center rounded-full",
                          s.status === "ok" ? "bg-allow-soft text-allow" : s.status === "blocked" ? "bg-block-soft text-block" : "bg-surface text-ink-3",
                        )}
                      >
                        {s.status === "blocked" ? <X className="size-3" /> : <Check className="size-3" />}
                      </span>
                      <div className="min-w-0">
                        <div className="text-[13.5px] font-medium text-ink">{s.step}</div>
                        <div className="text-[12.5px] text-ink-3">{s.detail}</div>
                      </div>
                      <span className="ml-auto shrink-0 pt-0.5 text-[11px] text-ink-3">{s.ms} ms</span>
                    </motion.li>
                  ))}
                </ol>
              </div>
              <div className="space-y-3 rounded-xl bg-surface p-4">
                <div className="text-[11px] font-semibold uppercase tracking-[0.1em] text-ink-3">Proof</div>
                <div>
                  <div className="text-[12px] text-ink-3">Decision hash</div>
                  <Mono className="break-all text-ink">{result.proofHash}</Mono>
                </div>
                <div>
                  <div className="text-[12px] text-ink-3">Execution</div>
                  <Pill tone={STATUS_TONE[result.status]} className="normal-case tracking-normal">
                    {STATUS_LABEL[result.status]}
                  </Pill>
                </div>
                <div>
                  <div className="text-[12px] text-ink-3">
                    Monad{" "}
                    {result.receipt.status === "confirmed"
                      ? "transaction"
                      : result.receipt.status === "simulated"
                        ? "receipt (mock, no transaction)"
                        : result.receipt.status === "pending"
                          ? "transaction (pending)"
                          : "anchor (failed, will retry)"}
                  </div>
                  {result.receipt.txHash ? (
                    <TxLink hash={result.receipt.txHash} url={result.receipt.explorerUrl} />
                  ) : (
                    <div className="text-[12.5px] text-block">not anchored</div>
                  )}
                  {result.receipt.block !== null && <div className="text-[12px] text-ink-3">block {result.receipt.block.toLocaleString("en-US")}</div>}
                </div>
                {result.transfer && (
                  <div>
                    <div className="text-[12px] text-ink-3">
                      {result.transfer.mode === "mock" ? "Guarded transfer (mock, nothing moved)" : "Token moved via FukuSpendGuard"}
                    </div>
                    {result.transfer.txHash && <TxLink hash={result.transfer.txHash} url={result.transfer.explorerUrl} />}
                    <div className="text-[12px] text-ink-3">
                      {result.transfer.mode === "live"
                        ? result.transfer.status === "confirmed"
                          ? `same transaction records the decision (R6)${result.transfer.logIndex !== null ? ` · log #${result.transfer.logIndex}` : ""}`
                          : result.transfer.status === "pending"
                            ? "broadcast; the receipt is pending"
                            : "mined but reverted; nothing moved"
                        : "mock: no token moved"}
                    </div>
                  </div>
                )}
                {result.receipt.note && <p className="text-[11.5px] leading-snug text-ink-3">{result.receipt.note}</p>}
              </div>
            </div>
            {result.compliance && <ComplianceLegs compliance={result.compliance} />}
          </>
        )}
      </DialogContent>
    </Dialog>
  );
}

const STATUS_LABEL: Record<ActionResult["status"], string> = {
  DENIED: "Denied: nothing executed",
  AUTHORIZED: "Authorized (decision recorded; not executed by Fuku)",
  SUBMITTED: "Submitted on-chain",
  PENDING: "Pending on-chain",
  CONFIRMED: "Executed and confirmed on-chain",
  FAILED: "Failed: nothing moved",
  SIMULATED: "Simulated (mock chain, nothing moved)",
};
const STATUS_TONE: Record<ActionResult["status"], "allow" | "block" | "warn" | "neutral" | "violet"> = {
  DENIED: "block",
  AUTHORIZED: "neutral",
  SUBMITTED: "warn",
  PENDING: "warn",
  CONFIRMED: "allow",
  FAILED: "block",
  SIMULATED: "warn",
};

function TxLink({ hash, url }: { hash: string; url: string | null }) {
  return url ? (
    <a href={url} target="_blank" rel="noreferrer" className="mono block text-[12.5px] text-violet hover:underline">
      {shortHex(hash, 10, 6)}
    </a>
  ) : (
    <Mono className="block text-[12.5px] text-ink-2">{shortHex(hash, 10, 6)}</Mono>
  );
}

const LEGS: { key: "asset" | "owner" | "counterparty"; label: string; rule: string }[] = [
  { key: "asset", label: "CVA: asset rule", rule: "R9" },
  { key: "owner", label: "CVI: owner A-Pass", rule: "R7" },
  { key: "counterparty", label: "CVI: recipient A-Pass", rule: "R8" },
];

/** Pass / fail for each Cleanverse leg, with the evidence behind the complianceRef on request. */
function ComplianceLegs({ compliance }: { compliance: ComplianceView }) {
  return (
    <div className="border-t border-line px-7 py-5">
      <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
        <div className="text-[11px] font-semibold uppercase tracking-[0.1em] text-ink-3">
          Cleanverse checks {compliance.mode === "simulated" ? "· simulator, not issued by Cleanverse" : compliance.mode === "off" ? "· off" : "· live"}
        </div>
        <Mono className="text-[11px]">ref {shortHex(compliance.complianceRef, 8, 6)}</Mono>
      </div>
      <div className="grid gap-2 md:grid-cols-3">
        {LEGS.map((l) => {
          const leg = compliance[l.key];
          const skipped = !leg.ok && leg.detail.startsWith("not evaluated");
          return (
            <div key={l.key} className={cn("rounded-xl p-3", leg.ok ? "bg-allow-soft" : skipped ? "bg-surface" : "bg-block-soft")}>
              <div className="flex items-center gap-1.5 text-[12.5px] font-semibold text-ink">
                {leg.ok ? <Check className="size-3.5 text-allow" /> : <X className={cn("size-3.5", skipped ? "text-ink-3" : "text-block")} />}
                {l.label}
              </div>
              <div className="mt-1 text-[11.5px] leading-snug text-ink-3">
                {leg.ok ? leg.detail : `${l.rule} ${leg.subCode}${leg.detail ? `: ${leg.detail}` : ""}`}
              </div>
            </div>
          );
        })}
      </div>
      <details className="mt-3 text-[12px] text-ink-3">
        <summary className="cursor-pointer select-none font-medium text-ink-2">Evidence (hashed into the complianceRef)</summary>
        <pre className="mt-2 max-h-56 overflow-auto rounded-lg bg-surface p-3 text-[11px] leading-snug text-ink-2">
          {JSON.stringify(compliance.evidence, null, 2)}
        </pre>
      </details>
    </div>
  );
}
