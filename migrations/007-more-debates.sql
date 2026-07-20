-- The Floor holds up to six rooms a day, not two: the biggest story,
-- the most contested one, and the next top clusters as "trending".
ALTER TABLE debates DROP CONSTRAINT IF EXISTS debates_kind_check;
ALTER TABLE debates ADD CONSTRAINT debates_kind_check
  CHECK (kind IN ('biggest', 'contested', 'trending'));

-- One debate per story per day (instead of one per kind per day)
ALTER TABLE debates DROP CONSTRAINT IF EXISTS debates_debate_date_kind_key;
ALTER TABLE debates ADD CONSTRAINT debates_date_subtopic_key
  UNIQUE (debate_date, subtopic_id);
