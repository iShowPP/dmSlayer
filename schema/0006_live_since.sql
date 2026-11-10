-- When an automation was last switched on. Comments older than this are ignored by the comment
-- poll, so going live on a post that already has keyword comments does not DM everyone who
-- commented in the past. Existing automations start from their last change.
ALTER TABLE campaigns ADD COLUMN live_since INTEGER;
UPDATE campaigns SET live_since = updated_at WHERE live_since IS NULL;
