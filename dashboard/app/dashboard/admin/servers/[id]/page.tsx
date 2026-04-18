import Link from "next/link";
import { notFound } from "next/navigation";
import { eq } from "drizzle-orm";
import { db, schema } from "@/lib/db";
import { ServerForm } from "@/components/ServerForm";
import { ExpectedReplicationManager } from "@/components/ExpectedReplicationManager";

export const dynamic = "force-dynamic";

export default async function EditServerPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const numId = Number(id);
  if (!Number.isFinite(numId)) notFound();

  const row = db
    .select()
    .from(schema.monitoredServers)
    .where(eq(schema.monitoredServers.id, numId))
    .get();

  if (!row) notFound();

  const { pgPassword, ...rest } = row;
  const initial = { ...rest, hasPassword: !!pgPassword };

  return (
    <div className="space-y-6">
      <div className="text-sm text-text-muted">
        <Link href="/dashboard/admin" className="hover:underline">← Admin</Link>
      </div>
      <h1 className="text-2xl font-bold">Editar · {row.nombre}</h1>
      <ServerForm mode="edit" initial={initial} />

      <hr className="border-border-subtle" />

      <ExpectedReplicationManager serverId={numId} />
    </div>
  );
}
