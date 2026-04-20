-- Smart alert lifecycle: pending → firing → resolving → resolved
-- Aplicado condicional vía PRAGMA table_info en lib/migrate.ts (idempotente).

ALTER TABLE alerts ADD COLUMN state TEXT NOT NULL DEFAULT 'pending';
ALTER TABLE alerts ADD COLUMN consecutive_hits INTEGER NOT NULL DEFAULT 1;
ALTER TABLE alerts ADD COLUMN consecutive_clears INTEGER NOT NULL DEFAULT 0;
ALTER TABLE alerts ADD COLUMN promoted_at TEXT;
ALTER TABLE alerts ADD COLUMN promotion_epoch INTEGER NOT NULL DEFAULT 0;

CREATE INDEX IF NOT EXISTS idx_alerts_state ON alerts(state);

CREATE TABLE IF NOT EXISTS alert_rule_config (
  kind TEXT PRIMARY KEY,
  display_name TEXT NOT NULL,
  severity_default TEXT NOT NULL,
  pending_cycles INTEGER NOT NULL DEFAULT 1,
  resolving_cycles INTEGER NOT NULL DEFAULT 3,
  enabled INTEGER NOT NULL DEFAULT 1,
  notes TEXT,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
