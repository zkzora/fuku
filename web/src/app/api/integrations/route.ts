import { json, withErrors } from "@/lib/api";
import { integrationStatus } from "@/lib/integrations";
import { chainStatus } from "@/lib/chain";

export const GET = withErrors(async () => {
  return json({ integrations: await integrationStatus(), chain: chainStatus() });
});
