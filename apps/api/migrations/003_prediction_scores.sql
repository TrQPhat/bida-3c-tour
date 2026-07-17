CREATE TABLE IF NOT EXISTS user_prediction_scores (
  user_id INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  points INTEGER NOT NULL DEFAULT 0,
  correct INTEGER NOT NULL DEFAULT 0 CHECK (correct >= 0),
  wrong INTEGER NOT NULL DEFAULT 0 CHECK (wrong >= 0),
  scored_votes INTEGER NOT NULL DEFAULT 0 CHECK (scored_votes >= 0),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);

INSERT INTO user_prediction_scores(user_id,points,correct,wrong,scored_votes)
SELECT u.id,
  COALESCE(SUM(v.awarded),0)::int,
  COUNT(*) FILTER (WHERE v.awarded=1)::int,
  COUNT(*) FILTER (WHERE v.awarded=-1)::int,
  COUNT(v.awarded)::int
FROM users u LEFT JOIN votes v ON v.user_id=u.id
WHERE u.role='user'
GROUP BY u.id
ON CONFLICT(user_id) DO NOTHING;
