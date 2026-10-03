-- Aggregate APK requests by UTC day. No visitor or device identifiers are kept.
CREATE TABLE android_download_daily (
  day TEXT PRIMARY KEY CHECK (length(day) = 10),
  download_count INTEGER NOT NULL DEFAULT 0 CHECK (download_count >= 0)
);
