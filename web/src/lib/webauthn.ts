import type { NextRequest } from "next/server";

export const RP_NAME = "Fuku Protocol";

/** Relying-party id and origin derived from the request so localhost and deployed hosts both work. */
export function rpFromRequest(req: NextRequest) {
  const origin = req.headers.get("origin") ?? new URL(req.url).origin;
  const rpID = process.env.WEBAUTHN_RP_ID ?? new URL(origin).hostname;
  return { rpID, origin };
}

export function base64url(bytes: Uint8Array): string {
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
