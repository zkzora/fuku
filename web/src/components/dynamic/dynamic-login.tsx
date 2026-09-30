"use client";

import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  DynamicProvider,
  useGetWalletAccounts,
  useInitStatus,
  useLogout,
  useOnEvent,
  useSendEmailOTP,
  useUser,
  useVerifyOTP,
} from "@dynamic-labs-sdk/react-hooks";
import { refreshUser } from "@dynamic-labs-sdk/client";
import { createWaasWalletAccounts, getChainsMissingWaasWalletAccounts } from "@dynamic-labs-sdk/client/waas";
import { Loader2, Mail, Wallet } from "lucide-react";
import { toast } from "sonner";
import { api, ApiError } from "@/lib/client";
import { dynamicClient } from "./dynamic-client";

const queryClient = new QueryClient();

export type DynamicLoginMode = "signin" | "link";

/**
 * Email OTP sign-in through Dynamic with an embedded EVM wallet. Once Dynamic has a user and a
 * wallet, the Dynamic JWT is exchanged for a Fuku session (`signin`) or the wallet is linked to
 * the signed-in Fuku identity (`link`). The server verifies the JWT against Dynamic's JWKS.
 */
export default function DynamicLogin(props: { mode: DynamicLoginMode; next?: string; onLinked?: () => void }) {
  return (
    <QueryClientProvider client={queryClient}>
      <DynamicProvider client={dynamicClient}>
        <WaasBootstrap />
        <LoginFlow {...props} />
      </DynamicProvider>
    </QueryClientProvider>
  );
}

/** Embedded wallets are not created automatically by the JS SDK: create them on userChanged. */
function WaasBootstrap() {
  useOnEvent({
    event: "userChanged",
    listener: async ({ user }) => {
      if (!user) return;
      try {
        const missing = getChainsMissingWaasWalletAccounts();
        if (missing.length === 0) return;
        await createWaasWalletAccounts({ chains: missing });
      } catch (e) {
        console.warn("[dynamic] embedded wallet creation failed:", (e as Error).message);
      }
    },
  });
  return null;
}

const inputCls =
  "h-11 w-full rounded-xl border border-input bg-white px-3.5 text-[15px] text-ink outline-none placeholder:text-ink-3/60 focus:border-violet focus:ring-3 focus:ring-violet/20";
const primaryBtn =
  "flex h-11 w-full items-center justify-center gap-2 rounded-xl bg-ink text-[15px] font-medium text-white transition hover:bg-ink-2 disabled:opacity-50";

function LoginFlow({ mode, next = "/dashboard", onLinked }: { mode: DynamicLoginMode; next?: string; onLinked?: () => void }) {
  const router = useRouter();
  const { data: initStatus } = useInitStatus();
  const { data: user } = useUser();
  const { data: accounts = [] } = useGetWalletAccounts();
  const { mutate: sendEmailOTP, data: otpVerification, isPending: sending, reset: resetOtp } = useSendEmailOTP();
  const { mutate: verifyOTP, isPending: verifying } = useVerifyOTP();
  const { mutate: logout } = useLogout();

  const [email, setEmail] = useState("");
  const [code, setCode] = useState("");
  const [status, setStatus] = useState<"idle" | "exchanging" | "done">("idle");
  const [problem, setProblem] = useState<string | null>(null);
  const attempts = useRef(0);

  const address = accounts[0]?.address ?? null;

  // Once Dynamic has a user with a wallet, exchange the Dynamic JWT for a Fuku session.
  useEffect(() => {
    if (!user || !address || status !== "idle") return;
    let cancelled = false;
    const exchange = async () => {
      setStatus("exchanging");
      setProblem(null);
      try {
        for (;;) {
          const token = dynamicClient.token;
          if (!token) throw new Error("Dynamic did not issue a session token.");
          try {
            await api("/api/auth/dynamic", { method: "POST", json: { token, link: mode === "link" } });
            break;
          } catch (e) {
            // The wallet can land on the user a moment after the first JWT; refresh and retry.
            if (e instanceof ApiError && e.status === 409 && (e.body as { code?: string })?.code === "wallet_pending" && attempts.current < 4) {
              attempts.current += 1;
              await refreshUser();
              await new Promise((r) => setTimeout(r, 800));
              continue;
            }
            throw e;
          }
        }
        if (cancelled) return;
        setStatus("done");
        if (mode === "link") {
          toast.success("Wallet linked to your Fuku identity.");
          onLinked?.();
        } else {
          toast.success("Signed in with Dynamic.");
          router.push(next);
          router.refresh();
        }
      } catch (e) {
        if (cancelled) return;
        setStatus("idle");
        setProblem((e as Error).message);
      }
    };
    void exchange();
    return () => {
      cancelled = true;
    };
    // `status` is intentionally not a dependency: the effect runs once per user+wallet.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [user, address]);

  if (initStatus === "failed") {
    return (
      <p className="rounded-xl bg-block-soft px-3.5 py-3 text-[13px] text-block">
        Dynamic could not start. Check that {typeof window !== "undefined" ? window.location.origin : "this origin"} is in
        the Allowed Origins of your Dynamic environment (Security settings).
      </p>
    );
  }
  if (initStatus !== "finished") {
    return (
      <div className="flex h-11 items-center justify-center gap-2 text-[13.5px] text-ink-3">
        <Loader2 className="size-4 animate-spin" /> Connecting to Dynamic…
      </div>
    );
  }

  if (user) {
    return (
      <div className="space-y-2">
        <div className="flex items-center gap-2 rounded-xl bg-surface px-3.5 py-3 text-[13.5px] text-ink-2">
          {address ? <Wallet className="size-4 text-violet" /> : <Loader2 className="size-4 animate-spin text-violet" />}
          <div className="min-w-0">
            <div className="truncate font-medium text-ink">{user.email ?? "Dynamic user"}</div>
            <div className="mono truncate text-[12px] text-ink-3">
              {address ? address : "Creating your embedded wallet…"}
            </div>
          </div>
        </div>
        {status === "exchanging" && (
          <p className="flex items-center gap-2 text-[12.5px] text-ink-3">
            <Loader2 className="size-3.5 animate-spin" /> {mode === "link" ? "Linking wallet…" : "Opening your Fuku identity…"}
          </p>
        )}
        {problem && (
          <div className="space-y-2">
            <p className="text-[12.5px] text-block">{problem}</p>
            <button
              onClick={() => {
                attempts.current = 0;
                setStatus("idle");
                setProblem(null);
              }}
              className="text-[12.5px] font-medium text-violet hover:underline"
            >
              Try again
            </button>
          </div>
        )}
        <button
          onClick={() => {
            logout();
            resetOtp();
            setCode("");
            setStatus("idle");
          }}
          className="text-[12.5px] font-medium text-ink-3 hover:text-ink"
        >
          Use a different email
        </button>
      </div>
    );
  }

  if (!otpVerification) {
    return (
      <form
        className="space-y-2"
        onSubmit={(e) => {
          e.preventDefault();
          if (!email.trim()) return;
          sendEmailOTP({ email: email.trim() }, { onError: (err) => toast.error(err.message) });
        }}
      >
        <input type="email" value={email} onChange={(e) => setEmail(e.target.value)} placeholder="you@example.com" className={inputCls} />
        <button type="submit" disabled={sending || !email.trim()} className={primaryBtn}>
          {sending ? <Loader2 className="size-4 animate-spin" /> : <Mail className="size-4" />}
          {sending ? "Sending code…" : mode === "link" ? "Email me a code to link a wallet" : "Continue with email"}
        </button>
      </form>
    );
  }

  return (
    <form
      className="space-y-2"
      onSubmit={(e) => {
        e.preventDefault();
        verifyOTP({ otpVerification, verificationToken: code.trim() }, { onError: (err) => toast.error(err.message) });
      }}
    >
      <p className="text-[12.5px] text-ink-3">We sent a 6-digit code to {email}.</p>
      <input
        inputMode="numeric"
        autoComplete="one-time-code"
        value={code}
        onChange={(e) => setCode(e.target.value)}
        placeholder="123456"
        className={`${inputCls} mono tracking-[0.3em]`}
      />
      <button type="submit" disabled={verifying || code.trim().length < 4} className={primaryBtn}>
        {verifying ? <Loader2 className="size-4 animate-spin" /> : null}
        {verifying ? "Verifying…" : "Verify code"}
      </button>
      <button type="button" onClick={() => resetOtp()} className="text-[12.5px] font-medium text-ink-3 hover:text-ink">
        Change email
      </button>
    </form>
  );
}
