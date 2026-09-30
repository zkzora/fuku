import { json, withApiKey } from "@/lib/api";
import { rateLimit } from "@/lib/rate-limit";
import { getTravelRule } from "@/lib/services/actions";

type P = { id: string };

/** The Travel Rule record of a guarded transfer, as a JSON download (owner or delegate). */
export const GET = withApiKey<P>(async (_req, caller, { id }) => {
  rateLimit("read", caller.id);
  const { record, ref } = await getTravelRule(caller, id);
  return json(record, {
    headers: {
      "content-disposition": `attachment; filename="travel-rule-${id}.json"`,
      "x-travel-rule-ref": ref ?? "",
    },
  });
});
