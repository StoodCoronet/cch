import { db } from "@/storage/db";
import { Fastify } from "../types";
import { httpRequestsCounter, httpRequestDurationHistogram, getMetricsLabelsFromRequest } from "@/app/monitoring/metrics2";
import { log } from "@/utils/log";
import { readFileSync } from "node:fs";

// Single source of truth for the server version (bump on release)
const SERVER_VERSION = JSON.parse(readFileSync(process.cwd() + "/package.json", "utf-8")).version;

export function enableMonitoring(app: Fastify) {
    // Add metrics hooks
    app.addHook('onRequest', async (request, reply) => {
        request.startTime = Date.now();
    });

    app.addHook('onResponse', async (request, reply) => {
        const duration = (Date.now() - (request.startTime || Date.now())) / 1000;
        const method = request.method;
        // Use routeOptions.url for the route template, fallback to parsed URL path
        const route = request.routeOptions?.url || request.url.split('?')[0] || 'unknown';
        const status = reply.statusCode.toString();
        const labels = getMetricsLabelsFromRequest(request);

        // Increment request counter
        httpRequestsCounter.inc({ method, route, status, ...labels });

        // Record request duration
        httpRequestDurationHistogram.observe({ method, route, status, ...labels }, duration);
    });

    app.get('/health', async (request, reply) => {
        try {
            // Test database connectivity
            await db.$queryRaw`SELECT 1`;
            reply.send({
                status: 'ok',
                timestamp: new Date().toISOString(),
                service: 'happy-server',
                version: SERVER_VERSION
            });
        } catch (error) {
            log({ module: 'health', level: 'error' }, `Health check failed: ${error}`);
            reply.code(503).send({
                status: 'error',
                timestamp: new Date().toISOString(),
                service: 'happy-server',
                error: 'Database connectivity failed'
            });
        }
    });
}