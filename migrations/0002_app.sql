CREATE TABLE members (
  user_id TEXT PRIMARY KEY REFERENCES user(id) ON DELETE CASCADE,
  role TEXT NOT NULL DEFAULT 'member' CHECK(role IN ('admin','member')),
  priority_game_id TEXT REFERENCES games(id) ON DELETE SET NULL,
  notifications INTEGER NOT NULL DEFAULT 0 CHECK(notifications IN (0,1)),
  disabled INTEGER NOT NULL DEFAULT 0 CHECK(disabled IN (0,1)),
  created_at INTEGER NOT NULL
);
CREATE TABLE games (
  id TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  normalized_title TEXT NOT NULL UNIQUE,
  bgg_id INTEGER UNIQUE CHECK(bgg_id > 0),
  created_by TEXT REFERENCES user(id),
  created_at INTEGER NOT NULL
);
CREATE TABLE offers (
  user_id TEXT NOT NULL REFERENCES members(user_id) ON DELETE CASCADE,
  game_id TEXT NOT NULL REFERENCES games(id) ON DELETE CASCADE,
  own INTEGER NOT NULL CHECK(own IN (0,1)),
  teach INTEGER NOT NULL CHECK(teach IN (0,1)),
  counts_json TEXT NOT NULL,
  pitch TEXT NOT NULL DEFAULT '',
  PRIMARY KEY(user_id, game_id)
);
CREATE TABLE ratings (
  user_id TEXT NOT NULL REFERENCES members(user_id) ON DELETE CASCADE,
  game_id TEXT NOT NULL REFERENCES games(id) ON DELETE CASCADE,
  value TEXT NOT NULL CHECK(value IN ('want','will','pass')),
  updated_at INTEGER NOT NULL,
  PRIMARY KEY(user_id, game_id)
);
CREATE TABLE meetings (
  id TEXT PRIMARY KEY,
  status TEXT NOT NULL DEFAULT 'open' CHECK(status IN ('open','locked','completed')),
  revision INTEGER NOT NULL DEFAULT 0,
  fixed_json TEXT NOT NULL DEFAULT '[]',
  plan_json TEXT,
  updated_at INTEGER NOT NULL
);
CREATE TABLE attendance (
  meeting_id TEXT NOT NULL REFERENCES meetings(id),
  user_id TEXT NOT NULL REFERENCES members(user_id) ON DELETE CASCADE,
  coming INTEGER NOT NULL CHECK(coming IN (0,1)),
  PRIMARY KEY(meeting_id,user_id)
);
CREATE TABLE history (
  meeting_id TEXT NOT NULL REFERENCES meetings(id),
  user_id TEXT NOT NULL REFERENCES members(user_id) ON DELETE CASCADE,
  game_id TEXT NOT NULL REFERENCES games(id),
  rating TEXT NOT NULL,
  priority_game_id TEXT,
  priority_feasible INTEGER NOT NULL DEFAULT 0,
  fixed INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY(meeting_id,user_id)
);
CREATE TABLE invites (
  token_hash TEXT PRIMARY KEY,
  email TEXT NOT NULL,
  role TEXT NOT NULL DEFAULT 'member' CHECK(role IN ('admin','member')),
  expires_at INTEGER NOT NULL,
  used_at INTEGER,
  claimed_by TEXT REFERENCES user(id),
  created_by TEXT REFERENCES user(id),
  created_at INTEGER NOT NULL
);
CREATE INDEX invites_email ON invites(email);
CREATE TABLE bgg_cache (query TEXT PRIMARY KEY,response TEXT NOT NULL,expires_at INTEGER NOT NULL);
CREATE TABLE request_limits (key TEXT PRIMARY KEY,count INTEGER NOT NULL,expires_at INTEGER NOT NULL);
CREATE TABLE audit_log (id TEXT PRIMARY KEY,actor_id TEXT,action TEXT NOT NULL,meeting_id TEXT,created_at INTEGER NOT NULL);
CREATE TABLE notification_outbox (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES user(id),
  meeting_id TEXT,
  revision INTEGER,
  kind TEXT NOT NULL DEFAULT 'reminder',
  subject TEXT NOT NULL,
  body TEXT NOT NULL,
  sent_at INTEGER,
  created_at INTEGER NOT NULL
);
