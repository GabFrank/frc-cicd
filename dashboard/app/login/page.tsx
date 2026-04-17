import { redirect } from "next/navigation";
import { checkCreds, getSession } from "@/lib/auth";

async function login(formData: FormData) {
  "use server";
  const user = String(formData.get("user") ?? "");
  const pass = String(formData.get("pass") ?? "");
  const next = String(formData.get("next") ?? "/dashboard");
  if (!checkCreds(user, pass)) {
    redirect("/login?error=1");
  }
  const session = await getSession();
  session.user = user;
  session.loggedInAt = Date.now();
  await session.save();
  redirect(next || "/dashboard");
}

export default async function LoginPage({
  searchParams,
}: {
  searchParams: Promise<{ next?: string; error?: string }>;
}) {
  const sp = await searchParams;
  const session = await getSession();
  if (session.user) redirect(sp.next || "/dashboard");

  return (
    <div className="min-h-[60vh] flex items-center justify-center">
      <form action={login} className="card w-full max-w-sm space-y-4">
        <h1 className="text-xl font-bold">Iniciar sesión</h1>
        {sp.error && <div className="text-status-err text-sm">Credenciales inválidas</div>}
        <div className="space-y-2">
          <label className="block text-sm">
            Usuario
            <input
              name="user"
              type="text"
              required
              autoFocus
              className="mt-1 w-full rounded bg-bg-raised border border-border-default px-3 py-2"
            />
          </label>
          <label className="block text-sm">
            Contraseña
            <input
              name="pass"
              type="password"
              required
              className="mt-1 w-full rounded bg-bg-raised border border-border-default px-3 py-2"
            />
          </label>
          <input type="hidden" name="next" value={sp.next ?? "/dashboard"} />
        </div>
        <button
          type="submit"
          className="w-full rounded bg-status-info/20 border border-status-info/40 text-text-primary py-2 hover:bg-status-info/30"
        >
          Entrar
        </button>
      </form>
    </div>
  );
}
