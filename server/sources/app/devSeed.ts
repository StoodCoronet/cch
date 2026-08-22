// Dev-mode account seeding. When DEV_SEED_ACCOUNTS=true the server creates a
// few well-known test accounts at startup (idempotent) so local debugging
// never needs the invite flow. Never set this in production — the startup log
// makes the mode obvious.

import { db } from "@/storage/db";
import { log } from "@/utils/log";
import { hashPassword, serializePasswordRecord } from "@/app/auth/password";
import * as privacyKit from "privacy-kit";

const DEV_ACCOUNTS = [
    { username: "dev1@ccc.local", password: "dev12345678" },
    { username: "dev2@ccc.local", password: "dev12345678" },
    { username: "dev3@ccc.local", password: "dev12345678" },
];

export async function seedDevAccounts(): Promise<void> {
    if (process.env.DEV_SEED_ACCOUNTS !== "true") {
        return;
    }

    for (const acc of DEV_ACCOUNTS) {
        const existing = await db.account.findUnique({ where: { username: acc.username } });
        if (existing) continue;

        const tweetnacl = (await import("tweetnacl")).default;
        const keypair = tweetnacl.box.keyPair();
        await db.account.create({
            data: {
                publicKey: privacyKit.encodeHex(new Uint8Array(keypair.publicKey)),
                username: acc.username,
                passwordHash: serializePasswordRecord(await hashPassword(acc.password)),
            }
        });
        log({ module: 'dev-seed' }, `Created dev account ${acc.username}`);
    }

    log({ module: 'dev-seed', level: 'warn' },
        `DEV MODE: seeded test accounts (${DEV_ACCOUNTS.map(a => a.username).join(', ')}) — never enable in production`);
}
