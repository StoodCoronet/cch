import { log } from "@/utils/log";
import { Server, Socket } from "socket.io";

// === WEB -> DAEMON RPC RELAY ===
//
// Downlink RPC channel: web clients emit `ccd:rpc` and the server forwards
// the request to the user's machine-scoped (daemon) sockets; the daemon
// replies with `ccd:rpc-result`, which the server routes back to the
// requesting web socket. Standalone mode is single-process, so module-level
// Maps are sufficient — same pattern as the terminal relay.

interface PendingRpc {
    userId: string;
    webSocketId: string;
    daemonSocketIds: string[];
    timer: ReturnType<typeof setTimeout>;
}

const RPC_TIMEOUT_MS = 30_000;

// userId -> daemon socketId -> machineId, for online machine-scoped connections
const daemonSockets = new Map<string, Map<string, string>>();
const pendingRpcs = new Map<string, PendingRpc>();

function settleRpc(reqId: string, pending: PendingRpc): void {
    clearTimeout(pending.timer);
    pendingRpcs.delete(reqId);
}

export function ccdRpcHandler(userId: string, socket: Socket, io: Server) {
    const clientType = socket.data.clientType as 'session-scoped' | 'user-scoped' | 'machine-scoped' | undefined;
    const machineId = socket.data.machineId as string | undefined;

    // Track daemon sockets so web RPCs can be routed to them
    if (clientType === 'machine-scoped') {
        let bySocketId = daemonSockets.get(userId);
        if (!bySocketId) {
            bySocketId = new Map();
            daemonSockets.set(userId, bySocketId);
        }
        bySocketId.set(socket.id, machineId ?? '');
    }

    // === WEB -> DAEMON ===

    socket.on('ccd:rpc', (data: any) => {
        try {
            const { reqId, machineId: targetMachineId, method, params } = data ?? {};
            if (!reqId || typeof reqId !== 'string' || !method || typeof method !== 'string') {
                return;
            }
            if (pendingRpcs.has(reqId)) {
                socket.emit('ccd:rpc-result', { reqId, error: 'duplicate reqId' });
                return;
            }

            const targets: string[] = [];
            const bySocketId = daemonSockets.get(userId);
            if (bySocketId) {
                for (const [daemonSocketId, daemonMachineId] of bySocketId) {
                    if (typeof targetMachineId === 'string' && targetMachineId && daemonMachineId !== targetMachineId) {
                        continue;
                    }
                    if (io.sockets.sockets.has(daemonSocketId)) {
                        targets.push(daemonSocketId);
                    }
                }
            }
            if (targets.length === 0) {
                socket.emit('ccd:rpc-result', { reqId, error: 'no daemon online' });
                return;
            }

            const timer = setTimeout(() => {
                const pending = pendingRpcs.get(reqId);
                if (!pending) {
                    return;
                }
                pendingRpcs.delete(reqId);
                const web = io.sockets.sockets.get(pending.webSocketId);
                if (web) {
                    web.emit('ccd:rpc-result', { reqId, error: 'timeout' });
                }
            }, RPC_TIMEOUT_MS);

            pendingRpcs.set(reqId, { userId, webSocketId: socket.id, daemonSocketIds: targets, timer });
            for (const daemonSocketId of targets) {
                io.sockets.sockets.get(daemonSocketId)?.emit('ccd:rpc', { reqId, method, params });
            }
            log({ module: 'websocket' }, `ccd:rpc reqId=${reqId} method=${method} targets=${targets.length}`);
        } catch (error) {
            log({ module: 'websocket', level: 'error' }, `Error in ccd:rpc: ${error}`);
        }
    });

    // === DAEMON -> WEB ===

    socket.on('ccd:rpc-result', (data: any) => {
        try {
            if (clientType !== 'machine-scoped') {
                return;
            }
            const { reqId, result, error } = data ?? {};
            if (!reqId || typeof reqId !== 'string') {
                return;
            }
            const pending = pendingRpcs.get(reqId);
            if (!pending || pending.userId !== userId || !pending.daemonSocketIds.includes(socket.id)) {
                return; // late/duplicate/foreign reply — first response already won
            }
            settleRpc(reqId, pending);
            const web = io.sockets.sockets.get(pending.webSocketId);
            if (web) {
                if (error !== undefined && error !== null) {
                    web.emit('ccd:rpc-result', { reqId, error });
                } else {
                    web.emit('ccd:rpc-result', { reqId, result });
                }
            }
        } catch (err) {
            log({ module: 'websocket', level: 'error' }, `Error in ccd:rpc-result: ${err}`);
        }
    });

    // === DISCONNECT CLEANUP ===

    socket.on('disconnect', () => {
        try {
            if (clientType === 'machine-scoped') {
                const bySocketId = daemonSockets.get(userId);
                if (bySocketId) {
                    bySocketId.delete(socket.id);
                    if (bySocketId.size === 0) {
                        daemonSockets.delete(userId);
                    }
                }
                // Fail pending requests that have no other daemon left to answer
                for (const [reqId, pending] of pendingRpcs) {
                    const index = pending.daemonSocketIds.indexOf(socket.id);
                    if (index === -1) {
                        continue;
                    }
                    pending.daemonSocketIds.splice(index, 1);
                    if (pending.daemonSocketIds.length === 0) {
                        settleRpc(reqId, pending);
                        const web = io.sockets.sockets.get(pending.webSocketId);
                        if (web) {
                            web.emit('ccd:rpc-result', { reqId, error: 'daemon disconnected' });
                        }
                    }
                }
            } else {
                // Web socket gone — drop its pending requests, no reply needed
                for (const [reqId, pending] of pendingRpcs) {
                    if (pending.webSocketId === socket.id) {
                        settleRpc(reqId, pending);
                    }
                }
            }
        } catch (error) {
            log({ module: 'websocket', level: 'error' }, `Error in ccd:rpc disconnect cleanup: ${error}`);
        }
    });
}
