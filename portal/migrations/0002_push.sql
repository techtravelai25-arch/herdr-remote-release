CREATE TABLE push_subscriptions (
  session_id TEXT PRIMARY KEY REFERENCES sessions(id) ON DELETE CASCADE,
  token TEXT NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE TABLE push_deliveries (
  device_id TEXT NOT NULL,
  event_id TEXT NOT NULL,
  session_id TEXT NOT NULL,
  claimed_at INTEGER NOT NULL,
  sent INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY(device_id,event_id,session_id)
);
CREATE INDEX push_delivery_expiry ON push_deliveries(claimed_at);
