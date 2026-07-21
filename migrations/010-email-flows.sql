-- Email verification + password reset.
ALTER TABLE auth_credentials ADD COLUMN IF NOT EXISTS email_verified BOOLEAN NOT NULL DEFAULT FALSE;

-- One-time tokens: long random links for verification, short numeric codes
-- for password reset (typed into the app). Consumed or expired rows are
-- deleted on use; a periodic cleanup would be cosmetic only.
CREATE TABLE IF NOT EXISTS email_tokens (
  token TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES userdata(id) ON DELETE CASCADE,
  kind TEXT NOT NULL CHECK (kind IN ('verify', 'reset')),
  attempts INT NOT NULL DEFAULT 0,
  expires_at TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_email_tokens_user ON email_tokens (user_id, kind);
