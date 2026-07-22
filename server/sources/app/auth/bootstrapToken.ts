import { createHash, randomBytes } from "node:crypto";
import { db } from "@/storage/db";

function hashToken(token: string): string {
    return createHash("sha256").update(token).digest("hex");
}

/** Generate a cryptographically random bootstrap token string (64 hex chars). */
export function generateBootstrapTokenPlaintext(): string {
    return randomBytes(32).toString("hex");
}

export interface BootstrapTokenRecord {
    id: string;
    accountId: string;
    label: string | null;
    machineId: string | null;
    createdAt: Date;
    revokedAt: Date | null;
}

/**
 * Create a bootstrap token for an account.
 * Returns the PLAINTEXT token which is shown once at creation time.
 * Only the SHA-256 hash is stored in the database.
 */
export async function createBootstrapToken(params: {
    accountId: string;
    label?: string;
}): Promise<{ plaintext: string; record: BootstrapTokenRecord }> {
    const plaintext = generateBootstrapTokenPlaintext();
    const hash = hashToken(plaintext);
    const record = await db.bootstrapToken.create({
        data: {
            accountId: params.accountId,
            tokenHash: hash,
            label: params.label ?? null,
        },
    });
    return {
        plaintext,
        record: {
            id: record.id,
            accountId: record.accountId,
            label: record.label,
            machineId: record.machineId,
            createdAt: record.createdAt,
            revokedAt: record.revokedAt,
        },
    };
}

/**
 * Verify a plaintext bootstrap token against the database.
 * Returns the associated accountId if valid, null otherwise.
 */
export async function verifyBootstrapToken(plaintext: string): Promise<{ accountId: string } | null> {
    const hash = hashToken(plaintext);
    const record = await db.bootstrapToken.findUnique({
        where: { tokenHash: hash },
    });
    if (!record || record.revokedAt !== null) {
        return null;
    }
    return { accountId: record.accountId };
}

/** Revoke a bootstrap token by ID. Returns true on success. */
export async function revokeBootstrapToken(id: string): Promise<boolean> {
    try {
        await db.bootstrapToken.update({
            where: { id },
            data: { revokedAt: new Date() },
        });
        return true;
    } catch {
        return false;
    }
}

/** List all bootstrap tokens for an account, newest first. */
export async function listBootstrapTokens(accountId: string): Promise<BootstrapTokenRecord[]> {
    const records = await db.bootstrapToken.findMany({
        where: { accountId },
        orderBy: { createdAt: "desc" },
    });
    return records.map((r) => ({
        id: r.id,
        accountId: r.accountId,
        label: r.label,
        machineId: r.machineId,
        createdAt: r.createdAt,
        revokedAt: r.revokedAt,
    }));
}
