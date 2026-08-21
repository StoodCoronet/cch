/**
 * CORS origin whitelist from the ALLOWED_ORIGINS env var (comma-separated).
 * Returns false when unset, which disables CORS headers entirely — same-origin
 * browser requests (dashboard served by this server) and non-browser clients
 * (CLI, mobile app) are unaffected.
 */
export function getAllowedOrigins(): string[] | false {
    const origins = (process.env.ALLOWED_ORIGINS || '')
        .split(',')
        .map((o) => o.trim())
        .filter(Boolean);
    return origins.length > 0 ? origins : false;
}
