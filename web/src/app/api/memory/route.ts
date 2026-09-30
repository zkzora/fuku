import { z } from "zod";
import { db } from "@/lib/db";
import { json, withSession } from "@/lib/api";
import { assertVaultWritable, vaultStateOf } from "@/lib/services/vault";

const body = z.object({
  category: z.enum(["preferences", "knowledge", "workflow", "rules"]),
  title: z.string().trim().min(1).max(80),
  ciphertext: z.string().min(1),
  iv: z.string().min(1),
  sizeBytes: z.number().int().nonnegative(),
});

export const GET = withSession(async (_req, identity) => {
  const [items, requests, apps] = await Promise.all([
    db.memoryItem.findMany({ where: { identityId: identity.id }, orderBy: { createdAt: "desc" } }),
    db.accessRequest.findMany({ where: { identityId: identity.id }, orderBy: { createdAt: "desc" } }),
    db.connectedApp.findMany({ where: { identityId: identity.id, status: "active" } }),
  ]);
  return json({
    identityId: identity.id,
    vault: vaultStateOf(identity),
    items,
    requests,
    approvedApps: apps
      .map((a) => ({ id: a.id, name: a.name, scopes: JSON.parse(a.scopes) as string[] }))
      .filter((a) => a.scopes.some((s) => s.startsWith("vault:"))),
  });
});

export const POST = withSession(async (req, identity) => {
  const input = body.parse(await req.json());
  assertVaultWritable(identity);
  const item = await db.memoryItem.create({ data: { identityId: identity.id, ...input } });
  return json({ item }, { status: 201 });
});
