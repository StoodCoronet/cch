// Post-migration schema sync — creates any tables that don't have migration files yet.
// PGlite doesn't support prisma db push, so we use raw SQL for additive changes.

import { createPGlite } from "./storage/pgliteLoader";
import * as path from "path";

const dataDir = process.env.DATA_DIR || "./data";
const pgliteDir = process.env.PGLITE_DIR || path.join(dataDir, "pglite");

async function init() {
    const pg = createPGlite(pgliteDir);

    await pg.exec(`
        CREATE TABLE IF NOT EXISTS "BootstrapToken" (
            "id" TEXT PRIMARY KEY,
            "accountId" TEXT NOT NULL REFERENCES "Account"("id"),
            "tokenHash" TEXT NOT NULL UNIQUE,
            "label" TEXT,
            "machineId" TEXT,
            "revokedAt" TIMESTAMPTZ,
            "createdAt" TIMESTAMPTZ NOT NULL DEFAULT now(),
            "updatedAt" TIMESTAMPTZ NOT NULL DEFAULT now()
        );
        CREATE INDEX IF NOT EXISTS "BootstrapToken_accountId_idx" ON "BootstrapToken"("accountId");
    `);

    await pg.exec(`
        CREATE TABLE IF NOT EXISTS "PlaintextMessage" (
            "id" TEXT PRIMARY KEY,
            "sessionId" TEXT NOT NULL,
            "role" TEXT NOT NULL,
            "content" TEXT NOT NULL,
            "createdAt" TIMESTAMPTZ NOT NULL DEFAULT now()
        );
        CREATE INDEX IF NOT EXISTS "PlaintextMessage_sessionId_createdAt_idx"
            ON "PlaintextMessage"("sessionId", "createdAt");
    `);

    console.log("Tables ready.");
    await pg.close();
}

init().catch((err) => {
    console.error("init failed:", err);
    process.exit(1);
});
