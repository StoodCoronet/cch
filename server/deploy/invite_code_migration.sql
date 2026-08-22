-- Draft migration for the InviteCode table (added to dev via `prisma db push`).
-- Repo rule: migrations are created by humans. To apply:
--   1. Review this SQL against prisma/schema.prisma (model InviteCode).
--   2. mkdir server/prisma/migrations/<timestamp>_add_invite_code/
--      and move this file there as migration.sql
--   3. Standalone/PGlite picks it up on next start; external Postgres:
--      `prisma migrate deploy`
--   4. In dev (already db-push'd): `prisma migrate resolve --applied <name>`
--      to mark it applied without re-running.

CREATE TABLE "InviteCode" (
    "id" TEXT PRIMARY KEY,
    "tokenHash" TEXT NOT NULL,
    "label" TEXT,
    "expiresAt" TIMESTAMPTZ NOT NULL,
    "maxUses" INTEGER NOT NULL DEFAULT 1,
    "usedCount" INTEGER NOT NULL DEFAULT 0,
    "revokedAt" TIMESTAMPTZ,
    "createdAt" TIMESTAMPTZ NOT NULL DEFAULT now(),
    "updatedAt" TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX "InviteCode_tokenHash_key" ON "InviteCode"("tokenHash");
