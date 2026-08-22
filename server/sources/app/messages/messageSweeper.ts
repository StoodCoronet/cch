import { db } from "@/storage/db";
import { delay } from "@/utils/delay";
import { forever } from "@/utils/forever";
import { shutdownSignal } from "@/utils/shutdown";
import { log } from "@/utils/log";

// PlaintextMessage rows are a rolling cache, not an archive. This sweeper
// deletes messages older than MESSAGE_TTL_DAYS (default 30) once an hour.
// The per-session rolling cap is enforced at insert time in sessionRoutes.
export function startMessageSweeper() {
    const ttlDays = parseInt(process.env.MESSAGE_TTL_DAYS || '30', 10);
    forever('message-sweeper', async () => {
        while (true) {
            const cutoff = new Date(Date.now() - ttlDays * 24 * 60 * 60 * 1000);
            const result = await db.plaintextMessage.deleteMany({
                where: { createdAt: { lt: cutoff } }
            });
            if (result.count > 0) {
                log({ module: 'message-sweeper' }, `Deleted ${result.count} messages older than ${ttlDays} days`);
            }

            // Run once per hour
            await delay(1000 * 60 * 60, shutdownSignal);
        }
    });
}
