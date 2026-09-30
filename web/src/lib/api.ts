import { NextResponse, type NextRequest } from "next/server";
import { ZodError } from "zod";
import type { Identity } from "@prisma/client";
import { requireIdentity, UnauthorizedError } from "./session";
import { identityFromApiKey } from "./services/identity";

export type Ctx<P = Record<string, string>> = { params: Promise<P> };

type Handler<P> = (req: NextRequest, identity: Identity, params: P) => Promise<Response>;

function handleError(err: unknown) {
  if (err instanceof UnauthorizedError) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  if (err instanceof ZodError) {
    return NextResponse.json({ error: "Invalid request", issues: err.issues }, { status: 400 });
  }
  const message = err instanceof Error ? err.message : "Unexpected error";
  console.error("[fuku-api]", err);
  const status = /not found/i.test(message) ? 404 : 500;
  return NextResponse.json({ error: message }, { status });
}

/** Session-cookie authenticated route (the web app). */
export function withSession<P = Record<string, string>>(handler: Handler<P>) {
  return async (req: NextRequest, ctx: Ctx<P>) => {
    try {
      const identity = await requireIdentity();
      return await handler(req, identity, await ctx.params);
    } catch (err) {
      return handleError(err);
    }
  };
}

/** API-key authenticated route (the public v1 API used by the SDK). Falls back to the session. */
export function withApiKey<P = Record<string, string>>(handler: Handler<P>) {
  return async (req: NextRequest, ctx: Ctx<P>) => {
    try {
      const header = req.headers.get("authorization");
      const raw = header?.startsWith("Bearer ") ? header.slice(7) : req.headers.get("x-fuku-key");
      let identity = await identityFromApiKey(raw ?? null);
      if (!identity) identity = await requireIdentity();
      return await handler(req, identity, await ctx.params);
    } catch (err) {
      return handleError(err);
    }
  };
}

/** Unauthenticated route with uniform error handling. */
export function withErrors<P = Record<string, string>>(handler: (req: NextRequest, params: P) => Promise<Response>) {
  return async (req: NextRequest, ctx: Ctx<P>) => {
    try {
      return await handler(req, await ctx.params);
    } catch (err) {
      return handleError(err);
    }
  };
}

export const json = (data: unknown, init?: ResponseInit) => NextResponse.json(data, init);
