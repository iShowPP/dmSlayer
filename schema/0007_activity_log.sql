-- Activity log: one row per thing that happened to a comment or a person, kept per video.
-- Unlike `events` (which only counts funnel steps) this records what was said, what was sent,
-- and why something was NOT sent, so "who got what" can be answered for every post.
CREATE TABLE IF NOT EXISTS activity_log (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  at          INTEGER NOT NULL,      -- unix seconds
  media_id    TEXT,                  -- the post / reel
  campaign_id TEXT,
  comment_id  TEXT,
  igsid       TEXT,
  username    TEXT,
  kind        TEXT NOT NULL,         -- comment | public_reply | dm | tap | follow | email | link
  status      TEXT NOT NULL,         -- comment: matched | no_keyword | before_live | new
                                     -- others:  sent | failed | blocked | skipped | done
  detail      TEXT,                  -- comment text, message sent, or the reason it failed
  dedupe      TEXT UNIQUE,           -- repeated attempts update one row instead of adding more
  n           INTEGER NOT NULL DEFAULT 1
);
CREATE INDEX IF NOT EXISTS idx_activity_media ON activity_log (media_id, at);

-- Backfill what the older tables already know (comment text was not stored before this).
INSERT OR IGNORE INTO activity_log (at, media_id, campaign_id, igsid, username, kind, status, detail, dedupe)
SELECT e.created_at,
       json_extract(c.config_json, '$.media_id'),
       e.campaign_id, e.igsid, v.username,
       CASE e.type WHEN 'opening_sent' THEN 'dm' WHEN 'delivered' THEN 'link' WHEN 'button_clicked' THEN 'tap'
                   WHEN 'follow_confirmed' THEN 'follow' WHEN 'email_captured' THEN 'email' END,
       CASE e.type WHEN 'opening_sent' THEN 'sent' WHEN 'delivered' THEN 'sent' ELSE 'done' END,
       'recorded before logging was added',
       'backfill:event:' || e.id
FROM events e
LEFT JOIN campaigns c ON c.campaign_id = e.campaign_id
LEFT JOIN conversations v ON v.igsid = e.igsid AND v.campaign_id = e.campaign_id
WHERE e.type != 'comment_matched';

INSERT OR IGNORE INTO activity_log (at, media_id, campaign_id, comment_id, igsid, username, kind, status, detail, dedupe)
SELECT a.created_at,
       json_extract(c.config_json, '$.media_id'),
       p.campaign_id, a.comment_id, p.igsid, v.username,
       'public_reply', 'sent', 'recorded before logging was added',
       'public_reply:' || a.comment_id
FROM comment_actions a
LEFT JOIN processed_comments p ON p.comment_id = a.comment_id
LEFT JOIN campaigns c ON c.campaign_id = p.campaign_id
LEFT JOIN conversations v ON v.igsid = p.igsid AND v.campaign_id = p.campaign_id
WHERE a.action = 'public_reply';
