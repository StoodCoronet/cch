import { scrypt, randomBytes, timingSafeEqual } from "node:crypto";
import { promisify } from "node:util";

const scryptAsync = promisify(scrypt);
const PASSWORD_KV_KEY = "auth.password";

export { PASSWORD_KV_KEY };

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

export function encodePasswordRecord(record: PasswordRecord): string {
    return Buffer.from(JSON.stringify(record), "utf-8").toString("base64");
}

export function decodePasswordRecord(value: string): PasswordRecord {
    return JSON.parse(Buffer.from(value, "base64").toString("utf-8")) as PasswordRecord;
}
