CREATE TABLE IF NOT EXISTS "PlaybackState" (
  "id" TEXT NOT NULL PRIMARY KEY,
  "userId" TEXT NOT NULL UNIQUE,
  "deviceId" TEXT,
  "stateJson" TEXT NOT NULL,
  "clientUpdatedAt" INTEGER NOT NULL DEFAULT 0,
  "createdAt" TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS "idx_playbackstate_userId_updatedAt" ON "PlaybackState" ("userId", "updatedAt" DESC);
