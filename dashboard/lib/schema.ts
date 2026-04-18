import { sql } from "drizzle-orm";
import { integer, sqliteTable, text } from "drizzle-orm/sqlite-core";

export const components = sqliteTable("components", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  slug: text("slug").notNull().unique(),
  displayName: text("display_name").notNull(),
  repoFullName: text("repo_full_name").notNull(),
  kind: text("kind").notNull(),
});

export const channels = sqliteTable("channels", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  componentId: integer("component_id").notNull().references(() => components.id),
  name: text("name").notNull(),
  branch: text("branch").notNull(),
});

export const instances = sqliteTable("instances", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  kind: text("kind").notNull(),
  name: text("name").notNull().unique(),
  displayName: text("display_name").notNull(),
  host: text("host"),
  port: integer("port"),
  componentId: integer("component_id").references(() => components.id),
  channelId: integer("channel_id").references(() => channels.id),
  company: text("company"),
  environment: text("environment"),
  notes: text("notes"),
  active: integer("active", { mode: "boolean" }).notNull().default(true),
});

export const releases = sqliteTable("releases", {
  id: integer("id").primaryKey(),
  componentId: integer("component_id").notNull().references(() => components.id),
  tagName: text("tag_name").notNull(),
  name: text("name"),
  channel: text("channel"),
  draft: integer("draft", { mode: "boolean" }).notNull().default(false),
  prerelease: integer("prerelease", { mode: "boolean" }).notNull().default(false),
  publishedAt: text("published_at"),
  htmlUrl: text("html_url"),
  payloadJson: text("payload_json"),
});

export const workflowRuns = sqliteTable("workflow_runs", {
  id: integer("id").primaryKey(),
  componentId: integer("component_id").notNull().references(() => components.id),
  name: text("name"),
  status: text("status"),
  conclusion: text("conclusion"),
  headBranch: text("head_branch"),
  runNumber: integer("run_number"),
  event: text("event"),
  runStartedAt: text("run_started_at"),
  updatedAt: text("updated_at"),
  htmlUrl: text("html_url"),
});

export const pullRequests = sqliteTable("pull_requests", {
  id: integer("id").primaryKey(),
  componentId: integer("component_id").notNull().references(() => components.id),
  number: integer("number").notNull(),
  title: text("title").notNull(),
  state: text("state").notNull(),
  draft: integer("draft", { mode: "boolean" }).notNull().default(false),
  author: text("author"),
  headRef: text("head_ref"),
  baseRef: text("base_ref"),
  createdAt: text("created_at"),
  updatedAt: text("updated_at"),
  htmlUrl: text("html_url"),
});

export const deployments = sqliteTable("deployments", {
  id: integer("id").primaryKey(),
  componentId: integer("component_id").notNull().references(() => components.id),
  environment: text("environment").notNull(),
  ref: text("ref"),
  sha: text("sha"),
  createdAt: text("created_at"),
  latestStatus: text("latest_status"),
  latestStatusDescription: text("latest_status_description"),
  latestStatusAt: text("latest_status_at"),
  logUrl: text("log_url"),
  payloadJson: text("payload_json"),
});

export const healthChecks = sqliteTable("health_checks", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  instanceId: integer("instance_id").references(() => instances.id),
  serverId: integer("server_id"),
  checkedAt: text("checked_at").notNull().default(sql`CURRENT_TIMESTAMP`),
  status: text("status").notNull(),
  httpCode: integer("http_code"),
  latencyMs: integer("latency_ms"),
  bodyExcerpt: text("body_excerpt"),
});

export const instanceRuntime = sqliteTable("instance_runtime", {
  serverId: integer("server_id").primaryKey(),
  instanceId: integer("instance_id").references(() => instances.id),
  version: text("version"),
  build: text("build"),
  gitCommit: text("git_commit"),
  uptimeSec: integer("uptime_sec"),
  heapUsedBytes: integer("heap_used_bytes"),
  heapMaxBytes: integer("heap_max_bytes"),
  threads: integer("threads"),
  infoJson: text("info_json"),
  updatedAt: text("updated_at").notNull().default(sql`CURRENT_TIMESTAMP`),
});

export const alerts = sqliteTable("alerts", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  severity: text("severity").notNull(),
  kind: text("kind").notNull(),
  instanceId: integer("instance_id").references(() => instances.id),
  serverId: integer("server_id"),
  componentId: integer("component_id").references(() => components.id),
  title: text("title").notNull(),
  detail: text("detail"),
  firstSeenAt: text("first_seen_at").notNull().default(sql`CURRENT_TIMESTAMP`),
  lastSeenAt: text("last_seen_at").notNull().default(sql`CURRENT_TIMESTAMP`),
  resolvedAt: text("resolved_at"),
  fingerprint: text("fingerprint").notNull().unique(),
});

export const syncRuns = sqliteTable("sync_runs", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  jobName: text("job_name").notNull(),
  startedAt: text("started_at").notNull().default(sql`CURRENT_TIMESTAMP`),
  finishedAt: text("finished_at"),
  ok: integer("ok", { mode: "boolean" }).notNull().default(false),
  itemsIngested: integer("items_ingested"),
  errorMessage: text("error_message"),
});

export const pgClusterStatus = sqliteTable("pg_cluster_status", {
  clusterPort: integer("cluster_port").primaryKey(),
  serverId: integer("server_id"),
  label: text("label").notNull(),
  status: text("status").notNull(),
  version: text("version"),
  errorMessage: text("error_message"),
  checkedAt: text("checked_at").notNull().default(sql`CURRENT_TIMESTAMP`),
});

export const pgDatabases = sqliteTable("pg_databases", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  clusterPort: integer("cluster_port").notNull(),
  serverId: integer("server_id"),
  name: text("name").notNull(),
  sizeBytes: integer("size_bytes"),
  activeConnections: integer("active_connections"),
  latencyMs: integer("latency_ms"),
  status: text("status").notNull().default("unknown"),
  errorMessage: text("error_message"),
  checkedAt: text("checked_at").notNull().default(sql`CURRENT_TIMESTAMP`),
});

export const pgReplicationItems = sqliteTable("pg_replication_items", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  clusterPort: integer("cluster_port").notNull(),
  kind: text("kind").notNull(),
  name: text("name").notNull(),
  database: text("database"),
  active: integer("active", { mode: "boolean" }),
  sucursalId: integer("sucursal_id"),
  direction: text("direction"),
  extraJson: text("extra_json"),
  checkedAt: text("checked_at").notNull().default(sql`CURRENT_TIMESTAMP`),
});

export const sucursales = sqliteTable("sucursales", {
  id: integer("id").primaryKey(),
  nombre: text("nombre"),
  ip: text("ip"),
  puerto: integer("puerto"),
  activo: integer("activo", { mode: "boolean" }),
  sourceClusterPort: integer("source_cluster_port"),
  sourceDatabase: text("source_database"),
  updatedAt: text("updated_at").notNull().default(sql`CURRENT_TIMESTAMP`),
});

export const monitoredServers = sqliteTable("monitored_servers", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  kind: text("kind").notNull(),
  empresa: text("empresa"),
  nombre: text("nombre").notNull(),
  ip: text("ip"),
  appPort: integer("app_port"),
  pgHost: text("pg_host"),
  pgPort: integer("pg_port"),
  pgDatabase: text("pg_database"),
  pgUser: text("pg_user"),
  pgPassword: text("pg_password"),
  channel: text("channel"),
  os: text("os"),
  sucursalId: integer("sucursal_id"),
  githubEnvironment: text("github_environment"),
  active: integer("active", { mode: "boolean" }).notNull().default(true),
  notes: text("notes"),
  createdAt: text("created_at").notNull().default(sql`CURRENT_TIMESTAMP`),
  updatedAt: text("updated_at").notNull().default(sql`CURRENT_TIMESTAMP`),
});

export const expectedReplication = sqliteTable("expected_replication", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  serverId: integer("server_id").notNull().references(() => monitoredServers.id, { onDelete: "cascade" }),
  kind: text("kind").notNull(),
  name: text("name").notNull(),
  peerServerId: integer("peer_server_id").references(() => monitoredServers.id, { onDelete: "set null" }),
  direction: text("direction"),
  notes: text("notes"),
  createdAt: text("created_at").notNull().default(sql`CURRENT_TIMESTAMP`),
});

export const replicationCheckResults = sqliteTable("replication_check_results", {
  expectedId: integer("expected_id").primaryKey().references(() => expectedReplication.id, { onDelete: "cascade" }),
  status: text("status").notNull(),
  active: integer("active", { mode: "boolean" }),
  extraJson: text("extra_json"),
  checkedAt: text("checked_at").notNull().default(sql`CURRENT_TIMESTAMP`),
});

export type Component = typeof components.$inferSelect;
export type Channel = typeof channels.$inferSelect;
export type Instance = typeof instances.$inferSelect;
export type Release = typeof releases.$inferSelect;
export type WorkflowRun = typeof workflowRuns.$inferSelect;
export type PullRequest = typeof pullRequests.$inferSelect;
export type Deployment = typeof deployments.$inferSelect;
export type HealthCheck = typeof healthChecks.$inferSelect;
export type Alert = typeof alerts.$inferSelect;
export type SyncRun = typeof syncRuns.$inferSelect;
