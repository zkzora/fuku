import { z } from "zod";
import { db } from "@/lib/db";
import { json, withSession } from "@/lib/api";
import { createApiKey } from "@/lib/services/identity";

export const GET = withSession(async (_req, identity) => {
  const keys = await db.apiKey.findMany({
    where: { identityId: identity.id },
    orderBy: { createdAt: "desc" },
    select: { id: true, name: true, prefix: true, createdAt: true, lastUsedAt: true },
  });
  return json({ keys });
});

const body = z.object({ name: z.string().trim().min(1).max(60) });

export const POST = withSession(async (req, identity) => {
  const { name } = body.parse(await req.json());
  const { key, raw } = await createApiKey(identity.id, name);
  return json({ key: { id: key.id, name: key.name, prefix: key.prefix, createdAt: key.createdAt }, raw }, { status: 201 });
});
