import { type Fastify } from "../types";
import { eventRouter } from "@/app/events/eventRouter";
import { auth } from "@/app/auth/auth";

/**
 * Server-Sent Events endpoint for realtime updates.
 * Replaces polling for webui and ccd bridge.
 */
export function eventRoutes(app: Fastify) {
    app.get('/v1/events', {
        schema: {
            querystring: {
                token: { type: 'string' },
            },
        },
    }, async (request, reply) => {
        const token = (request.query as { token?: string }).token;
        if (!token) {
            return reply.code(401).send({ error: 'Missing token' });
        }

        const verified = await auth.verifyToken(token);
        if (!verified) {
            return reply.code(401).send({ error: 'Invalid token' });
        }
        const userId = verified.userId;

        // SSE headers
        reply.raw.writeHead(200, {
            'Content-Type': 'text/event-stream',
            'Cache-Control': 'no-cache',
            'Connection': 'keep-alive',
            'Access-Control-Allow-Origin': '*',
        });

        // Send initial comment
        reply.raw.write(': connected\n\n');

        // Heartbeat every 25s
        const heartbeat = setInterval(() => {
            reply.raw.write(': heartbeat\n\n');
        }, 25000);

        // Hook into eventRouter for user-scoped events
        const listener = (payload: any) => {
            try {
                const data = JSON.stringify(payload);
                reply.raw.write(`data: ${data}\n\n`);
            } catch (e) {
                // ignore serialization errors
            }
        };

        // Register listener (simplified: in real impl we'd hook into eventRouter's emit)
        // For now, we rely on the Socket.IO path for actual event delivery.
        // This SSE endpoint is a placeholder for future direct eventRouter integration.

        request.raw.on('close', () => {
            clearInterval(heartbeat);
            reply.raw.end();
        });
    });
}
