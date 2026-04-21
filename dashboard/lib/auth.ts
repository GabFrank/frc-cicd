import { cookies } from "next/headers";
import { getIronSession, type SessionOptions } from "iron-session";

export interface SessionData {
  user?: string;
  loggedInAt?: number;
}

export function sessionOptions(): SessionOptions {
  const password = process.env.SESSION_SECRET;
  if (!password || password.length < 32) {
    throw new Error("SESSION_SECRET must be set and >=32 chars");
  }
  // `secure: true` requiere HTTPS — el browser no reenvía la cookie sobre HTTP.
  // En deploys on-prem sin TLS (ej. ZeroTier) hace falta desactivarlo.
  // Default: activar en production salvo que SESSION_COOKIE_SECURE=false.
  const secureEnv = process.env.SESSION_COOKIE_SECURE?.toLowerCase();
  const secure =
    secureEnv === "true" ? true :
    secureEnv === "false" ? false :
    process.env.NODE_ENV === "production";
  return {
    password,
    cookieName: "frc-dash-session",
    cookieOptions: {
      secure,
      httpOnly: true,
      sameSite: "lax",
    },
  };
}

export async function getSession() {
  const cookieStore = await cookies();
  return getIronSession<SessionData>(cookieStore, sessionOptions());
}

export function checkCreds(user: string, pass: string): boolean {
  const expectedUser = process.env.AUTH_USER;
  const expectedPass = process.env.AUTH_PASS;
  if (!expectedUser || !expectedPass) return false;
  return user === expectedUser && pass === expectedPass;
}
