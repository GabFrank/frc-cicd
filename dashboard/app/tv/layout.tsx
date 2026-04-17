import { redirect } from "next/navigation";
import { getSession } from "@/lib/auth";

export default async function TvLayout({ children }: { children: React.ReactNode }) {
  const session = await getSession();
  if (!session.user) redirect("/login?next=/tv");
  return <>{children}</>;
}
