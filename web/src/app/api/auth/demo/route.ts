import { NextResponse } from "next/server";
import { db } from "@/lib/db";
import { json, withErrors } from "@/lib/api";
import { createSession } from "@/lib/session";
import { DEMO_IDENTITY_ID, seedDemo } from "@/lib/demo-seed";

async function signInDemo(reset: boolean) {
  const existing = await db.identity.findUnique({ where: { id: DEMO_IDENTITY_ID } });
  if (!existing || reset) await seedDemo(db);
  await createSession(DEMO_IDENTITY_ID);
  return { identity: await db.identity.findUniqueOrThrow({ where: { id: DEMO_IDENTITY_ID } }), reseeded: !existing || reset };
}

/** Signs in as the seeded demo identity (Ava Chen); re-seeds it when missing or when ?reset=1. */
export const POST = withErrors(async (req) => {
  const reset = new URL(req.url).searchParams.get("reset") === "1";
  return json(await signInDemo(reset));
});

/** GET /api/auth/demo?next=/dashboard — one-link demo entry: sign in and redirect. */
export const GET = withErrors(async (req) => {
  const url = new URL(req.url);
  const reset = url.searchParams.get("reset") === "1";
  const next = url.searchParams.get("next") ?? "/dashboard";
  await signInDemo(reset);
  return NextResponse.redirect(new URL(next.startsWith("/") ? next : "/dashboard", url.origin));
});
