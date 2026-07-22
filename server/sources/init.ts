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

    console.log("BootstrapToken table ready.");
    await pg.close();
}

init().catch((err) => {
    console.error("init failed:", err);
    process.exit(1);
});
