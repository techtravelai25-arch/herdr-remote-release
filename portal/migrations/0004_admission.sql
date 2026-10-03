CREATE TABLE quota_counters (key TEXT PRIMARY KEY, count INTEGER NOT NULL, expires_at INTEGER NOT NULL);
CREATE INDEX quota_expiry ON quota_counters(expires_at);
CREATE TABLE admissions (id TEXT PRIMARY KEY, state INTEGER NOT NULL DEFAULT 0, expires_at INTEGER NOT NULL);
CREATE INDEX admissions_expiry ON admissions(expires_at);
CREATE INDEX rate_limits_expiry ON rate_limits(expires_at);
ALTER TABLE laptops ADD COLUMN relay_auth_version INTEGER NOT NULL DEFAULT 0;
