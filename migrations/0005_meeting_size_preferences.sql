-- Optional meeting-specific soft choices. No existing attendance or rating is changed.
CREATE TABLE IF NOT EXISTS meeting_size_preferences (
  meeting_id TEXT NOT NULL REFERENCES meetings(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES user(id) ON DELETE CASCADE,
  preferences_json TEXT NOT NULL DEFAULT '[]' CHECK(json_valid(preferences_json) AND json_type(preferences_json)='array'),
  change_id TEXT NOT NULL,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY(meeting_id,user_id)
);
CREATE INDEX IF NOT EXISTS meeting_size_preferences_user ON meeting_size_preferences(user_id,meeting_id);
