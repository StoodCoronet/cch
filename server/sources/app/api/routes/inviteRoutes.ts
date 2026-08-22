import { z } from "zod";
import { createHash, randomBytes } from "node:crypto";
import { type Fastify } from "../types";
import { db } from "@/storage/db";
import * as privacyKit from "privacy-kit";
import { hashPassword, serializePasswordRecord } from "@/app/auth/password";
import { adminAuth } from "../utils/adminAuth";
import { issueEmailCode, verifyEmailCode } from "@/app/auth/emailCode";
import { sendCodeEmail, isDevCodesEnabled } from "@/modules/mailer";
import { log } from "@/utils/log";
import type { InviteCode } from "@prisma/client";

function hashInviteToken(token: string): string {
    return createHash("sha256").update(token).digest("hex");
}

// Strict limit for the public invite endpoints (token brute-force protection).
// The global rate limit is configured in api.ts.
const inviteRateLimit = { max: 20, timeWindow: '1 minute' };

interface InviteCheckOk {
    ok: true;
    invite: InviteCode;
}

interface InviteCheckFailed {
    ok: false;
    error: string;
}

async function checkInvite(token: string): Promise<InviteCheckOk | InviteCheckFailed> {
    const invite = await db.inviteCode.findUnique({
        where: { tokenHash: hashInviteToken(token) }
    });
    if (!invite) {
        return { ok: false, error: 'invalid token' };
    }
    if (invite.revokedAt) {
        return { ok: false, error: 'invite revoked' };
    }
    if (invite.expiresAt.getTime() <= Date.now()) {
        return { ok: false, error: 'invite expired' };
    }
    if (invite.usedCount >= invite.maxUses) {
        return { ok: false, error: 'invite fully used' };
    }
    return { ok: true, invite };
}

export function inviteRoutes(app: Fastify) {

    // Create an invite link (admin-only)
    app.post('/v1/admin/invites', {
        schema: {
            body: z.object({
                label: z.string().min(1).max(100).optional(),
                expiresInHours: z.number().int().min(1).max(8760).default(168),
                maxUses: z.number().int().min(1).max(100).default(1)
            })
        }
    }, async (request, reply) => {
        if (!adminAuth(request, reply)) return;

        const { label, expiresInHours, maxUses } = request.body;
        const token = randomBytes(32).toString('hex');
        const expiresAt = new Date(Date.now() + expiresInHours * 60 * 60 * 1000);

        const invite = await db.inviteCode.create({
            data: {
                tokenHash: hashInviteToken(token),
                label: label ?? null,
                expiresAt,
                maxUses
            }
        });

        const baseUrl = process.env.PUBLIC_URL || (request.protocol + '://' + request.host);
        return reply.send({
            id: invite.id,
            url: `${baseUrl}/register?token=${token}`,
            expiresAt: expiresAt.getTime(),
            maxUses
        });
    });

    // List invites (admin-only)
    app.get('/v1/admin/invites', {
    }, async (request, reply) => {
        if (!adminAuth(request, reply)) return;

        const invites = await db.inviteCode.findMany({
            orderBy: { createdAt: 'desc' }
        });
        const now = Date.now();
        return reply.send({
            invites: invites.map((i) => ({
                id: i.id,
                label: i.label,
                createdAt: i.createdAt.getTime(),
                expiresAt: i.expiresAt.getTime(),
                maxUses: i.maxUses,
                usedCount: i.usedCount,
                remainingUses: Math.max(0, i.maxUses - i.usedCount),
                expired: i.expiresAt.getTime() <= now,
                revoked: i.revokedAt !== null
            }))
        });
    });

    // Revoke an invite (admin-only)
    app.post('/v1/admin/invites/:id/revoke', {
        schema: {
            params: z.object({ id: z.string() })
        }
    }, async (request, reply) => {
        if (!adminAuth(request, reply)) return;

        try {
            await db.inviteCode.update({
                where: { id: request.params.id },
                data: { revokedAt: new Date() }
            });
        } catch {
            return reply.code(404).send({ error: 'Invite not found' });
        }
        return reply.send({ success: true });
    });

    // Hard-delete an invite (admin-only)
    app.delete('/v1/admin/invites/:id', {
        schema: {
            params: z.object({ id: z.string() })
        }
    }, async (request, reply) => {
        if (!adminAuth(request, reply)) return;

        try {
            await db.inviteCode.delete({
                where: { id: request.params.id }
            });
        } catch {
            return reply.code(404).send({ error: 'Invite not found' });
        }
        return reply.send({ success: true });
    });

    // Validate an invite token (public, rate-limited)
    app.post('/v1/invites/validate', {
        config: { rateLimit: inviteRateLimit },
        schema: {
            body: z.object({
                token: z.string().min(1).max(256)
            })
        }
    }, async (request, reply) => {
        const check = await checkInvite(request.body.token);
        if (!check.ok) {
            return reply.send({ ok: false, error: check.error });
        }
        return reply.send({ ok: true });
    });

    // Consume an invite, step 1: validate the invite and email a verification
    // code (public, rate-limited). No account is created here.
    app.post('/v1/invites/consume', {
        config: { rateLimit: inviteRateLimit },
        schema: {
            body: z.object({
                token: z.string().min(1).max(256),
                email: z.string().email().max(254),
                password: z.string().min(8).max(128)
            })
        }
    }, async (request, reply) => {
        const { token, email } = request.body;

        const check = await checkInvite(token);
        if (!check.ok) {
            return reply.send({ ok: false, error: check.error });
        }

        const existing = await db.account.findUnique({
            where: { username: email }
        });
        if (existing) {
            return reply.code(409).send({ error: 'email already registered' });
        }

        const code = await issueEmailCode('register', email);
        await sendCodeEmail(email, code, 'register');
        if (isDevCodesEnabled()) {
            log({ module: 'invite' }, `dev register code for ${email}: ${code}`);
            return reply.send({ ok: true, pending: true, devCode: code });
        }
        return reply.send({ ok: true, pending: true });
    });

    // Consume an invite, step 2: verify the email code and create the account
    // (public, rate-limited). Does not log in — the client should redirect to
    // the login page afterwards.
    app.post('/v1/invites/verify', {
        config: { rateLimit: inviteRateLimit },
        schema: {
            body: z.object({
                token: z.string().min(1).max(256),
                email: z.string().email().max(254),
                code: z.string().min(6).max(6),
                password: z.string().min(8).max(128)
            })
        }
    }, async (request, reply) => {
        const { token, email, code, password } = request.body;

        const check = await checkInvite(token);
        if (!check.ok) {
            return reply.send({ ok: false, error: check.error });
        }

        const codeOk = await verifyEmailCode('register', email, code);
        if (!codeOk) {
            return reply.send({ ok: false, error: 'invalid or expired code' });
        }

        const tweetnacl = (await import("tweetnacl")).default;
        const keypair = tweetnacl.box.keyPair();
        const publicKeyHex = privacyKit.encodeHex(new Uint8Array(keypair.publicKey));
        const passwordHash = serializePasswordRecord(await hashPassword(password));

        try {
            await db.$transaction(async (tx) => {
                // Atomically claim one use; guards against concurrent consumes
                // racing past maxUses
                const claimed = await tx.inviteCode.updateMany({
                    where: {
                        id: check.invite.id,
                        revokedAt: null,
                        expiresAt: { gt: new Date() },
                        usedCount: { lt: check.invite.maxUses }
                    },
                    data: { usedCount: { increment: 1 } }
                });
                if (claimed.count === 0) {
                    throw new Error('invite-no-longer-valid');
                }
                await tx.account.create({
                    data: {
                        publicKey: publicKeyHex,
                        username: email,
                        passwordHash
                    }
                });
            });
        } catch (error: any) {
            if (error?.message === 'invite-no-longer-valid') {
                return reply.send({ ok: false, error: 'invite fully used' });
            }
            if (error?.code === 'P2002') {
                return reply.code(409).send({ error: 'email already registered' });
            }
            throw error;
        }

        return reply.send({ ok: true });
    });
}
