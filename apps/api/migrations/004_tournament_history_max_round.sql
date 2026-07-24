ALTER TABLE tournament_history
  ADD COLUMN IF NOT EXISTS max_round INTEGER;
