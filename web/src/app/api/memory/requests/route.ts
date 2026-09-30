import { z } from "zod";
import { db } from "@/lib/db";
import { json, withSession } from "@/lib/api";

const body = z.object({
  app: z.string().trim().min(1).max(60),
  resource: z.string().trim().min(1).max(60),
});

/** Simulates an application asking for access to a vault category (or identity). */
export const POST = withSession(async (req, identity) => {
  const input = body.parse(await req.json());
  const request = await db.accessRequest.create({ data: { identityId: identity.id, ...input } });
  return json({ request }, { status: 201 });
});
