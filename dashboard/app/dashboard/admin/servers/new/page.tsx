import Link from "next/link";
import { ServerForm } from "@/components/ServerForm";

export default function NewServerPage() {
  return (
    <div className="space-y-4">
      <div className="text-sm text-text-muted">
        <Link href="/dashboard/admin" className="hover:underline">← Admin</Link>
      </div>
      <h1 className="text-2xl font-bold">Nuevo servidor</h1>
      <ServerForm mode="new" />
    </div>
  );
}
