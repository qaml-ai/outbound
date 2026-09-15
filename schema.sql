-- outbound: shared prospect database
-- Applied with:  npm run db:remote   (or db:local for wrangler dev)

CREATE TABLE IF NOT EXISTS prospects (
  id             TEXT PRIMARY KEY,
  company        TEXT NOT NULL,
  domain         TEXT,
  contact_name   TEXT,
  contact_email  TEXT UNIQUE,          -- normalised to lowercase on write
  contact_title  TEXT,
  linkedin       TEXT,
  source         TEXT,                 -- where the lead came from
  owner          TEXT,                 -- who on the team owns it
  stage          TEXT NOT NULL DEFAULT 'new',
  next_action    TEXT,
  next_action_at TEXT,                 -- ISO-8601 date
  notes          TEXT,
  rev            INTEGER NOT NULL DEFAULT 1,   -- bumped on every write; used for --expect-rev
  created_at     TEXT NOT NULL,
  updated_at     TEXT NOT NULL,
  updated_by     TEXT
);

CREATE INDEX IF NOT EXISTS idx_prospects_stage  ON prospects(stage);
CREATE INDEX IF NOT EXISTS idx_prospects_owner  ON prospects(owner);
CREATE INDEX IF NOT EXISTS idx_prospects_domain ON prospects(domain);
CREATE INDEX IF NOT EXISTS idx_prospects_next   ON prospects(next_action_at);

-- Every interaction. Append-only by convention; `outbound list --stale=7d`
-- reads the most recent row per prospect.
CREATE TABLE IF NOT EXISTS touches (
  id          TEXT PRIMARY KEY,
  prospect_id TEXT NOT NULL REFERENCES prospects(id) ON DELETE CASCADE,
  channel     TEXT NOT NULL,                  -- email | linkedin | call | meeting | other
  direction   TEXT NOT NULL DEFAULT 'out',    -- out | in
  note        TEXT,
  author      TEXT,
  occurred_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_touches_prospect ON touches(prospect_id, occurred_at DESC);
CREATE INDEX IF NOT EXISTS idx_touches_time     ON touches(occurred_at DESC);
