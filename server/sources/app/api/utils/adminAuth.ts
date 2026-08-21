import { timingSafeEqual } from "node:crypto";

/**
 * Shared admin-password guard for /v1/admin/* routes. Sends the error reply
 * itself and returns false when the request is not authorized.
 */
export function adminAuth(request: any, reply: any): boolean {
    const password = process.env.ADMIN_PASSWORD;
    if (!password) {
        reply.code(403).send({ error: 'Admin password not configured. Set ADMIN_PASSWORD env var.' });
        return false;
    }
    const authHeader = request.headers.authorization;
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
        reply.code(401).send({ error: 'Authentication required' });
        return false;
    }
    const supplied = Buffer.from(authHeader.substring(7));
    const expected = Buffer.from(password);
    if (supplied.length !== expected.length || !timingSafeEqual(supplied, expected)) {
        reply.code(401).send({ error: 'Invalid admin password' });
        return false;
    }
    return true;
}
