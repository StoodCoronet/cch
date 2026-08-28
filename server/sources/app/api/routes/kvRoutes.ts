import { z } from "zod";
import { Fastify } from "../types";
import { db } from "@/storage/db";
import { kvList } from "@/app/kv/kvList";
import { kvBulkGet } from "@/app/kv/kvBulkGet";
import { kvMutate } from "@/app/kv/kvMutate";
import { log } from "@/utils/log";

export function kvRoutes(app: Fastify) {
    // Keys allowed for the simple string KV endpoints below
    const kvKeySchema = z.string().regex(/^[a-zA-Z0-9:_-]{1,128}$/);

    // GET /v1/kv/:key - Get single value as a plain string.
    // Always 200: { value: string | null }, null when the key is missing or deleted.
    app.get('/v1/kv/:key', {
        preHandler: app.authenticate,
        schema: {
            params: z.object({
                key: kvKeySchema
            })
        }
    }, async (request, reply) => {
        const userId = request.userId;
        const { key } = request.params;

        const result = await db.userKVStore.findUnique({
            where: {
                accountId_key: {
                    accountId: userId,
                    key
                }
            }
        });

        return reply.send({
            value: result?.value ? Buffer.from(result.value).toString('utf8') : null
        });
    });

    // PUT /v1/kv/:key - Upsert a plain string value (max 4KB)
    app.put('/v1/kv/:key', {
        preHandler: app.authenticate,
        schema: {
            params: z.object({
                key: kvKeySchema
            }),
            body: z.object({
                value: z.string().max(4096)
            })
        }
    }, async (request, reply) => {
        const userId = request.userId;
        const { key } = request.params;
        const { value } = request.body;

        await db.userKVStore.upsert({
            where: {
                accountId_key: {
                    accountId: userId,
                    key
                }
            },
            create: {
                accountId: userId,
                key,
                value: Buffer.from(value, 'utf8'),
                version: 0
            },
            update: {
                value: Buffer.from(value, 'utf8'),
                version: { increment: 1 }
            }
        });

        return reply.send({ ok: true });
    });

    // GET /v1/kv - List key-value pairs with optional prefix filter
    app.get('/v1/kv', {
        preHandler: app.authenticate,
        schema: {
            querystring: z.object({
                prefix: z.string().optional(),
                limit: z.coerce.number().int().min(1).max(1000).default(100)
            }),
            response: {
                200: z.object({
                    items: z.array(z.object({
                        key: z.string(),
                        value: z.string(),
                        version: z.number()
                    }))
                }),
                500: z.object({
                    error: z.literal('Failed to list items')
                })
            }
        }
    }, async (request, reply) => {
        const userId = request.userId;
        const { prefix, limit } = request.query;

        try {
            const result = await kvList({ uid: userId }, { prefix, limit });
            return reply.send(result);
        } catch (error) {
            log({ module: 'api', level: 'error' }, `Failed to list KV items: ${error}`);
            return reply.code(500).send({ error: 'Failed to list items' });
        }
    });

    // POST /v1/kv/bulk - Bulk get values
    app.post('/v1/kv/bulk', {
        preHandler: app.authenticate,
        schema: {
            body: z.object({
                keys: z.array(z.string()).min(1).max(100)
            }),
            response: {
                200: z.object({
                    values: z.array(z.object({
                        key: z.string(),
                        value: z.string(),
                        version: z.number()
                    }))
                }),
                500: z.object({
                    error: z.literal('Failed to get values')
                })
            }
        }
    }, async (request, reply) => {
        const userId = request.userId;
        const { keys } = request.body;

        try {
            const result = await kvBulkGet({ uid: userId }, keys);
            return reply.send(result);
        } catch (error) {
            log({ module: 'api', level: 'error' }, `Failed to bulk get KV values: ${error}`);
            return reply.code(500).send({ error: 'Failed to get values' });
        }
    });

    // PUT /v1/kv - Atomic batch mutation
    app.post('/v1/kv', {
        preHandler: app.authenticate,
        schema: {
            body: z.object({
                mutations: z.array(z.object({
                    key: z.string(),
                    value: z.string().nullable(),
                    version: z.number()  // Always required, use -1 for new keys
                })).min(1).max(100)
            }),
            response: {
                200: z.object({
                    success: z.literal(true),
                    results: z.array(z.object({
                        key: z.string(),
                        version: z.number()
                    }))
                }),
                409: z.object({
                    success: z.literal(false),
                    errors: z.array(z.object({
                        key: z.string(),
                        error: z.literal('version-mismatch'),
                        version: z.number(),
                        value: z.string().nullable()
                    }))
                }),
                500: z.object({
                    error: z.literal('Failed to mutate values')
                })
            }
        }
    }, async (request, reply) => {
        const userId = request.userId;
        const { mutations } = request.body;

        try {
            const result = await kvMutate({ uid: userId }, mutations);

            if (!result.success) {
                return reply.code(409).send({
                    success: false as const,
                    errors: result.errors!
                });
            }

            return reply.send({
                success: true as const,
                results: result.results!
            });
        } catch (error) {
            log({ module: 'api', level: 'error' }, `Failed to mutate KV values: ${error}`);
            return reply.code(500).send({ error: 'Failed to mutate values' });
        }
    });
}