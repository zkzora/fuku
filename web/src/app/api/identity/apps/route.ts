import { z } from "zod";
import { db } from "@/lib/db";
import { json, withSession } from "@/lib/api";

const body = z.discriminatedUnion("op", [
  z.object({ op: z.literal("connect"), name: z.string().min(1).max(60), scopes: z.array(z.string()).default(["identity"]) }),
  z.object({ op: z.literal("disconnect"), id: z.string() }),
  z.object({ op: z.literal("review"), requestId: z.string(), status: z.enum(["approved", "denied"]) }),
]);

export const POST = withSession(async (req, identity) => {
  const input = body.parse(await req.json());
  if (input.op === "connect") {
    const app = await db.connectedApp.create({
      data: { identityId: identity.id, name: input.name, scopes: JSON.stringify(input.scopes), status: "active" },
    });
    return json({ app });
  }
  if (input.op === "disconnect") {
    await db.connectedApp.updateMany({ where: { id: input.id, identityId: identity.id }, data: { status: "revoked" } });
    return json({ ok: true });
  }
  const request = await db.accessRequest.findFirst({ where: { id: input.requestId, identityId: identity.id } });
  if (!request) throw new Error("Request not found");
  await db.accessRequest.update({ where: { id: request.id }, data: { status: input.status } });
  if (input.status === "approved") {
    const existing = await db.connectedApp.findFirst({ where: { identityId: identity.id, name: request.app, status: "active" } });
    if (existing) {
      const scopes = new Set<string>(JSON.parse(existing.scopes));
      scopes.add(request.resource);
      await db.connectedApp.update({ where: { id: existing.id }, data: { scopes: JSON.stringify([...scopes]) } });
    } else {
      await db.connectedApp.create({
        data: { identityId: identity.id, name: request.app, scopes: JSON.stringify(["identity", request.resource]), status: "active" },
      });
    }
  }
  return json({ ok: true });
});
