CREATE TABLE IF NOT EXISTS components (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  slug TEXT NOT NULL UNIQUE,
  display_name TEXT NOT NULL,
  repo_full_name TEXT NOT NULL,
  kind TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS channels (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  component_id INTEGER NOT NULL REFERENCES components(id),
  name TEXT NOT NULL,
  branch TEXT NOT NULL,
  UNIQUE (component_id, name)
);

CREATE TABLE IF NOT EXISTS instances (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  kind TEXT NOT NULL,
  name TEXT NOT NULL UNIQUE,
  display_name TEXT NOT NULL,
  host TEXT,
  port INTEGER,
  component_id INTEGER REFERENCES components(id),
  channel_id INTEGER REFERENCES channels(id),
  company TEXT,
  environment TEXT,
  notes TEXT,
  active INTEGER NOT NULL DEFAULT 1
);
CREATE INDEX IF NOT EXISTS idx_instances_component ON instances(component_id);
CREATE INDEX IF NOT EXISTS idx_instances_environment ON instances(environment);

CREATE TABLE IF NOT EXISTS releases (
  id INTEGER PRIMARY KEY,
  component_id INTEGER NOT NULL REFERENCES components(id),
  tag_name TEXT NOT NULL,
  name TEXT,
  channel TEXT,
  draft INTEGER NOT NULL DEFAULT 0,
  prerelease INTEGER NOT NULL DEFAULT 0,
  published_at TEXT,
  html_url TEXT,
  payload_json TEXT
);
CREATE INDEX IF NOT EXISTS idx_releases_component ON releases(component_id);
CREATE INDEX IF NOT EXISTS idx_releases_published_at ON releases(published_at);

CREATE TABLE IF NOT EXISTS workflow_runs (
  id INTEGER PRIMARY KEY,
  component_id INTEGER NOT NULL REFERENCES components(id),
  name TEXT,
  status TEXT,
  conclusion TEXT,
  head_branch TEXT,
  run_number INTEGER,
  event TEXT,
  run_started_at TEXT,
  updated_at TEXT,
  html_url TEXT
);
CREATE INDEX IF NOT EXISTS idx_workflow_runs_component ON workflow_runs(component_id);
CREATE INDEX IF NOT EXISTS idx_workflow_runs_started ON workflow_runs(run_started_at);

CREATE TABLE IF NOT EXISTS pull_requests (
  id INTEGER PRIMARY KEY,
  component_id INTEGER NOT NULL REFERENCES components(id),
  number INTEGER NOT NULL,
  title TEXT NOT NULL,
  state TEXT NOT NULL,
  draft INTEGER NOT NULL DEFAULT 0,
  author TEXT,
  head_ref TEXT,
  base_ref TEXT,
  created_at TEXT,
  updated_at TEXT,
  html_url TEXT
);
CREATE INDEX IF NOT EXISTS idx_pull_requests_component ON pull_requests(component_id);
CREATE INDEX IF NOT EXISTS idx_pull_requests_state ON pull_requests(state);

CREATE TABLE IF NOT EXISTS deployments (
  id INTEGER PRIMARY KEY,
  component_id INTEGER NOT NULL REFERENCES components(id),
  environment TEXT NOT NULL,
  ref TEXT,
  sha TEXT,
  created_at TEXT,
  latest_status TEXT,
  latest_status_description TEXT,
  latest_status_at TEXT,
  log_url TEXT,
  payload_json TEXT
);
CREATE INDEX IF NOT EXISTS idx_deployments_component ON deployments(component_id);
CREATE INDEX IF NOT EXISTS idx_deployments_environment ON deployments(environment);
CREATE INDEX IF NOT EXISTS idx_deployments_created ON deployments(created_at);

CREATE TABLE IF NOT EXISTS health_checks (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  instance_id INTEGER REFERENCES instances(id),
  checked_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  status TEXT NOT NULL,
  http_code INTEGER,
  latency_ms INTEGER,
  body_excerpt TEXT
);
CREATE INDEX IF NOT EXISTS idx_health_checks_instance ON health_checks(instance_id);
CREATE INDEX IF NOT EXISTS idx_health_checks_checked_at ON health_checks(checked_at);

CREATE TABLE IF NOT EXISTS instance_runtime (
  instance_id INTEGER PRIMARY KEY REFERENCES instances(id),
  version TEXT,
  build TEXT,
  git_commit TEXT,
  uptime_sec INTEGER,
  heap_used_bytes INTEGER,
  heap_max_bytes INTEGER,
  threads INTEGER,
  info_json TEXT,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS alerts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  severity TEXT NOT NULL,
  kind TEXT NOT NULL,
  instance_id INTEGER REFERENCES instances(id),
  component_id INTEGER REFERENCES components(id),
  title TEXT NOT NULL,
  detail TEXT,
  first_seen_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  last_seen_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  resolved_at TEXT,
  fingerprint TEXT NOT NULL UNIQUE
);
CREATE INDEX IF NOT EXISTS idx_alerts_resolved ON alerts(resolved_at);
CREATE INDEX IF NOT EXISTS idx_alerts_kind ON alerts(kind);

CREATE TABLE IF NOT EXISTS pg_cluster_status (
  cluster_port INTEGER PRIMARY KEY,
  label TEXT NOT NULL,
  status TEXT NOT NULL,
  version TEXT,
  error_message TEXT,
  checked_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS pg_databases (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  cluster_port INTEGER NOT NULL,
  name TEXT NOT NULL,
  size_bytes INTEGER,
  active_connections INTEGER,
  latency_ms INTEGER,
  status TEXT NOT NULL DEFAULT 'unknown',
  error_message TEXT,
  checked_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE (cluster_port, name)
);
CREATE INDEX IF NOT EXISTS idx_pg_databases_cluster ON pg_databases(cluster_port);

CREATE TABLE IF NOT EXISTS pg_replication_items (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  cluster_port INTEGER NOT NULL,
  kind TEXT NOT NULL,
  name TEXT NOT NULL,
  database TEXT,
  active INTEGER,
  sucursal_id INTEGER,
  direction TEXT,
  extra_json TEXT,
  checked_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_pg_replication_cluster ON pg_replication_items(cluster_port);
CREATE INDEX IF NOT EXISTS idx_pg_replication_sucursal ON pg_replication_items(sucursal_id);
CREATE INDEX IF NOT EXISTS idx_pg_replication_kind ON pg_replication_items(kind);

CREATE TABLE IF NOT EXISTS sucursales (
  id INTEGER PRIMARY KEY,
  nombre TEXT,
  ip TEXT,
  puerto INTEGER,
  activo INTEGER,
  source_cluster_port INTEGER,
  source_database TEXT,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS monitored_servers (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  kind TEXT NOT NULL,
  empresa TEXT,
  nombre TEXT NOT NULL,
  ip TEXT,
  app_port INTEGER,
  pg_host TEXT,
  pg_port INTEGER,
  pg_database TEXT,
  pg_user TEXT,
  pg_password TEXT,
  channel TEXT,
  os TEXT,
  sucursal_id INTEGER,
  github_environment TEXT,
  active INTEGER NOT NULL DEFAULT 1,
  notes TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_monitored_servers_kind ON monitored_servers(kind);
CREATE INDEX IF NOT EXISTS idx_monitored_servers_empresa ON monitored_servers(empresa);
CREATE INDEX IF NOT EXISTS idx_monitored_servers_environment ON monitored_servers(github_environment);

CREATE TABLE IF NOT EXISTS expected_replication (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  server_id INTEGER NOT NULL REFERENCES monitored_servers(id) ON DELETE CASCADE,
  kind TEXT NOT NULL,
  name TEXT NOT NULL,
  peer_server_id INTEGER REFERENCES monitored_servers(id) ON DELETE SET NULL,
  direction TEXT,
  notes TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE (server_id, kind, name)
);
CREATE INDEX IF NOT EXISTS idx_expected_repl_server ON expected_replication(server_id);

CREATE TABLE IF NOT EXISTS replication_check_results (
  expected_id INTEGER PRIMARY KEY REFERENCES expected_replication(id) ON DELETE CASCADE,
  status TEXT NOT NULL,
  active INTEGER,
  extra_json TEXT,
  checked_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS sync_runs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  job_name TEXT NOT NULL,
  started_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  finished_at TEXT,
  ok INTEGER NOT NULL DEFAULT 0,
  items_ingested INTEGER,
  error_message TEXT
);
CREATE INDEX IF NOT EXISTS idx_sync_runs_job ON sync_runs(job_name);
CREATE INDEX IF NOT EXISTS idx_sync_runs_started ON sync_runs(started_at);
