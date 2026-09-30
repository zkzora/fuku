import { json, withErrors } from "@/lib/api";
import { getCurrentIdentity } from "@/lib/session";

export const GET = withErrors(async () => {
  const identity = await getCurrentIdentity();
  return json({ identity });
});
