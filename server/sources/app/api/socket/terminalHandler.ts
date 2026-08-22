import { buildPermissionRequestEphemeral, buildPermissionResolvedEphemeral, buildTerminalMetaEphemeral, buildTerminalStateEphemeral, eventRouter } from "@/app/events/eventRouter";
import { log } from "@/utils/log";
import { Server, Socket } from "socket.io";

// === TERMINAL RELAY STATE ===
//
// In-memory registry of live terminal (PTY) sessions owned by node-ccd
// daemons (machine-scoped connections). Standalone mode is single-process,
// so a module-level Map is sufficient. Sessions survive daemon disconnects
// (state flips to 'offline', scrollback is kept) and exited sessions are
// kept so web clients can still join and read the replay buffer.

interface TermMeta {
    claudeSessionId?: string;
    title?: string;
    cwd?: string;
    deviceName?: string;
}

interface TermSession {
    userId: string;
    sessionId: string;
    ownerSocketId: string;   // daemon socket id
    meta: TermMeta;
    cols: number;
    rows: number;
    state: 'running' | 'exited' | 'offline';
    exitCode?: number;
    scrollback: string;      // replay buffer, truncated from the head
}

const SCROLLBACK_LIMIT = 256_000;

const termSessions = new Map<string, TermSession>();

// === PERMISSION RELAY STATE ===
//
// Pending tool-permission requests pushed by daemons, waiting for a web
// decision. Keyed by reqId; entries are removed on respond/resolve or when
// the owning daemon socket disconnects.

interface PendingPermission {
    userId: string;
    sessionId: string;
    reqId: string;
    toolName: string;
    input: any;
    ownerSocketId: string;   // daemon socket that raised the request
    at: number;
}

const pendingPermissions = new Map<string, PendingPermission>();

function termKey(userId: string, sessionId: string): string {
    return `${userId}:${sessionId}`;
}

function termRoom(userId: string, sessionId: string): string {
    return `term:${userId}:${sessionId}`;
}

function appendScrollback(session: TermSession, data: string): void {
    session.scrollback += data;
    if (session.scrollback.length > SCROLLBACK_LIMIT) {
        session.scrollback = session.scrollback.slice(session.scrollback.length - SCROLLBACK_LIMIT);
    }
}

export function terminalHandler(userId: string, socket: Socket, io: Server) {
    const clientType = socket.data.clientType as 'session-scoped' | 'user-scoped' | 'machine-scoped' | undefined;

    // === DAEMON -> SERVER ===

    socket.on('term:register', (data: any, callback: (response: any) => void) => {
        try {
            if (clientType !== 'machine-scoped') {
                if (callback) callback({ ok: false, error: 'machine-scoped connection required' });
                return;
            }
            const { sessionId, meta, cols, rows } = data ?? {};
            if (!sessionId || typeof sessionId !== 'string') {
                if (callback) callback({ ok: false, error: 'sessionId required' });
                return;
            }

            const key = termKey(userId, sessionId);
            const existing = termSessions.get(key);
            if (existing) {
                // Daemon reconnect re-registering: keep scrollback, take over ownership
                existing.ownerSocketId = socket.id;
                existing.state = 'running';
                existing.exitCode = undefined;
                if (meta && typeof meta === 'object') {
                    existing.meta = { ...existing.meta, ...meta };
                }
                if (typeof cols === 'number') existing.cols = cols;
                if (typeof rows === 'number') existing.rows = rows;
            } else {
                termSessions.set(key, {
                    userId,
                    sessionId,
                    ownerSocketId: socket.id,
                    meta: (meta && typeof meta === 'object') ? meta : {},
                    cols: typeof cols === 'number' ? cols : 80,
                    rows: typeof rows === 'number' ? rows : 24,
                    state: 'running',
                    scrollback: ''
                });
            }

            log({ module: 'websocket' }, `term:register sessionId=${sessionId} owner=${socket.id}`);
            const room = termRoom(userId, sessionId);
            const session = termSessions.get(key)!;
            io.to(room).emit('term:state', { sessionId, state: session.state });
            eventRouter.emitEphemeral({
                userId,
                payload: buildTerminalStateEphemeral(sessionId, session.state),
                recipientFilter: { type: 'user-scoped-only' }
            });
            if (callback) callback({ ok: true });
        } catch (error) {
            log({ module: 'websocket', level: 'error' }, `Error in term:register: ${error}`);
            if (callback) callback({ ok: false, error: 'internal error' });
        }
    });

    socket.on('term:output', (data: any) => {
        try {
            const { sessionId, data: chunk } = data ?? {};
            if (!sessionId || typeof chunk !== 'string') {
                return;
            }
            const session = termSessions.get(termKey(userId, sessionId));
            if (!session || session.ownerSocketId !== socket.id) {
                return; // only the owning daemon may push output
            }
            appendScrollback(session, chunk);
            io.to(termRoom(userId, sessionId)).emit('term:output', { sessionId, data: chunk });
        } catch (error) {
            log({ module: 'websocket', level: 'error' }, `Error in term:output: ${error}`);
        }
    });

    socket.on('term:state', (data: any) => {
        try {
            const { sessionId, state, exitCode } = data ?? {};
            if (!sessionId || (state !== 'running' && state !== 'exited')) {
                return;
            }
            const session = termSessions.get(termKey(userId, sessionId));
            if (!session || session.ownerSocketId !== socket.id) {
                return;
            }
            session.state = state;
            session.exitCode = typeof exitCode === 'number' ? exitCode : undefined;
            const payload = { sessionId, state: session.state, exitCode: session.exitCode };
            io.to(termRoom(userId, sessionId)).emit('term:state', payload);
            eventRouter.emitEphemeral({
                userId,
                payload: buildTerminalStateEphemeral(sessionId, session.state, session.exitCode),
                recipientFilter: { type: 'user-scoped-only' }
            });
        } catch (error) {
            log({ module: 'websocket', level: 'error' }, `Error in term:state: ${error}`);
        }
    });

    socket.on('term:meta', (data: any) => {
        try {
            const { sessionId, meta } = data ?? {};
            if (!sessionId || !meta || typeof meta !== 'object') {
                return;
            }
            const session = termSessions.get(termKey(userId, sessionId));
            if (!session || session.ownerSocketId !== socket.id) {
                return;
            }
            session.meta = { ...session.meta, ...meta };
            io.to(termRoom(userId, sessionId)).emit('term:meta', { sessionId, meta: session.meta });
            eventRouter.emitEphemeral({
                userId,
                payload: buildTerminalMetaEphemeral(sessionId, session.meta),
                recipientFilter: { type: 'user-scoped-only' }
            });
        } catch (error) {
            log({ module: 'websocket', level: 'error' }, `Error in term:meta: ${error}`);
        }
    });

    // === WEB -> SERVER ===

    socket.on('term:join', (data: any, callback: (response: any) => void) => {
        try {
            const { sessionId } = data ?? {};
            if (!sessionId || typeof sessionId !== 'string') {
                if (callback) callback({ ok: false, error: 'sessionId required' });
                return;
            }
            // Keying by this socket's userId enforces ownership: a web client
            // can only join sessions registered under its own account.
            const session = termSessions.get(termKey(userId, sessionId));
            if (!session) {
                if (callback) callback({ ok: false, error: 'session not found' });
                return;
            }
            socket.join(termRoom(userId, sessionId));
            if (callback) {
                callback({
                    ok: true,
                    scrollback: session.scrollback,
                    meta: session.meta,
                    cols: session.cols,
                    rows: session.rows,
                    state: session.state,
                    exitCode: session.exitCode
                });
            }
        } catch (error) {
            log({ module: 'websocket', level: 'error' }, `Error in term:join: ${error}`);
            if (callback) callback({ ok: false, error: 'internal error' });
        }
    });

    // Lightweight state query for the transcript view (which never joins the
    // terminal room but still needs the current state to enable its input box)
    socket.on('term:query-state', (data: any, callback: (response: any) => void) => {
        try {
            const { sessionId } = data ?? {};
            if (!sessionId || typeof sessionId !== 'string') {
                if (callback) callback({ ok: false, error: 'sessionId required' });
                return;
            }
            const session = termSessions.get(termKey(userId, sessionId));
            if (!session) {
                if (callback) callback({ ok: false, error: 'session not found' });
                return;
            }
            if (callback) {
                callback({
                    ok: true,
                    meta: session.meta,
                    state: session.state,
                    exitCode: session.exitCode
                });
            }
        } catch (error) {
            log({ module: 'websocket', level: 'error' }, `Error in term:query-state: ${error}`);
            if (callback) callback({ ok: false, error: 'internal error' });
        }
    });

    socket.on('term:leave', (data: any) => {
        try {
            const { sessionId } = data ?? {};
            if (!sessionId || typeof sessionId !== 'string') {
                return;
            }
            socket.leave(termRoom(userId, sessionId));
        } catch (error) {
            log({ module: 'websocket', level: 'error' }, `Error in term:leave: ${error}`);
        }
    });

    socket.on('term:input', (data: any) => {
        try {
            const { sessionId, data: input } = data ?? {};
            if (!sessionId || typeof input !== 'string') {
                return;
            }
            const session = termSessions.get(termKey(userId, sessionId));
            if (!session || session.state !== 'running') {
                return;
            }
            const owner = io.sockets.sockets.get(session.ownerSocketId);
            if (owner) {
                owner.emit('term:input', { sessionId, data: input });
            }
        } catch (error) {
            log({ module: 'websocket', level: 'error' }, `Error in term:input: ${error}`);
        }
    });

    socket.on('term:resize', (data: any) => {
        try {
            const { sessionId, cols, rows } = data ?? {};
            if (!sessionId || typeof cols !== 'number' || typeof rows !== 'number') {
                return;
            }
            const session = termSessions.get(termKey(userId, sessionId));
            if (!session || session.state !== 'running') {
                return;
            }
            session.cols = cols;
            session.rows = rows;
            const owner = io.sockets.sockets.get(session.ownerSocketId);
            if (owner) {
                owner.emit('term:resize', { sessionId, cols, rows });
            }
        } catch (error) {
            log({ module: 'websocket', level: 'error' }, `Error in term:resize: ${error}`);
        }
    });

    // === PERMISSION RELAY ===

    // Daemon asks for a tool permission decision
    socket.on('perm:request', (data: any) => {
        try {
            if (clientType !== 'machine-scoped') {
                return;
            }
            const { sessionId, reqId, toolName, input } = data ?? {};
            if (!sessionId || typeof sessionId !== 'string'
                || !reqId || typeof reqId !== 'string'
                || !toolName || typeof toolName !== 'string') {
                return;
            }
            const session = termSessions.get(termKey(userId, sessionId));
            if (!session || session.ownerSocketId !== socket.id) {
                return; // only the owning daemon may raise requests for a session
            }
            pendingPermissions.set(reqId, {
                userId,
                sessionId,
                reqId,
                toolName,
                input,
                ownerSocketId: socket.id,
                at: Date.now()
            });
            eventRouter.emitEphemeral({
                userId,
                payload: buildPermissionRequestEphemeral(sessionId, reqId, toolName, input),
                recipientFilter: { type: 'user-scoped-only' }
            });
            // Belt and braces: also notify sockets joined to the term room
            io.to(termRoom(userId, sessionId)).emit('perm:request', { sessionId, reqId, toolName, input });
        } catch (error) {
            log({ module: 'websocket', level: 'error' }, `Error in perm:request: ${error}`);
        }
    });

    // Web client answers a pending request
    socket.on('perm:respond', (data: any) => {
        try {
            const { reqId, decision } = data ?? {};
            if (!reqId || typeof reqId !== 'string' || (decision !== 'allow' && decision !== 'deny')) {
                return;
            }
            const pending = pendingPermissions.get(reqId);
            if (!pending || pending.userId !== userId) {
                return; // not ours — userId isolation
            }
            pendingPermissions.delete(reqId);
            const owner = io.sockets.sockets.get(pending.ownerSocketId);
            if (owner) {
                owner.emit('perm:respond', { reqId, decision });
            }
            eventRouter.emitEphemeral({
                userId,
                payload: buildPermissionResolvedEphemeral(reqId, decision, 'web'),
                recipientFilter: { type: 'user-scoped-only' }
            });
        } catch (error) {
            log({ module: 'websocket', level: 'error' }, `Error in perm:respond: ${error}`);
        }
    });

    // Daemon reports a request was settled without a web decision
    // (local approve, timeout, etc.) so web clients can drop the card
    socket.on('perm:resolve', (data: any) => {
        try {
            if (clientType !== 'machine-scoped') {
                return;
            }
            const { reqId, decision, source } = data ?? {};
            if (!reqId || typeof reqId !== 'string') {
                return;
            }
            const pending = pendingPermissions.get(reqId);
            if (!pending || pending.userId !== userId || pending.ownerSocketId !== socket.id) {
                return;
            }
            pendingPermissions.delete(reqId);
            eventRouter.emitEphemeral({
                userId,
                payload: buildPermissionResolvedEphemeral(
                    reqId,
                    (decision === 'allow' || decision === 'deny') ? decision : undefined,
                    (source === 'timeout' || source === 'local') ? source : 'local'
                ),
                recipientFilter: { type: 'user-scoped-only' }
            });
        } catch (error) {
            log({ module: 'websocket', level: 'error' }, `Error in perm:resolve: ${error}`);
        }
    });

    // Web client (re)loads and needs the current pending set
    socket.on('perm:list', (data: any, callback: (response: any) => void) => {
        try {
            const requests = [...pendingPermissions.values()]
                .filter((p) => p.userId === userId)
                .map((p) => ({
                    reqId: p.reqId,
                    sessionId: p.sessionId,
                    toolName: p.toolName,
                    input: p.input,
                    at: p.at
                }));
            if (callback) callback({ ok: true, requests });
        } catch (error) {
            log({ module: 'websocket', level: 'error' }, `Error in perm:list: ${error}`);
            if (callback) callback({ ok: false, error: 'internal error' });
        }
    });

    // === DISCONNECT CLEANUP ===

    socket.on('disconnect', () => {
        try {
            if (clientType !== 'machine-scoped') {
                return;
            }
            // Drop this daemon's pending permission requests and tell web
            // clients to clear the cards
            for (const pending of [...pendingPermissions.values()]) {
                if (pending.ownerSocketId !== socket.id) {
                    continue;
                }
                pendingPermissions.delete(pending.reqId);
                eventRouter.emitEphemeral({
                    userId,
                    payload: buildPermissionResolvedEphemeral(pending.reqId, undefined, 'daemon-disconnected'),
                    recipientFilter: { type: 'user-scoped-only' }
                });
            }
            // Mark every session owned by this daemon socket as offline.
            // Scrollback is preserved; a re-register on reconnect flips
            // the session back to 'running'.
            for (const session of termSessions.values()) {
                if (session.userId !== userId || session.ownerSocketId !== socket.id) {
                    continue;
                }
                session.state = 'offline';
                io.to(termRoom(userId, session.sessionId)).emit('term:state', {
                    sessionId: session.sessionId,
                    state: 'offline'
                });
                eventRouter.emitEphemeral({
                    userId,
                    payload: buildTerminalStateEphemeral(session.sessionId, 'offline'),
                    recipientFilter: { type: 'user-scoped-only' }
                });
            }
        } catch (error) {
            log({ module: 'websocket', level: 'error' }, `Error in terminal disconnect cleanup: ${error}`);
        }
    });
}
