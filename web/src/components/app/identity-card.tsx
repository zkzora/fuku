import { Fingerprint } from "lucide-react";
import { Mono, Pill } from "@/components/bits";
import { shortId } from "@/lib/ids";

export function IdentityCard({
  identity,
  passkeyLabel,
  compact,
}: {
  identity: { id: string; displayName: string; humanVerified: boolean; authMethod: string };
  passkeyLabel?: string;
  compact?: boolean;
}) {
  return (
    <div className="fuku-card relative overflow-hidden p-5">
      <div
        className="pointer-events-none absolute -right-16 -top-16 size-40 rounded-full"
        style={{ background: "radial-gradient(closest-side, rgba(124,92,255,.16), transparent)" }}
      />
      <div className="flex items-center justify-between">
        <div className="text-[11px] font-semibold uppercase tracking-[0.1em] text-ink-3">Fuku identity</div>
        <Pill tone={identity.humanVerified ? "allow" : "warn"} className="whitespace-nowrap" dot>
          {identity.humanVerified ? "Human verified" : "Unverified"}
        </Pill>
      </div>
      <div className="mt-5 flex items-center gap-4">
        <span className="grid size-12 place-items-center rounded-2xl bg-ink text-white">
          <Fingerprint className="size-6" />
        </span>
        <div className="min-w-0">
          <div className="truncate text-[20px] font-semibold leading-tight text-ink">{identity.displayName}</div>
          <Mono className="block truncate">
            {shortId(identity.id)} · {identity.authMethod === "passkey" ? "Passkey" : identity.authMethod === "dynamic" ? "Dynamic · email" : identity.authMethod === "demo" ? "Demo" : "Wallet"}
            {passkeyLabel ? ` · ${passkeyLabel}` : ""}
          </Mono>
        </div>
      </div>
      {!compact && (
        <p className="mt-4 text-[13px] text-ink-3">
          The root of ownership for every agent you register. Anchored on Monad; verified with WebAuthn (P-256).
        </p>
      )}
    </div>
  );
}
