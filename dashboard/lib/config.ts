export type ComponentKind = "backend_central" | "backend_filial" | "desktop" | "mobile";

export interface ComponentDef {
  slug: string;
  displayName: string;
  repoFullName: string;
  kind: ComponentKind;
}

export const COMPONENTS: ComponentDef[] = [
  {
    slug: "central",
    displayName: "Backend Central",
    repoFullName: "GabFrank/franco-system-backend-servidor",
    kind: "backend_central",
  },
  {
    slug: "filial",
    displayName: "Backend Filial",
    repoFullName: "GabFrank/franco-system-backend-filial",
    kind: "backend_filial",
  },
  {
    slug: "desktop",
    displayName: "Desktop (Electron)",
    repoFullName: "GabFrank/frc-sistemas-integrados-angular",
    kind: "desktop",
  },
  {
    slug: "mobile",
    displayName: "Mobile (Ionic)",
    repoFullName: "GabFrank/frc-mobile",
    kind: "mobile",
  },
];

export const CHANNELS: Record<string, { name: string; branch: string }[]> = {
  central: [
    { name: "alpha", branch: "develop" },
    { name: "beta", branch: "release/beta" },
    { name: "stable", branch: "master" },
  ],
  filial: [
    { name: "alpha", branch: "develop" },
    { name: "beta", branch: "release/beta" },
    { name: "stable", branch: "master" },
  ],
  desktop: [
    { name: "alpha", branch: "develop" },
    { name: "beta", branch: "release/beta" },
    { name: "stable", branch: "master" },
  ],
  mobile: [
    { name: "alpha", branch: "develop" },
    { name: "beta", branch: "release/beta" },
    { name: "stable", branch: "master" },
  ],
};

export type InstanceKind = "central_instance" | "filial" | "desktop_channel" | "mobile_channel";

export interface InstanceDef {
  kind: InstanceKind;
  name: string;
  displayName: string;
  componentSlug: string;
  channelName?: string;
  host?: string;
  port?: number;
  company?: string;
  environment?: string;
  notes?: string;
}

export const INSTANCES: InstanceDef[] = [
  {
    kind: "central_instance",
    name: "central-bodega",
    displayName: "Central · Bodega",
    componentSlug: "central",
    channelName: "stable",
    host: "172.25.1.200",
    port: 8081,
    company: "bodega",
    environment: "bodega",
    notes: "DB cluster 5551 / bodega",
  },
  {
    kind: "central_instance",
    name: "central-farmacia",
    displayName: "Central · Farmacia (prod)",
    componentSlug: "central",
    channelName: "beta",
    host: "172.25.1.200",
    port: 8082,
    company: "farmacia",
    environment: "farmacia",
    notes: "DB cluster 5551 / farmacia — producción",
  },
  {
    kind: "central_instance",
    name: "central-alpha",
    displayName: "Central · Alpha",
    componentSlug: "central",
    channelName: "alpha",
    // Corregido 2026-08-14: el central alpha corre en mauro, NO en la VM
    // DigitalOcean. Esta entrada apuntaba a 172.25.1.200:8083, que era un
    // `frc-alpha.service` zombi congelado en 4.1.0-alpha.67 desde el 23-jul
    // y sin usuarios — o sea el dashboard vigilaba el host equivocado.
    //
    // Se usa la IP del tailnet y no 172.25.0.172 porque ZeroTier está en
    // retiro y llegar por 172.25.* depende de la ruta que anuncia mauro;
    // 100.64.0.2 es el propio nodo. Ambas se probaron desde el contenedor.
    host: "100.64.0.2",
    port: 8083,
    environment: "alpha",
    notes: "mauro (100.64.0.2 / 172.25.0.172), junto con la filial alpha. Clusters PG locales 5551/5552/5553",
  },
  // ⚰️ `central-beta-piloto` (172.25.1.200:8084) se retiró el 2026-08-14: el
  // puerto no escucha y la instancia no existe. Se saca de acá **y** se marca
  // `active=0` en dash.db a mano — el seed es upsert-by-name y no desactiva
  // filas huérfanas, así que borrar la entrada sola no la retira del dashboard.

  ...[
    { n: 1, ip: "172.25.3.1", os: "linux" },
    { n: 2, ip: "172.25.3.2", os: "windows" },
    { n: 3, ip: "172.25.3.3", os: "windows" },
    { n: 4, ip: "172.25.3.4", os: "linux" },
    { n: 5, ip: "172.25.3.5", os: "linux" },
  ].map(({ n, ip, os }) => ({
    kind: "filial" as InstanceKind,
    name: `farmacia-filial-${n}-${os}`,
    displayName: `Farmacia · Filial ${n} (${os})`,
    componentSlug: "filial",
    channelName: "beta",
    host: ip,
    port: 8080,
    company: "farmacia",
    environment: `farmacia-filial-${n}-${os}`,
  })),

  {
    kind: "filial",
    name: "alpha-filial-linux-piloto",
    displayName: "Piloto Linux",
    componentSlug: "filial",
    channelName: "alpha",
    host: "172.25.0.172",
    port: 8080,
    environment: "alpha-filial-linux-piloto",
    notes: "Hostname: mauro",
  },
  {
    kind: "filial",
    name: "alpha-filial-windows-piloto",
    displayName: "Piloto Windows",
    componentSlug: "filial",
    channelName: "alpha",
    host: "172.25.0.3",
    port: 8080,
    environment: "alpha-filial-windows-piloto",
    notes: "Hostname: DESKTOP-MNBIF0R",
  },

  {
    kind: "desktop_channel",
    name: "desktop-alpha",
    displayName: "Desktop · Alpha",
    componentSlug: "desktop",
    channelName: "alpha",
  },
  {
    kind: "desktop_channel",
    name: "desktop-beta",
    displayName: "Desktop · Beta",
    componentSlug: "desktop",
    channelName: "beta",
  },
  {
    kind: "desktop_channel",
    name: "desktop-stable",
    displayName: "Desktop · Stable",
    componentSlug: "desktop",
    channelName: "stable",
  },

  {
    kind: "mobile_channel",
    name: "mobile-alpha",
    displayName: "Mobile · Alpha",
    componentSlug: "mobile",
    channelName: "alpha",
  },
  {
    kind: "mobile_channel",
    name: "mobile-beta",
    displayName: "Mobile · Beta",
    componentSlug: "mobile",
    channelName: "beta",
  },
  {
    kind: "mobile_channel",
    name: "mobile-stable",
    displayName: "Mobile · Stable",
    componentSlug: "mobile",
    channelName: "stable",
  },
];

export function channelFromRefOrTag(value: string | null | undefined): "alpha" | "beta" | "stable" | null {
  if (!value) return null;
  const v = value.toLowerCase();
  if (v.includes("alpha")) return "alpha";
  if (v.includes("beta") || v.includes("rc")) return "beta";
  if (v.startsWith("master") || v.includes("stable")) return "stable";
  if (/^v?\d+\.\d+\.\d+$/.test(v.replace(/^v/, ""))) return "stable";
  return null;
}
