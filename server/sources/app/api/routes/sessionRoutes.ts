import { eventRouter, buildNewSessionUpdate, buildSessionActivityEphemeral } from "@/app/events/eventRouter";
import { type Fastify } from "../types";
import { db } from "@/storage/db";
import { z } from "zod";
import { Prisma } from "@prisma/client";
import { log } from "@/utils/log";
import { randomKeyNaked } from "@/utils/randomKeyNaked";
import { allocateUserSeq } from "@/storage/seq";
import { sessionDelete } from "@/app/session/sessionDelete";

export function sessionRoutes(app: Fastify) {

    // Sessions API
    app.get('/v1/sessions', {
        preHandler: app.authenticate,
        schema: {
            querystring: z.object({
                active: z.string().optional()
            }).optional()
        }
    }, async (request, reply) => {
        const userId = request.userId;

        const where: Prisma.SessionWhereInput = { accountId: userId };
        if (request.query?.active === 'true') {
            where.active = true;
        }

        const sessions = await db.session.findMany({
            where,
            orderBy: { updatedAt: 'desc' },
            take: 150,
            select: {
                id: true,
                seq: true,
                createdAt: true,
                updatedAt: true,
                tag: true,
                metadata: true,
                metadataVersion: true,
                agentState: true,
                agentStateVersion: true,
                dataEncryptionKey: true,
                active: true,
                lastActiveAt: true,
                accessKeys: {
                    select: { machineId: true },
                    take: 1
                }
                // messages: {
                //     orderBy: { seq: 'desc' },
                //     take: 1,
                //     select: {
                //         id: true,
                //         seq: true,
                //         content: true,
                //         localId: true,
                //         createdAt: true
                //     }
                // }
            }
        });

        const sessionIds = sessions.map((v) => v.id);
        const messageCounts = sessionIds.length
            ? await db.plaintextMessage.groupBy({
                  by: ['sessionId'],
                  where: { sessionId: { in: sessionIds } },
                  _count: { sessionId: true }
              })
            : [];
        const countMap = new Map(messageCounts.map((c) => [c.sessionId, c._count.sessionId]));

        const machineIds = sessions
            .map((v) => v.accessKeys[0]?.machineId)
            .filter((id): id is string => Boolean(id));
        const tokenLabels = new Map<string, string>();
        if (machineIds.length) {
            const tokens = await db.bootstrapToken.findMany({
                where: { accountId: userId, machineId: { in: machineIds } },
                select: { machineId: true, label: true }
            });
            tokens.forEach((t) => {
                if (t.label && t.machineId) tokenLabels.set(t.machineId, t.label);
            });
        }

        return reply.send({
            sessions: sessions.map((v) => {
                // const lastMessage = v.messages[0];
                const sessionUpdatedAt = v.updatedAt.getTime();
                // const lastMessageCreatedAt = lastMessage ? lastMessage.createdAt.getTime() : 0;
                const msgCount = countMap.get(v.id) || 0;
                const machineId = v.accessKeys[0]?.machineId || null;
                const machineLabel = machineId ? tokenLabels.get(machineId) || null : null;
                let metaDeviceName: string | null = null;
                try {
                    const parsed = JSON.parse(v.metadata || '{}');
                    metaDeviceName = (parsed && typeof parsed.deviceName === 'string' && parsed.deviceName) || null;
                } catch { /* metadata may be a plain string */ }

                return {
                    id: v.id,
                    seq: v.seq,
                    createdAt: v.createdAt.getTime(),
                    updatedAt: sessionUpdatedAt,
                    tag: v.tag,
                    active: v.active,
                    activeAt: v.lastActiveAt.getTime(),
                    metadata: v.metadata,
                    metadataVersion: v.metadataVersion,
                    agentState: v.agentState,
                    agentStateVersion: v.agentStateVersion,
                    dataEncryptionKey: v.dataEncryptionKey ? Buffer.from(v.dataEncryptionKey).toString('base64') : null,
                    lastMessage: null,
                    machineId: machineId,
                    machineName: machineLabel || metaDeviceName || v.tag,
                    msgCount: msgCount,
                    isPlaintext: msgCount > 0
                };
            })
        });
    });

    // V2 Sessions API - Active sessions only
    app.get('/v2/sessions/active', {
        preHandler: app.authenticate,
        schema: {
            querystring: z.object({
                limit: z.coerce.number().int().min(1).max(500).default(150)
            }).optional()
        }
    }, async (request, reply) => {
        const userId = request.userId;
        const limit = request.query?.limit || 150;

        const sessions = await db.session.findMany({
            where: {
                accountId: userId,
                active: true,
                lastActiveAt: { gt: new Date(Date.now() - 1000 * 60 * 15) /* 15 minutes */ }
            },
            orderBy: { lastActiveAt: 'desc' },
            take: limit,
            select: {
                id: true,
                seq: true,
                createdAt: true,
                updatedAt: true,
                metadata: true,
                metadataVersion: true,
                agentState: true,
                agentStateVersion: true,
                dataEncryptionKey: true,
                active: true,
                lastActiveAt: true,
            }
        });

        return reply.send({
            sessions: sessions.map((v) => ({
                id: v.id,
                seq: v.seq,
                createdAt: v.createdAt.getTime(),
                updatedAt: v.updatedAt.getTime(),
                active: v.active,
                activeAt: v.lastActiveAt.getTime(),
                metadata: v.metadata,
                metadataVersion: v.metadataVersion,
                agentState: v.agentState,
                agentStateVersion: v.agentStateVersion,
                dataEncryptionKey: v.dataEncryptionKey ? Buffer.from(v.dataEncryptionKey).toString('base64') : null,
            }))
        });
    });

    // V2 Sessions API - Cursor-based pagination with change tracking
    app.get('/v2/sessions', {
        preHandler: app.authenticate,
        schema: {
            querystring: z.object({
                cursor: z.string().optional(),
                limit: z.coerce.number().int().min(1).max(200).default(50),
                changedSince: z.coerce.number().int().positive().optional()
            }).optional()
        }
    }, async (request, reply) => {
        const userId = request.userId;
        const { cursor, limit = 50, changedSince } = request.query || {};

        // Decode cursor - simple ID-based cursor
        let cursorSessionId: string | undefined;
        if (cursor) {
            if (cursor.startsWith('cursor_v1_')) {
                cursorSessionId = cursor.substring(10);
            } else {
                return reply.code(400).send({ error: 'Invalid cursor format' });
            }
        }

        // Build where clause
        const where: Prisma.SessionWhereInput = { accountId: userId };

        // Add changedSince filter (just a filter, doesn't affect pagination)
        if (changedSince) {
            where.updatedAt = {
                gt: new Date(changedSince)
            };
        }

        // Add cursor pagination - always by ID descending (most recent first)
        if (cursorSessionId) {
            where.id = {
                lt: cursorSessionId  // Get sessions with ID less than cursor (for desc order)
            };
        }

        // Always sort by ID descending for consistent pagination
        const orderBy = { id: 'desc' as const };

        const sessions = await db.session.findMany({
            where,
            orderBy,
            take: limit + 1, // Fetch one extra to determine if there are more
            select: {
                id: true,
                seq: true,
                createdAt: true,
                updatedAt: true,
                metadata: true,
                metadataVersion: true,
                agentState: true,
                agentStateVersion: true,
                dataEncryptionKey: true,
                active: true,
                lastActiveAt: true,
            }
        });

        // Check if there are more results
        const hasNext = sessions.length > limit;
        const resultSessions = hasNext ? sessions.slice(0, limit) : sessions;

        // Generate next cursor - simple ID-based cursor
        let nextCursor: string | null = null;
        if (hasNext && resultSessions.length > 0) {
            const lastSession = resultSessions[resultSessions.length - 1];
            nextCursor = `cursor_v1_${lastSession.id}`;
        }

        return reply.send({
            sessions: resultSessions.map((v) => ({
                id: v.id,
                seq: v.seq,
                createdAt: v.createdAt.getTime(),
                updatedAt: v.updatedAt.getTime(),
                active: v.active,
                activeAt: v.lastActiveAt.getTime(),
                metadata: v.metadata,
                metadataVersion: v.metadataVersion,
                agentState: v.agentState,
                agentStateVersion: v.agentStateVersion,
                dataEncryptionKey: v.dataEncryptionKey ? Buffer.from(v.dataEncryptionKey).toString('base64') : null,
            })),
            nextCursor,
            hasNext
        });
    });

    // Create or load session by tag
    app.post('/v1/sessions', {
        schema: {
            body: z.object({
                tag: z.string(),
                metadata: z.string(),
                agentState: z.string().nullish(),
                dataEncryptionKey: z.string().nullish()
            })
        },
        preHandler: app.authenticate
    }, async (request, reply) => {
        const userId = request.userId;
        const { tag, metadata, dataEncryptionKey } = request.body;

        const session = await db.session.findFirst({
            where: {
                accountId: userId,
                tag: tag
            }
        });
        if (session) {
            log({ module: 'session-create', sessionId: session.id, userId, tag }, `Found existing session: ${session.id} for tag ${tag}`);
            return reply.send({
                session: {
                    id: session.id,
                    seq: session.seq,
                    metadata: session.metadata,
                    metadataVersion: session.metadataVersion,
                    agentState: session.agentState,
                    agentStateVersion: session.agentStateVersion,
                    dataEncryptionKey: session.dataEncryptionKey ? Buffer.from(session.dataEncryptionKey).toString('base64') : null,
                    active: session.active,
                    activeAt: session.lastActiveAt.getTime(),
                    createdAt: session.createdAt.getTime(),
                    updatedAt: session.updatedAt.getTime(),
                    lastMessage: null
                }
            });
        } else {

            // Resolve seq
            const updSeq = await allocateUserSeq(userId);

            // Create session
            log({ module: 'session-create', userId, tag }, `Creating new session for user ${userId} with tag ${tag}`);
            const session = await db.session.create({
                data: {
                    accountId: userId,
                    tag: tag,
                    metadata: metadata,
                    dataEncryptionKey: dataEncryptionKey ? new Uint8Array(Buffer.from(dataEncryptionKey, 'base64')) : undefined
                }
            });
            log({ module: 'session-create', sessionId: session.id, userId }, `Session created: ${session.id}`);

            // Emit new session update
            const updatePayload = buildNewSessionUpdate(session, updSeq, randomKeyNaked(12));
            log({
                module: 'session-create',
                userId,
                sessionId: session.id,
                updateType: 'new-session',
                updatePayload: JSON.stringify(updatePayload)
            }, `Emitting new-session update to user-scoped connections`);
            eventRouter.emitUpdate({
                userId,
                payload: updatePayload,
                recipientFilter: { type: 'user-scoped-only' }
            });

            return reply.send({
                session: {
                    id: session.id,
                    seq: session.seq,
                    metadata: session.metadata,
                    metadataVersion: session.metadataVersion,
                    agentState: session.agentState,
                    agentStateVersion: session.agentStateVersion,
                    dataEncryptionKey: session.dataEncryptionKey ? Buffer.from(session.dataEncryptionKey).toString('base64') : null,
                    active: session.active,
                    activeAt: session.lastActiveAt.getTime(),
                    createdAt: session.createdAt.getTime(),
                    updatedAt: session.updatedAt.getTime(),
                    lastMessage: null
                }
            });
        }
    });

    // Update a session's tag (used by ccd daemon to align the tag with the
    // claudeSessionId once claude reveals it after the first message)
    app.patch('/v1/sessions/:sessionId/tag', {
        schema: {
            params: z.object({
                sessionId: z.string()
            }),
            body: z.object({
                tag: z.string().min(1)
            })
        },
        preHandler: app.authenticate
    }, async (request, reply) => {
        const userId = request.userId;
        const { sessionId } = request.params;
        const { tag } = request.body;

        const session = await db.session.findFirst({
            where: { id: sessionId, accountId: userId }
        });
        if (!session) {
            return reply.code(404).send({ error: 'Session not found' });
        }
        const conflict = await db.session.findFirst({
            where: { accountId: userId, tag, id: { not: sessionId } }
        });
        if (conflict) {
            return reply.code(409).send({ error: 'Tag already in use', sessionId: conflict.id });
        }
        await db.session.update({
            where: { id: sessionId },
            data: { tag }
        });
        return reply.send({ ok: true });
    });

    // Update session fields (currently only `active`, used by the web UI to
    // archive/unarchive sessions)
    app.patch('/v1/sessions/:sessionId', {
        schema: {
            params: z.object({
                sessionId: z.string()
            }),
            body: z.object({
                active: z.boolean().optional(),
                // Daemon-pushed display meta so titles survive page refreshes
                meta: z.object({
                    title: z.string().optional(),
                    claudeSessionId: z.string().optional(),
                    cwd: z.string().optional(),
                    deviceName: z.string().optional(),
                    profile: z.string().optional(),
                }).optional()
            })
        },
        preHandler: app.authenticate
    }, async (request, reply) => {
        const userId = request.userId;
        const { sessionId } = request.params;
        const { active, meta } = request.body;

        const session = await db.session.findFirst({
            where: { id: sessionId, accountId: userId }
        });
        if (!session) {
            return reply.code(404).send({ error: 'Session not found' });
        }
        if (typeof active === 'boolean') {
            await db.session.update({
                where: { id: sessionId },
                data: { active }
            });
        }
        if (meta) {
            // metadata column is a free-form string; historically the plain
            // hostname. Preserve it under {hostname} when upgrading to JSON.
            let existing: Record<string, any> = {};
            try {
                existing = JSON.parse(session.metadata || '{}');
            } catch {
                existing = session.metadata ? { hostname: session.metadata } : {};
            }
            await db.session.update({
                where: { id: sessionId },
                data: { metadata: JSON.stringify({ ...existing, ...meta }) }
            });
        }
        return reply.send({ ok: true });
    });

    app.get('/v1/sessions/:sessionId/messages', {
        schema: {
            params: z.object({
                sessionId: z.string()
            })
        },
        preHandler: app.authenticate
    }, async (request, reply) => {
        const userId = request.userId;
        const { sessionId } = request.params;

        // Verify session belongs to user
        const session = await db.session.findFirst({
            where: {
                id: sessionId,
                accountId: userId
            }
        });

        if (!session) {
            return reply.code(404).send({ error: 'Session not found' });
        }

        const messages = await db.sessionMessage.findMany({
            where: { sessionId },
            orderBy: { createdAt: 'desc' },
            take: 150,
            select: {
                id: true,
                seq: true,
                localId: true,
                content: true,
                createdAt: true,
                updatedAt: true
            }
        });

        return reply.send({
            messages: messages.map((v) => ({
                id: v.id,
                seq: v.seq,
                content: v.content,
                localId: v.localId,
                createdAt: v.createdAt.getTime(),
                updatedAt: v.updatedAt.getTime()
            }))
        });
    });

    // Archive session (force deactivate)
    app.post('/v1/sessions/:sessionId/archive', {
        schema: {
            params: z.object({
                sessionId: z.string()
            })
        },
        preHandler: app.authenticate
    }, async (request, reply) => {
        const userId = request.userId;
        const { sessionId } = request.params;

        const result = await db.session.updateMany({
            where: { id: sessionId, accountId: userId },
            data: { active: false, lastActiveAt: new Date() }
        });

        if (result.count === 0) {
            return reply.code(404).send({ error: 'Session not found' });
        }

        // Notify all clients about the session deactivation
        const sessionActivity = buildSessionActivityEphemeral(sessionId, false, Date.now(), false);
        eventRouter.emitEphemeral({
            userId,
            payload: sessionActivity,
            recipientFilter: { type: 'user-scoped-only' }
        });

        return reply.send({ success: true });
    });

    // Plaintext messages — for ccd sessions (no E2E encryption)
    app.get('/v1/sessions/:sessionId/plaintext-messages', {
        preHandler: app.authenticate,
        schema: {
            params: z.object({ sessionId: z.string() }),
            querystring: z.object({
                after: z.string().optional(),
                role: z.string().optional(),
                limit: z.coerce.number().int().min(1).max(200).default(200),
            }).optional(),
        },
    }, async (request, reply) => {
        const query = request.query as { after?: string; role?: string; limit?: number } | undefined;
        const where: any = {
            sessionId: request.params.sessionId,
        };
        if (query?.role) where.role = query.role;
        // Cursor pagination: `after` is a message id, but ids are random cuids
        // while ordering is by createdAt — resolve the cursor's timestamp first
        // (with id tiebreak for same-millisecond batches).
        let orderBy: any = { createdAt: 'asc' as const };
        if (query?.after) {
            const cursor = await db.plaintextMessage.findUnique({
                where: { id: query.after },
                select: { createdAt: true },
            });
            if (cursor) {
                where.OR = [
                    { createdAt: { gt: cursor.createdAt } },
                    { createdAt: cursor.createdAt, id: { gt: query.after } },
                ];
                orderBy = [{ createdAt: 'asc' as const }, { id: 'asc' as const }];
            }
        }

        const messages = await db.plaintextMessage.findMany({
            where,
            orderBy,
            take: query?.limit || 200,
        });
        return reply.send({
            messages: messages.map((m) => ({
                id: m.id,
                role: m.role,
                content: m.content,
                metadata: m.metadata || null,
                createdAt: m.createdAt.getTime(),
            })),
        });
    });

    app.post('/v1/sessions/:sessionId/plaintext-messages', {
        preHandler: app.authenticate,
        schema: {
            params: z.object({ sessionId: z.string() }),
            body: z.object({
                role: z.string(),
                content: z.string(),
                metadata: z.object({
                    thinking: z.string().optional(),
                    thinkingMs: z.number().optional(),
                    bakedMs: z.number().optional(),
                    toolCalls: z.array(z.object({
                        name: z.string(),
                        args: z.record(z.string(), z.unknown()).optional(),
                        result: z.string().optional(),
                        durationMs: z.number().optional(),
                    })).optional(),
                    tokens: z.object({
                        input: z.number().optional(),
                        output: z.number().optional(),
                        cost: z.number().optional(),
                    }).optional(),
                    command: z.object({
                        name: z.string(),
                        args: z.string().optional(),
                    }).optional(),
                    toolResults: z.array(z.object({
                        content: z.string(),
                        isError: z.boolean().optional(),
                    })).optional(),
                }).optional(),
            }),
        },
    }, async (request, reply) => {
        // Orphan messages are invisible forever — the session must exist.
        // (Also what the ccd daemon relies on to detect web-side row deletion.)
        const session = await db.session.findFirst({
            where: { id: request.params.sessionId, accountId: request.userId },
            select: { id: true },
        });
        if (!session) {
            return reply.code(404).send({ error: 'Session not found' });
        }
        const msg = await db.plaintextMessage.create({
            data: {
                sessionId: request.params.sessionId,
                role: request.body.role,
                content: request.body.content,
                metadata: request.body.metadata || undefined,
            },
        });

        // Rolling per-session cap (cache semantics, not an archive): keep only
        // the newest MESSAGE_CAP_PER_SESSION (default 500) messages.
        const cap = parseInt(process.env.MESSAGE_CAP_PER_SESSION || '500', 10);
        const keep = await db.plaintextMessage.findMany({
            where: { sessionId: request.params.sessionId },
            orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
            take: cap,
            select: { id: true },
        });
        if (keep.length === cap) {
            await db.plaintextMessage.deleteMany({
                where: {
                    sessionId: request.params.sessionId,
                    id: { notIn: keep.map((m) => m.id) },
                },
            });
        }

        // Bump session activity so the web sidebar re-orders on new messages
        // (updatedAt is @updatedAt and moves automatically)
        await db.session.update({
            where: { id: request.params.sessionId },
            data: { lastActiveAt: new Date(), active: true },
        }).catch(() => {});

        // Realtime push to user-scoped connections (webui + ccd bridge)
        const updSeq = await allocateUserSeq(request.userId);
        eventRouter.emitUpdate({
            userId: request.userId,
            payload: {
                id: randomKeyNaked(12),
                seq: updSeq,
                body: {
                    t: 'plaintext-message',
                    sid: request.params.sessionId,
                    message: {
                        id: msg.id,
                        role: msg.role,
                        content: msg.content,
                        metadata: msg.metadata || null,
                        createdAt: msg.createdAt.getTime(),
                    },
                },
                createdAt: Date.now(),
            },
            recipientFilter: { type: 'user-scoped-only' },
        });

        return reply.send({ id: msg.id });
    });

    // Activity ping — daemon calls this while session is active
    app.post('/v1/sessions/:sessionId/activity', {
        preHandler: app.authenticate,
        schema: { params: z.object({ sessionId: z.string() }) },
    }, async (request, reply) => {
        await db.session.update({
            where: { id: request.params.sessionId },
            data: { lastActiveAt: new Date(), active: true },
        }).catch(() => {}); // session may not exist yet — ignore
        return reply.send({ ok: true });
    });

    // Delete session
    app.delete('/v1/sessions/:sessionId', {
        schema: {
            params: z.object({
                sessionId: z.string()
            })
        },
        preHandler: app.authenticate
    }, async (request, reply) => {
        const userId = request.userId;
        const { sessionId } = request.params;

        const deleted = await sessionDelete({ uid: userId }, sessionId);

        if (!deleted) {
            return reply.code(404).send({ error: 'Session not found or not owned by user' });
        }

        return reply.send({ success: true });
    });

    // Bulk delete sessions for this account. Server-side records only — the
    // host's claude conversations (jsonl) and daemon are untouched; a still
    // running session simply reappears when its daemon next posts.
    app.delete('/v1/sessions', {
        preHandler: app.authenticate
    }, async (request, reply) => {
        const userId = request.userId;
        const sessions = await db.session.findMany({
            where: { accountId: userId },
            select: { id: true },
        });
        let deleted = 0;
        for (const s of sessions) {
            if (await sessionDelete({ uid: userId }, s.id)) deleted++;
        }
        log({ module: 'session-delete', userId, deleted }, `Bulk deleted ${deleted} sessions`);
        return reply.send({ success: true, deleted });
    });
}