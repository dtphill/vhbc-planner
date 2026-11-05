-- Preserve games and play history while hiding removed catalogue entries.
ALTER TABLE games ADD COLUMN archived_at INTEGER;
ALTER TABLE games ADD COLUMN archived_by TEXT;
CREATE TABLE group_join_links (
  id INTEGER PRIMARY KEY CHECK(id=1),
  nonce TEXT NOT NULL,
  enabled INTEGER NOT NULL DEFAULT 1 CHECK(enabled IN (0,1)),
  created_by TEXT NOT NULL,
  updated_at INTEGER NOT NULL
);

-- Keep last-known game metadata even when BGG search or item lookup is unavailable.
CREATE TABLE game_metadata (
  bgg_id INTEGER PRIMARY KEY,
  title TEXT NOT NULL,
  thumbnail TEXT,
  min_players INTEGER,
  max_players INTEGER,
  fetched_at INTEGER NOT NULL
);
