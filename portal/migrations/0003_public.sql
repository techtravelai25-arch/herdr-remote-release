CREATE TABLE email_challenges (
  challenge_hash TEXT PRIMARY KEY,
  email TEXT NOT NULL,
  code_hash TEXT NOT NULL,
  expires_at INTEGER NOT NULL,
  attempts INTEGER NOT NULL DEFAULT 0,
  ready INTEGER NOT NULL DEFAULT 0,
  consumed INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX email_challenges_expiry ON email_challenges(expires_at);
CREATE TABLE laptops (
  id TEXT PRIMARY KEY,
  label TEXT NOT NULL,
  relay_token_hash TEXT NOT NULL,
  claim_token_hash TEXT NOT NULL,
  owner_email TEXT,
  public_key TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  revoked_at INTEGER
);
CREATE INDEX laptops_owner ON laptops(owner_email);
