import * as fs from "fs";
import * as path from "path";
import { db } from "@/storage/db";
import { log } from "@/utils/log";

const BACKUP_FILE = process.env.BACKUP_FILE || path.join(process.env.DATA_DIR || "./data", "backup.json");

interface BackupAccount {
    id: string;
    publicKey: string;
    username: string | null;
    firstName: string | null;
    lastName: string | null;
    passwordHash: string | null;
    createdAt: string;
}

interface BackupToken {
    id: string;
    accountId: string;
    tokenHash: string;
    tokenPlaintext: string | null;
    label: string | null;
    machineId: string | null;
    revokedAt: string | null;
    createdAt: string;
}

interface BackupData {
    version: number;
    updatedAt: string;
    accounts: BackupAccount[];
    bootstrapTokens: BackupToken[];
}

async function readBackup(): Promise<BackupData | null> {
    try {
        if (!fs.existsSync(BACKUP_FILE)) return null;
        const raw = fs.readFileSync(BACKUP_FILE, "utf-8");
        return JSON.parse(raw) as BackupData;
    } catch (e) {
        log({ module: "backup", level: "error" }, `Failed to read backup: ${e}`);
        return null;
    }
}

async function writeBackup(data: BackupData): Promise<void> {
    try {
        const dir = path.dirname(BACKUP_FILE);
        fs.mkdirSync(dir, { recursive: true });
        data.updatedAt = new Date().toISOString();
        fs.writeFileSync(BACKUP_FILE, JSON.stringify(data, null, 2), "utf-8");
    } catch (e) {
        log({ module: "backup", level: "error" }, `Failed to write backup: ${e}`);
    }
}

/** Snapshot current accounts and tokens from DB into the backup file. */
export async function backupNow(): Promise<void> {
    try {
        const accounts = await db.account.findMany({
            select: {
                id: true,
                publicKey: true,
                username: true,
                firstName: true,
                lastName: true,
                passwordHash: true,
                createdAt: true,
            },
        });
        const tokens = await db.bootstrapToken.findMany();

        const data: BackupData = {
            version: 1,
            updatedAt: new Date().toISOString(),
            accounts: accounts.map((a) => ({
                id: a.id,
                publicKey: a.publicKey,
                username: a.username,
                firstName: a.firstName,
                lastName: a.lastName,
                passwordHash: a.passwordHash,
                createdAt: a.createdAt.toISOString(),
            })),
            bootstrapTokens: tokens.map((t) => ({
                id: t.id,
                accountId: t.accountId,
                tokenHash: t.tokenHash,
                tokenPlaintext: t.tokenPlaintext,
                label: t.label,
                machineId: t.machineId,
                revokedAt: t.revokedAt ? t.revokedAt.toISOString() : null,
                createdAt: t.createdAt.toISOString(),
            })),
        };

        await writeBackup(data);
        log({ module: "backup" }, `Backup written: ${data.accounts.length} accounts, ${data.bootstrapTokens.length} tokens`);
    } catch (e) {
        log({ module: "backup", level: "error" }, `Backup failed: ${e}`);
    }
}

/** Restore accounts and tokens from backup if the database is empty. */
export async function restoreIfEmpty(): Promise<boolean> {
    const accountCount = await db.account.count();
    if (accountCount > 0) return false;

    const backup = await readBackup();
    if (!backup || backup.accounts.length === 0) return false;

    log({ module: "backup" }, `Restoring ${backup.accounts.length} accounts and ${backup.bootstrapTokens.length} tokens from backup...`);

    for (const a of backup.accounts) {
        await db.account.create({
            data: {
                id: a.id,
                publicKey: a.publicKey,
                username: a.username,
                firstName: a.firstName,
                lastName: a.lastName,
                passwordHash: a.passwordHash,
                createdAt: new Date(a.createdAt),
            },
        });
    }

    for (const t of backup.bootstrapTokens) {
        await db.bootstrapToken.create({
            data: {
                id: t.id,
                accountId: t.accountId,
                tokenHash: t.tokenHash,
                tokenPlaintext: t.tokenPlaintext,
                label: t.label,
                machineId: t.machineId,
                revokedAt: t.revokedAt ? new Date(t.revokedAt) : null,
                createdAt: new Date(t.createdAt),
            },
        });
    }

    log({ module: "backup" }, "Restore completed.");
    return true;
}
