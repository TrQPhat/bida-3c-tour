ALTER TABLE vote_history_entries
  ALTER COLUMN source_user_id DROP NOT NULL;

UPDATE vote_history_entries e
SET source_user_id = NULL,
    updated_at = CURRENT_TIMESTAMP
WHERE source_user_id IS NOT NULL
  AND NOT EXISTS (
    SELECT 1 FROM users u WHERE u.id = e.source_user_id
  );

ALTER TABLE vote_history_entries
  DROP CONSTRAINT IF EXISTS vote_history_entries_source_user_id_fkey;

ALTER TABLE vote_history_entries
  ADD CONSTRAINT vote_history_entries_source_user_id_fkey
  FOREIGN KEY (source_user_id) REFERENCES users(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS vote_history_entries_user_idx
  ON vote_history_entries (source_user_id, voted_at DESC);
