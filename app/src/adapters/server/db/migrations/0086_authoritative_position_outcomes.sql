-- Terminal market facts must carry the stable economic close timestamp used
-- by the dashboard's lifetime-token-leg projection. Existing writers stored
-- terminal winner/loser rows with resolved_at NULL; updated_at is the only
-- persisted observation time available for those legacy facts.
UPDATE "poly_market_outcomes"
SET "resolved_at" = "updated_at"
WHERE "outcome" IN ('winner', 'loser')
  AND "resolved_at" IS NULL;
