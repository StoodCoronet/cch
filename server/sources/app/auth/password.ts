import { scrypt, randomBytes, timingSafeEqual } from "node:crypto";
import { promisify } from "node:util";

const scryptAsync = promisify(scrypt);
export const PASSWORD_KV_KEY = "auth.password";

export interface PasswordRecord {
    hash: string;
    salt: string;
}

export async function hashPassword(password: string): Promise<PasswordRecord> {
    const salt = randomBytes(16).toString("hex");
    const derived = (await scryptAsync(password, salt, 64)) as Buffer;
    return { hash: derived.toString("hex"), salt };
}

export async function verifyPassword(password: string, record: PasswordRecord): Promise<boolean> {
    const derived = (await scryptAsync(password, record.salt, 64)) as Buffer;
    const stored = Buffer.from(record.hash, "hex");
    if (derived.length !== stored.length) return false;
    return timingSafeEqual(derived, stored);
}

/** Serialize a password record to a JSON string for storage in a String column. */
export function serializePasswordRecord(record: PasswordRecord): string {
    return JSON.stringify(record);
}

/** Deserialize a password record from a JSON string. */
export function deserializePasswordRecord(value: string): PasswordRecord {
    return JSON.parse(value) as PasswordRecord;
}
