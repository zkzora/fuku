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

/**
 * Whether a demo request may reseed. With FUKU_DEMO_RESET_TOKEN set (a public demo deployment),
 * ?reset=1 needs &token=<that value>; without it the request is a plain sign-in, so a visitor
 * cannot wipe the demo mid-presentation.
 */
export function demoResetAllowed(token: string | null | undefined, env: Record<string, string | undefined> = process.env): boolean {
  const required = env.FUKU_DEMO_RESET_TOKEN?.trim();
  if (!required) return true;
  return token === required;
}

/** Only same-site paths: "/dashboard" yes; "//evil.com", "/\\evil.com" and absolute URLs no. */
export function safeNextPath(next: string | null | undefined, fallback = "/dashboard"): string {
  if (!next || !next.startsWith("/") || next.startsWith("//") || next.startsWith("/\\")) return fallback;
  if (/[\r\n]/.test(next)) return fallback;
  return next;
}

/** The seeded demo API key. Accepted only while the demo is enabled. */
export const DEMO_API_KEY = "fk_live_demo_ava_chen_2026";

/** The seeded demo identity (Ava Chen). It stays custodial on-chain: Fuku's relayer controls it. */
export const DEMO_IDENTITY_ID = "fuku:id:0x3e91c4d0a71f4b2c9e8d5a6f0c1b2d3e4f5ab7a4";
