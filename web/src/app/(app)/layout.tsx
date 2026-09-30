import { redirect } from "next/navigation";
import { getCurrentIdentity } from "@/lib/session";
import { Shell } from "@/components/app/shell";

export const dynamic = "force-dynamic";

export default async function AppLayout({ children }: { children: React.ReactNode }) {
  const identity = await getCurrentIdentity();
  if (!identity) redirect("/sign-in");
  return (
    <Shell identity={{ id: identity.id, displayName: identity.displayName, humanVerified: identity.humanVerified }}>
      {children}
    </Shell>
  );
}
