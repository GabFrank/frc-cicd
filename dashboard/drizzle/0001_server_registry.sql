-- Vincular health/runtime/alerts/pg_status al registry monitored_servers.
-- ALTER TABLE ADD COLUMN es seguro en SQLite y soportado desde 3.x.
-- Aplicación condicional vía PRAGMA table_info en lib/migrate.ts.

ALTER TABLE health_checks      ADD COLUMN server_id INTEGER REFERENCES monitored_servers(id);
ALTER TABLE instance_runtime   ADD COLUMN server_id INTEGER REFERENCES monitored_servers(id);
ALTER TABLE alerts             ADD COLUMN server_id INTEGER REFERENCES monitored_servers(id);
ALTER TABLE pg_cluster_status  ADD COLUMN server_id INTEGER REFERENCES monitored_servers(id);
ALTER TABLE pg_databases       ADD COLUMN server_id INTEGER REFERENCES monitored_servers(id);

CREATE INDEX IF NOT EXISTS idx_health_checks_server    ON health_checks(server_id);
CREATE INDEX IF NOT EXISTS idx_instance_runtime_server ON instance_runtime(server_id);
CREATE INDEX IF NOT EXISTS idx_alerts_server           ON alerts(server_id);
CREATE INDEX IF NOT EXISTS idx_pg_cluster_server       ON pg_cluster_status(server_id);
CREATE INDEX IF NOT EXISTS idx_pg_databases_server     ON pg_databases(server_id);
