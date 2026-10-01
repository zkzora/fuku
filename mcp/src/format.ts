/** Short, plain-language summaries of Fuku results for the model (and the user reading along). */
import type { ActionReceipt, ActionResult, Mandate, MandatePayee, PermissionCheck, ScoreVerification, Verification } from "@fuku/sdk";

export const short = (s: string) => (s.length > 14 ? `${s.slice(0, 8)}…${s.slice(-4)}` : s);
const usd = (n: number) => `${Number.isInteger(n) ? n : n.toFixed(2)} USDC`;

/** Explorer link for a hash on Monad testnet; other chains have no public explorer Fuku knows. */
export function txLink(chainId: number | null | undefined, hash: string | null | undefined): string | null {
  if (!hash) return null;
  return chainId === 10143 ? `https://testnet.monadvision.com/tx/${hash}` : null;
}

export function passportLines(p: NonNullable<Verification["passport"]>): string[] {
  const allowed = p.allowed.map((r) => (r.limitUsdcPerDay !== undefined ? `${r.action} (up to ${usd(r.limitUsdcPerDay)} a day)` : r.action));
  return [
    `Passport v${p.version} (${p.active ? "active" : "revoked"}):`,
    `  allowed: ${allowed.join(", ") || "nothing"}`,
    `  blocked: ${p.blocked.join(", ") || "nothing"}`,
    `  apps: ${p.scopeApps.length ? p.scopeApps.join(", ") : "any app"}`,
    ...(p.assets?.length ? [`  assets: ${p.assets.join(", ")} (Cleanverse A-Tokens: transfers are checked and moved by FukuSpendGuard)`] : []),
  ];
}

export function mandateLines(m: { mandate: Mandate | null; reason: string | null; payees?: MandatePayee[] | null; payeesSource?: string | null }): string[] {
  if (!m.mandate) {
    const why: Record<string, string> = {
      "mock-chain": "the Fuku app runs a mocked chain, so there is no on-chain mandate",
      "guard-not-configured": "FukuSpendGuard is not configured on this Fuku deployment",
      "no-verified-wallet": "the owner has no verified wallet to open a mandate from",
    };
    return [`Mandate: none (${why[m.reason ?? ""] ?? m.reason ?? "unknown"}).`];
  }
  const d = m.mandate;
  if (!d.active) return ["Mandate: not open. The owner's wallet has to open one before any A-Token transfer can move."];
  const payees = m.payees?.length
    ? m.payees.map((p) => (p.label ? `${p.label} (${p.address})` : p.address)).join(", ")
    : d.restrictPayees
      ? "none approved yet"
      : "any recipient";
  return [
    "Mandate (on-chain, opened by the owner's wallet, enforced by FukuSpendGuard):",
    `  daily cap ${usd(d.dailyCapUsdc)}, ${d.maxPerTxUsdc !== null ? `at most ${usd(d.maxPerTxUsdc)} per transfer` : "no per-transfer limit"}, spent today ${usd(d.spentTodayUsdc)}`,
    `  payees: ${d.restrictPayees ? "only approved payees" : "unrestricted"}${m.payees ? ` (${payees}${m.payeesSource === "known-addresses" ? "; only addresses Fuku knows were checked" : ""})` : ""}`,
    ...(d.validUntil ? [`  valid until ${new Date(d.validUntil * 1000).toISOString()}`] : []),
  ];
}

export function checkText(c: PermissionCheck): string {
  const head = `${c.decision} by rule ${c.ruleId}${c.subCode ? ` (${c.subCode})` : ""}: ${c.reason}`;
  const limit = c.remainingUsdc !== undefined ? `Daily limit: ${usd(c.remainingUsdc)} left of ${c.limitUsdcPerDay !== undefined ? usd(c.limitUsdcPerDay) : "the limit"}.` : null;
  const legs = c.compliance
    ? `Cleanverse (${c.compliance.mode}): asset ${c.compliance.asset.ok ? "ok" : c.compliance.asset.subCode}, owner A-Pass ${c.compliance.owner.ok ? "ok" : c.compliance.owner.subCode}, recipient A-Pass ${c.compliance.counterparty.ok ? "ok" : c.compliance.counterparty.subCode}.`
    : null;
  const tail = c.allowed
    ? "Preview only: nothing was recorded, reserved or signed. Execute it with fuku_execute_action using the same parameters."
    : "Preview only: nothing was recorded. This request would be blocked; tell the user the rule and the reason. Do not adjust the parameters to get around it.";
  return [head, limit, legs, tail].filter(Boolean).join("\n");
}

export function executeText(r: ActionResult): string {
  const lines = [`${r.decision} by rule ${r.ruleId}${r.subCode ? ` (${r.subCode})` : ""}: ${r.reason}`, `Status: ${r.status}.`];
  if (r.replayed) lines.push("This is the stored result of an earlier request with the same idempotency key; nothing executed again.");
  if (r.transfer) {
    const link = r.transfer.explorerUrl ?? r.transfer.txHash;
    lines.push(
      r.transfer.status === "confirmed"
        ? `Token moved through FukuSpendGuard: ${link}${r.transfer.block !== null ? ` (block ${r.transfer.block})` : ""}.`
        : r.transfer.status === "pending"
          ? `The transfer was broadcast but is not confirmed yet (${link}). Check it with fuku_get_action ${r.id}.`
          : `Token transfer: ${r.transfer.status}${link ? ` (${link})` : ""}.`,
    );
  }
  if (r.compliance) {
    const c = r.compliance;
    lines.push(`Cleanverse (${c.mode}): asset ${c.asset.ok ? "ok" : c.asset.subCode}, owner A-Pass ${c.owner.ok ? "ok" : c.owner.subCode}, recipient A-Pass ${c.counterparty.ok ? "ok" : c.counterparty.subCode}.`);
  }
  const anchor = r.receipt.explorerUrl ?? r.receipt.txHash;
  lines.push(
    `Proof hash ${r.proofHash}${anchor ? `, anchored on Monad: ${anchor}` : r.receipt.mode === "mock" ? " (mock settlement: not on a chain)" : ` (anchor ${r.receipt.status})`}.`,
  );
  lines.push(`Trust score ${r.scoreBefore} → ${r.scoreAfter}${r.trustDelta ? ` (${r.trustDelta > 0 ? "+" : ""}${r.trustDelta})` : ""}.`);
  if (r.explanation) lines.push(`Explanation: ${r.explanation}`);
  lines.push(`Action ${r.id}${r.idempotencyKey ? `, idempotency key ${r.idempotencyKey}` : ""}.`);
  if (r.decision === "BLOCKED") lines.push("This is final for this request: report the rule and the reason to the user. Do not retry with changed parameters to get around it.");
  return lines.join("\n");
}

export function actionText(a: ActionReceipt): string {
  const anchor = txLink(a.receipt.chainId, a.receipt.txHash) ?? a.receipt.txHash;
  const moved = txLink(a.receipt.chainId, a.receipt.transferTxHash) ?? a.receipt.transferTxHash;
  return [
    `${a.agentName}: ${a.action}${a.amountUsdc !== null ? ` ${a.amountUsdc}${a.asset ? ` ${a.asset}` : " USDC"}` : ""}${a.to ? ` to ${a.to}` : ""}.`,
    `${a.decision} by rule ${a.ruleId ?? "?"}: ${a.reason}`,
    `Status: ${a.status}${a.settledAt ? ` (settled ${a.settledAt})` : ""}.`,
    ...(moved ? [`Guarded transfer: ${moved}${a.receipt.blockNumber !== null ? ` (block ${a.receipt.blockNumber}, log ${a.receipt.logIndex})` : ""}.`] : []),
    `Proof hash ${a.proofHash}; anchor ${a.receipt.anchorStatus ?? a.receipt.mode}${anchor ? `: ${anchor}` : ""}.`,
    ...(a.error ? [`Error: ${a.error.class}${a.error.detail ? `: ${a.error.detail}` : ""}.`] : []),
  ].join("\n");
}

export function verifyText(v: Verification): string {
  const c = v.checks;
  const lines = [`${v.verified ? "✓ Verified" : "✗ Not verified"}: ${v.agent?.name ?? "agent"} (${v.agent?.id ?? "?"}), trust score ${v.trust?.score ?? "?"} (${v.trust?.level ?? "?"}).`];
  if (v.owner) {
    lines.push(
      `Owner ${v.owner.displayName}: ${v.owner.humanVerified ? "passkey-verified (not a proof of unique personhood)" : "not passkey-verified"}${v.owner.custody ? `, ${v.owner.custody === "owner" ? "controls its identity on-chain with its own wallet" : "custodial (Fuku's relayer controls the identity on-chain)"}` : ""}.`,
    );
  }
  if (c) {
    lines.push(`Wallet: ${c.owner.wallet.status ?? (c.owner.wallet.ok ? "ok" : "no")}. Passport: ${c.policy.ok ? "active" : "none"}. Anchoring: ${c.anchoring.status}. Can act now: ${c.executable.ok ? "yes" : "no"}${c.executable.ok ? `, value actions ${c.executable.valueActions ? "yes" : "no"}` : ""}.`);
  }
  if (v.agent?.erc8004) lines.push(`ERC-8004: agent #${v.agent.erc8004.agentId} on ${v.agent.erc8004.registry ?? "the canonical registry"} (chain ${v.agent.erc8004.chainId ?? "?"}).`);
  if (v.agent?.agentKey) lines.push(`Agent key: ${v.agent.agentKey.address} (${v.agent.agentKey.source === "external" ? "held by the agent's developer, not by Fuku" : "held by Fuku"}).`);
  return lines.join("\n");
}

export function scoreText(s: ScoreVerification): string {
  const r = s.records;
  return [
    `${s.verified ? "✓ Verified from the chain" : "✗ Not verified from the chain"}: score from chain ${s.chainScore}, anchored ${s.anchored?.score ?? "none"}, ledger ${s.ledgerScore}.`,
    `Records: ${r.verified}/${r.revealed} match their on-chain proofs; ${r.mismatched.length} mismatched, ${r.unanchored.length} not anchored, ${r.unrevealed.length} on-chain decisions without a record.`,
    `Events via ${s.events.source}: ${s.events.decisions} decisions, ${s.events.executions} transfers${s.events.complete ? "" : " (incomplete scan)"}.`,
    ...(s.notCommitted.length ? [`Not committed on-chain: ${s.notCommitted.join("; ")}`] : []),
  ].join("\n");
}
