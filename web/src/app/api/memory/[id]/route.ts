import { db } from "@/lib/db";
import { json, withSession } from "@/lib/api";

type P = { id: string };

export const DELETE = withSession<P>(async (_req, identity, { id }) => {
  await db.memoryItem.deleteMany({ where: { id, identityId: identity.id } });
  return json({ ok: true });
});
