import { randomInt, randomBytes } from "node:crypto";
import { db } from "@/storage/db";

// Email verification codes, stored in SimpleCache (global key-value table, no
// account relation — accounts may not exist yet). The value is a JSON blob
// carrying the code, its expiry and the failed-attempt counter; SimpleCache
// has no TTL field, so expiry is enforced here in code.
//
//   key   email-code:<purpose>:<email>
//   value {"code":"123456","expiresAt":<ms>,"attempts":<n>}
//
// Codes expire after 10 minutes, are deleted on successful verification, and
// are invalidated after 5 failed attempts.

const CODE_TTL_MS = 10 * 60 * 1000;
const CODE_MAX_ATTEMPTS = 5;
const OAUTH_STATE_TTL_MS = 5 * 60 * 1000;

export type EmailCodePurpose = 'register' | 'reset';

interface CodeRecord {
    code: string;
    expiresAt: number;
    attempts: number;
}

function codeKey(purpose: EmailCodePurpose, email: string): string {
    return `email-code:${purpose}:${email.toLowerCase()}`;
}

export async function issueEmailCode(purpose: EmailCodePurpose, email: string): Promise<string> {
    const code = randomInt(100000, 1000000).toString();
    const record: CodeRecord = {
        code,
        expiresAt: Date.now() + CODE_TTL_MS,
        attempts: 0
    };
    await db.simpleCache.upsert({
        where: { key: codeKey(purpose, email) },
        create: { key: codeKey(purpose, email), value: JSON.stringify(record) },
        update: { value: JSON.stringify(record) }
    });
    return code;
}

export async function verifyEmailCode(purpose: EmailCodePurpose, email: string, code: string): Promise<boolean> {
    const key = codeKey(purpose, email);
    const row = await db.simpleCache.findUnique({ where: { key } });
    if (!row) {
        return false;
    }
    let record: CodeRecord;
    try {
        record = JSON.parse(row.value);
    } catch {
        await db.simpleCache.delete({ where: { key } }).catch(() => {});
        return false;
    }
    if (Date.now() > record.expiresAt) {
        await db.simpleCache.delete({ where: { key } }).catch(() => {});
        return false;
    }
    if (record.code !== code) {
        record.attempts += 1;
        if (record.attempts >= CODE_MAX_ATTEMPTS) {
            await db.simpleCache.delete({ where: { key } }).catch(() => {});
        } else {
            await db.simpleCache.update({ where: { key }, data: { value: JSON.stringify(record) } }).catch(() => {});
        }
        return false;
    }
    // Success — one-shot code
    await db.simpleCache.delete({ where: { key } }).catch(() => {});
    return true;
}

/** Generate and store an OAuth state nonce (CSRF protection), 5 min TTL. */
export async function issueOAuthState(): Promise<string> {
    const state = randomBytes(16).toString('hex');
    await db.simpleCache.create({
        data: {
            key: `oauth-state:${state}`,
            value: JSON.stringify({ expiresAt: Date.now() + OAUTH_STATE_TTL_MS })
        }
    });
    return state;
}

/** Validate an OAuth state nonce and consume it (one-shot). */
export async function consumeOAuthState(state: string): Promise<boolean> {
    const key = `oauth-state:${state}`;
    const row = await db.simpleCache.findUnique({ where: { key } });
    if (!row) {
        return false;
    }
    await db.simpleCache.delete({ where: { key } }).catch(() => {});
    try {
        const record = JSON.parse(row.value);
        return Date.now() <= record.expiresAt;
    } catch {
        return false;
    }
}
