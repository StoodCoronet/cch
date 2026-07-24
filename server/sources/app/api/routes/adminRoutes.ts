import { z } from "zod";
import { type Fastify } from "../types";
import { db } from "@/storage/db";
import * as privacyKit from "privacy-kit";
import { readFileSync } from "node:fs";
import {
    createBootstrapToken,
    listBootstrapTokens,
    revokeBootstrapToken,
} from "@/app/auth/bootstrapToken";
import { hashPassword, serializePasswordRecord } from "@/app/auth/password";

function adminAuth(request: any, reply: any): boolean {
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
    const supplied = authHeader.substring(7);
    if (supplied !== password) {
        reply.code(401).send({ error: 'Invalid admin password' });
        return false;
    }
    return true;
}

export function adminRoutes(app: Fastify) {

    // Stats overview for admin dashboard
    app.get('/v1/admin/stats', {
    }, async (request, reply) => {
        if (!adminAuth(request, reply)) return;

        const [accountCount, activeSessionCount, totalSessionCount] = await Promise.all([
            db.account.count(),
            db.session.count({ where: { active: true } }),
            db.session.count(),
        ]);

        return reply.send({
            accounts: accountCount,
            activeSessions: activeSessionCount,
            totalSessions: totalSessionCount,
        });
    });

    // Create an account (admin-only — generates keypair server-side)
    app.post('/v1/admin/accounts', {
        schema: {
            body: z.object({
                username: z.string().min(1).max(64),
                password: z.string().min(1).max(128).optional(),
            }),
        },
    }, async (request, reply) => {
        if (!adminAuth(request, reply)) return;

        const tweetnacl = (await import("tweetnacl")).default;
        const keypair = tweetnacl.box.keyPair();
        const publicKeyHex = privacyKit.encodeHex(new Uint8Array(keypair.publicKey));

        const existing = await db.account.findUnique({
            where: { username: request.body.username },
        });
        if (existing) {
            return reply.code(409).send({ error: 'Username already taken' });
        }

        const account = await db.account.create({
            data: {
                publicKey: publicKeyHex,
                username: request.body.username,
                passwordHash: request.body.password
                    ? serializePasswordRecord(await hashPassword(request.body.password))
                    : undefined,
            },
        });

        return reply.send({
            accountId: account.id,
            username: account.username,
            createdAt: account.createdAt,
        });
    });

    // Delete an account and all associated data (cascade)
    app.delete('/v1/admin/accounts/:id', {
        schema: { params: z.object({ id: z.string() }) },
    }, async (request, reply) => {
        if (!adminAuth(request, reply)) return;

        const accountId = request.params.id;
        const account = await db.account.findUnique({ where: { id: accountId } });
        if (!account) {
            return reply.code(404).send({ error: 'Account not found' });
        }

        try {
            // Gather related IDs for deep cleanup.
            const sessions = await db.session.findMany({
                where: { accountId },
                select: { id: true },
            });
            const sessionIds = sessions.map((s) => s.id);

            const machines = await db.machine.findMany({
                where: { accountId },
                select: { id: true },
            });
            const machineIds = machines.map((m) => m.id);

            await db.$transaction([
                // Social / feed / kv / tokens.
                db.userRelationship.deleteMany({
                    where: { OR: [{ fromUserId: accountId }, { toUserId: accountId }] },
                }),
                db.userFeedItem.deleteMany({ where: { userId: accountId } }),
                db.userKVStore.deleteMany({ where: { accountId } }),
                db.accountPushToken.deleteMany({ where: { accountId } }),
                db.terminalAuthRequest.deleteMany({ where: { responseAccountId: accountId } }),
                db.accountAuthRequest.deleteMany({ where: { responseAccountId: accountId } }),
                db.serviceAccountToken.deleteMany({ where: { accountId } }),
                db.voiceConversation.deleteMany({ where: { accountId } }),
                db.bootstrapToken.deleteMany({ where: { accountId } }),

                // Files and artifacts.
                db.uploadedFile.deleteMany({ where: { accountId } }),
                db.artifact.deleteMany({ where: { accountId } }),

                // Session-related data.
                db.plaintextMessage.deleteMany({ where: { sessionId: { in: sessionIds } } }),
                db.sessionMessage.deleteMany({ where: { sessionId: { in: sessionIds } } }),
                db.usageReport.deleteMany({ where: { sessionId: { in: sessionIds } } }),
                db.accessKey.deleteMany({
                    where: {
                        OR: [
                            { sessionId: { in: sessionIds } },
                            { machineId: { in: machineIds } },
                        ],
                    },
                }),
                db.session.deleteMany({ where: { accountId } }),
                db.machine.deleteMany({ where: { accountId } }),

                // Finally the account itself.
                db.account.delete({ where: { id: accountId } }),
            ]);

            return reply.send({ success: true });
        } catch (e: any) {
            return reply.code(500).send({ error: e.message || 'Failed to delete account' });
        }
    });

    // List accounts with session counts
    app.get('/v1/admin/accounts', {
    }, async (request, reply) => {
        if (!adminAuth(request, reply)) return;

        const accounts = await db.account.findMany({
            select: {
                id: true,
                username: true,
                firstName: true,
                lastName: true,
                createdAt: true,
                _count: { select: { Session: true } },
            },
            orderBy: { createdAt: 'desc' },
        });

        return reply.send({
            accounts: accounts.map((a) => ({
                id: a.id,
                username: a.username,
                firstName: a.firstName,
                lastName: a.lastName,
                createdAt: a.createdAt,
                sessionCount: a._count.Session,
            })),
        });
    });

    // Generate a bootstrap token for an account
    app.post('/v1/admin/bootstrap-tokens', {
        schema: {
            body: z.object({
                accountId: z.string(),
                label: z.string().optional(),
            }),
        },
    }, async (request, reply) => {
        if (!adminAuth(request, reply)) return;

        const { accountId, label } = request.body;
        const account = await db.account.findUnique({ where: { id: accountId } });
        if (!account) {
            return reply.code(404).send({ error: 'Account not found' });
        }

        const result = await createBootstrapToken({ accountId, label });
        return reply.send({
            token: result.plaintext,
            record: {
                id: result.record.id,
                label: result.record.label,
                createdAt: result.record.createdAt,
            },
        });
    });

    // List bootstrap tokens for an account
    app.get('/v1/admin/bootstrap-tokens/:accountId', {
        schema: {
            params: z.object({ accountId: z.string() }),
        },
    }, async (request, reply) => {
        if (!adminAuth(request, reply)) return;

        const tokens = await listBootstrapTokens(request.params.accountId);
        return reply.send({ tokens });
    });

    // Revoke a bootstrap token
    app.post('/v1/admin/bootstrap-tokens/:id/revoke', {
        schema: {
            params: z.object({ id: z.string() }),
        },
    }, async (request, reply) => {
        if (!adminAuth(request, reply)) return;

        const success = await revokeBootstrapToken(request.params.id);
        if (!success) {
            return reply.code(404).send({ error: 'Token not found' });
        }
        return reply.send({ success: true });
    });

    // --- User-scoped token management (auth via privacy-kit token) ---

    app.post('/v1/bootstrap-tokens', {
        preHandler: app.authenticate,
        schema: { body: z.object({ label: z.string().optional() }) },
    }, async (request, reply) => {
        const result = await createBootstrapToken({
            accountId: request.userId,
            label: request.body.label,
        });
        return reply.send({
            token: result.plaintext,
            record: {
                id: result.record.id,
                label: result.record.label,
                createdAt: result.record.createdAt,
                connectionUrl: (process.env.PUBLIC_URL || (request.protocol + '://' + request.hostname + ':' + process.env.PORT)) + '/connect?token=' + result.plaintext,
            },
        });
    });

    app.get('/v1/bootstrap-tokens', {
        preHandler: app.authenticate,
    }, async (request, reply) => {
        const tokens = await listBootstrapTokens(request.userId);
        const baseUrl = process.env.PUBLIC_URL || (request.protocol + '://' + request.hostname + ':' + process.env.PORT);
        return reply.send({
            tokens: tokens.map((t) => ({
                id: t.id,
                label: t.label,
                createdAt: t.createdAt.getTime(),
                revokedAt: t.revokedAt ? t.revokedAt.getTime() : null,
                connectionUrl: t.tokenPlaintext ? `${baseUrl}/connect?token=${t.tokenPlaintext}` : null,
            })),
        });
    });

    app.patch('/v1/bootstrap-tokens/:id', {
        preHandler: app.authenticate,
        schema: {
            params: z.object({ id: z.string() }),
            body: z.object({ label: z.string().min(1).max(100) }),
        },
    }, async (request, reply) => {
        const token = await db.bootstrapToken.findFirst({
            where: { id: request.params.id, accountId: request.userId, revokedAt: null },
        });
        if (!token) return reply.code(404).send({ error: 'Token not found' });
        const updated = await db.bootstrapToken.update({
            where: { id: token.id },
            data: { label: request.body.label },
        });
        return reply.send({
            success: true,
            token: {
                id: updated.id,
                label: updated.label,
                createdAt: updated.createdAt.getTime(),
                revokedAt: updated.revokedAt ? updated.revokedAt.getTime() : null,
            },
        });
    });

    app.post('/v1/bootstrap-tokens/:id/revoke', {
        preHandler: app.authenticate,
        schema: { params: z.object({ id: z.string() }) },
    }, async (request, reply) => {
        const success = await revokeBootstrapToken(request.params.id);
        if (!success) return reply.code(404).send({ error: 'Token not found' });
        return reply.send({ success: true });
    });

    // Static files for admin and user dashboards
    app.get('/admin', async (_request, reply) => {
        reply.type('text/html').send(readFileSync(process.cwd() + "/admin.html", "utf-8"));
    });
    app.get('/admin.js', async (_request, reply) => {
        reply.type('application/javascript').send(readFileSync(process.cwd() + "/admin.js", "utf-8"));
    });
    app.get('/', async (_request, reply) => {
        reply.type('text/html').send(readFileSync(process.cwd() + "/user.html", "utf-8"));
    });
    app.get('/user.js', async (_request, reply) => {
        reply.type('application/javascript').send(readFileSync(process.cwd() + "/user.js", "utf-8"));
    });
}
