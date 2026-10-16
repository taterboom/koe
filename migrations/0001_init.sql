-- One row per submitted feedback. Only what the user typed plus the classifying
-- fields from the link (product, version, language) and Cloudflare's country code.
-- No IP, no User-Agent. Kept until deleted by hand in the admin.
CREATE TABLE feedback (
  id INTEGER PRIMARY KEY,
  product TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('feature', 'bug', 'other')),
  content TEXT NOT NULL,
  email TEXT,
  version TEXT,
  lang TEXT NOT NULL CHECK (lang IN ('zh', 'ja', 'en')),
  country TEXT,
  status TEXT NOT NULL DEFAULT 'new' CHECK (status IN ('new', 'planned', 'done', 'wontdo')),
  created_at INTEGER NOT NULL
);
-- No secondary index: submissions only insert, and the admin pages walk the
-- primary key newest-first (expected volume is in the thousands of rows).

-- Notification channels, managed in the admin. target is an email address or a
-- Feishu / Lark webhook URL; both the URL and secret are credentials, shown
-- masked and never logged. products is NULL for all products, else a JSON array.
CREATE TABLE channels (
  id INTEGER PRIMARY KEY,
  kind TEXT NOT NULL CHECK (kind IN ('email', 'feishu')),
  target TEXT NOT NULL,
  secret TEXT,
  products TEXT,
  enabled INTEGER NOT NULL DEFAULT 1 CHECK (enabled IN (0, 1)),
  created_at INTEGER NOT NULL
);
