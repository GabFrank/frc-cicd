-- Notificaciones WhatsApp: destinatarios, reglas, log y estado por (fingerprint, target)

CREATE TABLE IF NOT EXISTS notification_targets (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  kind TEXT NOT NULL,
  jid TEXT NOT NULL,
  active INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS notification_rules (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  target_id INTEGER NOT NULL REFERENCES notification_targets(id) ON DELETE CASCADE,
  min_severity TEXT NOT NULL DEFAULT 'warn',
  alert_kinds_csv TEXT,
  empresa_filter TEXT,
  server_ids_csv TEXT,
  quiet_start TEXT,
  quiet_end TEXT,
  quiet_bypass_critical INTEGER NOT NULL DEFAULT 1,
  resend_interval_min INTEGER NOT NULL DEFAULT 60,
  active INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_notification_rules_target ON notification_rules(target_id);

CREATE TABLE IF NOT EXISTS notification_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  alert_id INTEGER NOT NULL REFERENCES alerts(id) ON DELETE CASCADE,
  alert_fingerprint TEXT NOT NULL,
  target_id INTEGER NOT NULL REFERENCES notification_targets(id) ON DELETE CASCADE,
  rule_id INTEGER NOT NULL REFERENCES notification_rules(id) ON DELETE CASCADE,
  event_kind TEXT NOT NULL,
  status TEXT NOT NULL,
  reason TEXT,
  evolution_message_id TEXT,
  http_code INTEGER,
  error_message TEXT,
  sent_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_notification_log_fingerprint ON notification_log(alert_fingerprint);
CREATE INDEX IF NOT EXISTS idx_notification_log_sent_at ON notification_log(sent_at);
CREATE INDEX IF NOT EXISTS idx_notification_log_target ON notification_log(target_id);

CREATE TABLE IF NOT EXISTS notification_state (
  alert_fingerprint TEXT NOT NULL,
  target_id INTEGER NOT NULL REFERENCES notification_targets(id) ON DELETE CASCADE,
  last_sent_at TEXT NOT NULL,
  last_severity TEXT NOT NULL,
  last_event_kind TEXT NOT NULL,
  last_alert_last_seen_at TEXT,
  last_payload_hash TEXT,
  resolved_notified_at TEXT,
  PRIMARY KEY (alert_fingerprint, target_id)
);
