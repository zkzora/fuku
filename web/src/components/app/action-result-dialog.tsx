"use client";

import { motion } from "framer-motion";
import { Check, ShieldAlert, ShieldCheck, X } from "lucide-react";
import { Dialog, DialogContent, DialogTitle } from "@/components/ui/dialog";
import { Mono, Pill } from "@/components/bits";
import { labelFor } from "@/lib/engine/policy";
import type { ActionResult } from "@/lib/services/actions";
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
                      {result.amountUsdc ? ` · ${result.amountUsdc.toLocaleString("en-US")} USDC` : ""}
                      {result.app ? ` · ${result.app}` : ""}
                    </p>
                  </div>
                </div>
                <button onClick={onClose} className="rounded-lg p-1.5 text-ink-3 hover:bg-white/60 hover:text-ink" aria-label="Close">
                  <X className="size-4" />
                </button>
              </div>
              <p className="mt-5 text-pretty text-[15px] leading-[1.55] text-ink">{result.explanation}</p>
              <div className="mt-3 flex flex-wrap items-center gap-2">
                <Pill tone={blocked ? "block" : "allow"}>Rule {result.ruleId}</Pill>
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
                  <div className="text-[12px] text-ink-3">Monad {result.receipt.mode === "live" ? "transaction" : "receipt (mock)"}</div>
                  <a href={result.receipt.explorerUrl} target="_blank" rel="noreferrer" className="mono text-[12.5px] text-violet hover:underline">
                    {shortHex(result.receipt.txHash, 10, 6)}
                  </a>
                  <div className="text-[12px] text-ink-3">block {result.receipt.block.toLocaleString("en-US")}</div>
                </div>
                {result.receipt.note && <p className="text-[11.5px] leading-snug text-ink-3">{result.receipt.note}</p>}
              </div>
            </div>
          </>
        )}
      </DialogContent>
    </Dialog>
  );
}
