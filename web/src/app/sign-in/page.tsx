"use client";

import { Suspense, useState, useSyncExternalStore } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import dynamic from "next/dynamic";
import { startAuthentication, startRegistration, browserSupportsWebAuthn } from "@simplewebauthn/browser";
import { Fingerprint, KeyRound, Play } from "lucide-react";
import { toast } from "sonner";
import { Logo } from "@/components/brand";
import { api } from "@/lib/client";

// The Dynamic SDK needs window + browser storage, so it is only loaded in the browser.
const DynamicLogin = dynamic(() => import("@/components/dynamic/dynamic-login"), {
  ssr: false,
  loading: () => <div className="h-11 animate-pulse rounded-xl bg-surface" />,
});
const DYNAMIC_ENABLED = Boolean(process.env.NEXT_PUBLIC_DYNAMIC_ENV_ID);

export default function SignInPage() {
  return (
    <Suspense>
      <SignIn />
    </Suspense>
  );
}

function SignIn() {
  const router = useRouter();
  const params = useSearchParams();
  const next = params.get("next") ?? "/dashboard";
  const [mode, setMode] = useState<"create" | "signin">("create");
  const [name, setName] = useState("");
  const [busy, setBusy] = useState<null | "create" | "signin" | "demo">(null);

  // null while server-rendering / hydrating, then the real answer — avoids a hydration mismatch.
  const supported = useSyncExternalStore(
    () => () => {},
    () => browserSupportsWebAuthn(),
    () => null,
  );

  async function create() {
    if (!name.trim()) return toast.error("Enter your name first.");
    setBusy("create");
    try {
      const { challengeId, options } = await api<{ challengeId: string; options: Parameters<typeof startRegistration>[0]["optionsJSON"] }>(
        "/api/auth/register/options",
        { method: "POST", json: { displayName: name.trim() } },
      );
      const response = await startRegistration({ optionsJSON: options });
      await api("/api/auth/register/verify", {
        method: "POST",
        json: { challengeId, displayName: name.trim(), response, deviceLabel: navigator.platform || "This device" },
      });
      toast.success("Fuku identity created. Passkey verified.");
      router.push(next);
      router.refresh();
    } catch (err) {
      toast.error(friendly(err));
    } finally {
      setBusy(null);
    }
  }

  async function signIn() {
    setBusy("signin");
    try {
      const { challengeId, options } = await api<{ challengeId: string; options: Parameters<typeof startAuthentication>[0]["optionsJSON"] }>(
        "/api/auth/login/options",
        { method: "POST", json: {} },
      );
      const response = await startAuthentication({ optionsJSON: options });
      await api("/api/auth/login/verify", { method: "POST", json: { challengeId, response } });
      router.push(next);
      router.refresh();
    } catch (err) {
      toast.error(friendly(err));
    } finally {
      setBusy(null);
    }
  }

  async function demo() {
    setBusy("demo");
    try {
      await api("/api/auth/demo", { method: "POST" });
      router.push(next);
      router.refresh();
    } catch (err) {
      toast.error(friendly(err));
    } finally {
      setBusy(null);
    }
  }

  return (
    <div className="flex min-h-screen flex-col bg-white">
      <header className="flex h-[72px] items-center px-6 md:px-10">
        <Logo />
      </header>
      <main className="flex flex-1 items-center justify-center px-5 pb-20">
        <div className="w-full max-w-[420px]">
          <div className="mb-8 text-center">
            <span className="mx-auto grid size-14 place-items-center rounded-2xl bg-violet-soft">
              <Fingerprint className="size-7 text-violet" />
            </span>
            <h1 className="mt-5 text-[28px] font-semibold leading-tight">Your Fuku identity</h1>
            <p className="mt-2 text-[15px] text-ink-3">One passkey-verified owner behind every agent you own, anchored on Monad.</p>
          </div>

          <div className="fuku-card p-2">
            <div className="grid grid-cols-2 rounded-xl bg-surface p-1 text-[13.5px] font-medium">
              {(["create", "signin"] as const).map((m) => (
                <button
                  key={m}
                  onClick={() => setMode(m)}
                  className={`rounded-lg py-2 transition ${mode === m ? "bg-white text-ink shadow-sm" : "text-ink-3"}`}
                >
                  {m === "create" ? "Create identity" : "Sign in"}
                </button>
              ))}
            </div>

            <div className="space-y-3 p-4">
              {mode === "create" ? (
                <>
                  <label className="block text-[13px] font-medium text-ink-2">
                    Your name
                    <input
                      value={name}
                      onChange={(e) => setName(e.target.value)}
                      onKeyDown={(e) => e.key === "Enter" && create()}
                      placeholder="Ava Chen"
                      className="mt-1.5 h-11 w-full rounded-xl border border-input px-3.5 text-[15px] text-ink outline-none placeholder:text-ink-3/60 focus:border-violet focus:ring-3 focus:ring-violet/20"
                    />
                  </label>
                  <button
                    onClick={create}
                    disabled={busy !== null || supported === false}
                    className="flex h-11 w-full items-center justify-center gap-2 rounded-xl bg-ink text-[15px] font-medium text-white transition hover:bg-ink-2 disabled:opacity-50"
                  >
                    <Fingerprint className="size-4" />
                    {busy === "create" ? "Waiting for your passkey…" : "Create with passkey"}
                  </button>
                </>
              ) : (
                <button
                  onClick={signIn}
                  disabled={busy !== null || supported === false}
                  className="flex h-11 w-full items-center justify-center gap-2 rounded-xl bg-ink text-[15px] font-medium text-white transition hover:bg-ink-2 disabled:opacity-50"
                >
                  <KeyRound className="size-4" />
                  {busy === "signin" ? "Waiting for your passkey…" : "Sign in with passkey"}
                </button>
              )}
              {supported === false && (
                <p className="text-center text-[12.5px] text-block">This browser does not support passkeys. Use the demo identity instead.</p>
              )}
              <div className="relative py-1 text-center text-[12px] text-ink-3">
                <span className="relative z-10 bg-white px-2">or</span>
                <span className="absolute inset-x-0 top-1/2 border-t border-line" />
              </div>
              <button
                onClick={demo}
                disabled={busy !== null}
                className="flex h-11 w-full items-center justify-center gap-2 rounded-xl bg-violet-soft text-[15px] font-medium text-violet transition hover:bg-violet/15 disabled:opacity-50"
              >
                <Play className="size-4" />
                {busy === "demo" ? "Opening demo…" : "Try the demo as Ava Chen"}
              </button>
              {DYNAMIC_ENABLED && (
                <>
                  <div className="relative py-1 text-center text-[12px] text-ink-3">
                    <span className="relative z-10 bg-white px-2">or with email and a wallet · Dynamic</span>
                    <span className="absolute inset-x-0 top-1/2 border-t border-line" />
                  </div>
                  <DynamicLogin mode="signin" next={next} />
                </>
              )}
            </div>
          </div>
          <p className="mt-6 text-center text-[12.5px] text-ink-3">
            Passkeys use WebAuthn (P-256). Fuku never sees your biometrics; only a public key is registered.
          </p>
        </div>
      </main>
    </div>
  );
}

function friendly(err: unknown): string {
  const e = err as Error & { name?: string };
  if (e?.name === "NotAllowedError") return "Passkey prompt was cancelled or timed out.";
  if (e?.name === "InvalidStateError") return "This passkey is already registered. Try signing in.";
  return e?.message || "Something went wrong.";
}
