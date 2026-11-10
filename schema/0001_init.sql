-- dmSlayer D1 schema (SQLite). Applied with `wrangler d1 migrations apply dmslayer`.

-- One row per person per campaign: their position in the funnel.
CREATE TABLE IF NOT EXISTS conversations (
  igsid        TEXT NOT NULL,
  campaign_id  TEXT NOT NULL,
  state        TEXT NOT NULL,          -- NEW | AWAITING_TAP | AWAITING_FOLLOW | AWAITING_EMAIL | DELIVER | DONE
  username     TEXT,
  email        TEXT,
  followed     INTEGER DEFAULT 0,
  follow_retries INTEGER DEFAULT 0,    -- capped resend counter for verify_follow_count mode
  updated_at   INTEGER NOT NULL,
  created_at   INTEGER NOT NULL,
  PRIMARY KEY (igsid, campaign_id)
);
CREATE INDEX IF NOT EXISTS idx_conversations_state ON conversations (state);

-- Idempotency ledger: never process a comment twice.
CREATE TABLE IF NOT EXISTS processed_comments (
  comment_id   TEXT PRIMARY KEY,
  igsid        TEXT NOT NULL,
  campaign_id  TEXT NOT NULL,
  created_at   INTEGER NOT NULL
);

-- Ledger of public actions already taken on a comment (public reply, like), so re-polls don't repeat them.
CREATE TABLE IF NOT EXISTS comment_actions (
  comment_id   TEXT NOT NULL,
  action       TEXT NOT NULL,          -- public_reply | like
  created_at   INTEGER NOT NULL,
  PRIMARY KEY (comment_id, action)
);

-- Analytics events, one row per tracked action (powers the dashboard).
CREATE TABLE IF NOT EXISTS events (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  campaign_id  TEXT NOT NULL,
  igsid        TEXT,
  type         TEXT NOT NULL,          -- comment_matched | opening_sent | button_clicked | follow_confirmed | email_captured | delivered
  created_at   INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_events_campaign ON events (campaign_id, type, created_at);

-- Campaigns authored by the builder UI (or imported from config.json).
CREATE TABLE IF NOT EXISTS campaigns (
  campaign_id  TEXT PRIMARY KEY,
  platform     TEXT NOT NULL DEFAULT 'instagram',
  media_id     TEXT NOT NULL,
  config_json  TEXT NOT NULL,          -- full campaign object from Section 7
  active       INTEGER DEFAULT 1,
  updated_at   INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_campaigns_media ON campaigns (media_id, active);

-- Token storage (single owner). ig_user_id/profile fields power message sends and the UI preview.
CREATE TABLE IF NOT EXISTS auth (
  id                  INTEGER PRIMARY KEY CHECK (id = 1),
  access_token        TEXT NOT NULL,
  ig_user_id          TEXT,
  username            TEXT,
  account_type        TEXT,
  profile_picture_url TEXT,
  expires_at          INTEGER NOT NULL,
  refreshed_at        INTEGER
);

-- Key/value store for small runtime state (e.g. last poll timestamp).
CREATE TABLE IF NOT EXISTS kv (
  key         TEXT PRIMARY KEY,
  value       TEXT NOT NULL,
  updated_at  INTEGER NOT NULL
);
