CREATE TABLE "deviceCode" (
  "id" TEXT PRIMARY KEY,
  "deviceCode" TEXT NOT NULL UNIQUE,
  "userCode" TEXT NOT NULL UNIQUE,
  "userId" TEXT REFERENCES "user"("id") ON DELETE CASCADE,
  "expiresAt" TIMESTAMPTZ NOT NULL,
  "status" TEXT NOT NULL,
  "lastPolledAt" TIMESTAMPTZ,
  "pollingInterval" INTEGER,
  "clientId" TEXT,
  "scope" TEXT
);
CREATE INDEX "deviceCode_expiresAt_idx" ON "deviceCode" ("expiresAt");
