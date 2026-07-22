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

    // Create an account (admin-only — generates keypair server-side)
    app.post('/v1/admin/accounts', {
        schema: {
            body: z.object({ username: z.string().min(1).max(64) }),
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
            },
        });

        return reply.send({
            accountId: account.id,
            username: account.username,
            createdAt: account.createdAt,
        });
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

    // Admin dashboard — static files, avoiding template literal escaping issues
    app.get('/admin', async (_request, reply) => {
        const html = readFileSync(process.cwd() + "/admin.html", "utf-8");
        reply.type('text/html').send(html);
    });

    app.get('/admin.js', async (_request, reply) => {
        const js = readFileSync(process.cwd() + "/admin.js", "utf-8");
        reply.type('application/javascript').send(js);
    });
}
