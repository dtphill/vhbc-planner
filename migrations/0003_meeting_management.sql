-- Retain cancelled dates so the automatic fourth-Sunday schedule cannot recreate them.
-- Meetings and attendance are retained for an administrator to restore safely.
CREATE TABLE IF NOT EXISTS meeting_exclusions (
  meeting_id TEXT PRIMARY KEY REFERENCES meetings(id),
  removed_at INTEGER NOT NULL,
  removed_by TEXT
);
