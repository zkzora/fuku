import { json, withErrors } from "@/lib/api";
import { clearSession } from "@/lib/session";

export const POST = withErrors(async () => {
  await clearSession();
  return json({ ok: true });
});
