/**
 * The seeded demo (Ava Chen, her demo API key, the one-click sign-in and ?reset=1) is on in
 * development and off in production unless an isolated demo deployment opts in with
 * FUKU_DEMO_ENABLED=true. A production instance serving real users must leave it off: anyone
 * could otherwise sign in as Ava or reset her data.
 */
export function demoEnabled(env: Record<string, string | undefined> = process.env): boolean {
  if (env.FUKU_DEMO_ENABLED === "true") return true;
  if (env.FUKU_DEMO_ENABLED === "false") return false;
  return env.NODE_ENV !== "production";
}

/** Only same-site paths: "/dashboard" yes; "//evil.com", "/\\evil.com" and absolute URLs no. */
export function safeNextPath(next: string | null | undefined, fallback = "/dashboard"): string {
  if (!next || !next.startsWith("/") || next.startsWith("//") || next.startsWith("/\\")) return fallback;
  if (/[\r\n]/.test(next)) return fallback;
  return next;
}

/** The seeded demo API key. Accepted only while the demo is enabled. */
export const DEMO_API_KEY = "fk_live_demo_ava_chen_2026";
