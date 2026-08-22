import * as privacyKit from "privacy-kit";
import { log } from "@/utils/log";
import { db } from "@/storage/db";

/** Cache entries expire after 24 hours */
const TOKEN_CACHE_TTL = 24 * 60 * 60 * 1000;
/** Hard cap to prevent unbounded growth */
const MAX_CACHE_SIZE = 10_000;
/** Run cleanup every 10 minutes */
const CLEANUP_INTERVAL = 10 * 60 * 1000;
/** Account-existence results are cached briefly so hot paths don't hit the DB */
const ACCOUNT_CACHE_TTL = 60 * 1000;

interface TokenCacheEntry {
    userId: string;
    extras?: any;
    cachedAt: number;
}

interface AuthTokens {
    generator: Awaited<ReturnType<typeof privacyKit.createPersistentTokenGenerator>>;
    verifier: Awaited<ReturnType<typeof privacyKit.createPersistentTokenVerifier>>;
    githubVerifier: Awaited<ReturnType<typeof privacyKit.createEphemeralTokenVerifier>>;
    githubGenerator: Awaited<ReturnType<typeof privacyKit.createEphemeralTokenGenerator>>;
}

class AuthModule {
    private tokenCache = new Map<string, TokenCacheEntry>();
    private accountCache = new Map<string, { exists: boolean; at: number }>();
    private tokens: AuthTokens | null = null;
    private cleanupTimer: ReturnType<typeof setInterval> | null = null;

    // A token whose account was deleted must stop working — the signature alone
    // is not enough. Cached 60s to keep hot paths off the DB.
    private async accountExists(userId: string): Promise<boolean> {
        const cached = this.accountCache.get(userId);
        if (cached && Date.now() - cached.at < ACCOUNT_CACHE_TTL) {
            return cached.exists;
        }
        const account = await db.account.findUnique({
            where: { id: userId },
            select: { id: true }
        });
        const exists = !!account;
        this.accountCache.set(userId, { exists, at: Date.now() });
        return exists;
    }

    async init(): Promise<void> {
        if (this.tokens) {
            return; // Already initialized
        }

        log({ module: 'auth' }, 'Initializing auth module...');

        const generator = await privacyKit.createPersistentTokenGenerator({
            service: 'handy',
            seed: process.env.HANDY_MASTER_SECRET!
        });


        const verifier = await privacyKit.createPersistentTokenVerifier({
            service: 'handy',
            publicKey: Uint8Array.from(generator.publicKey)
        });

        const githubGenerator = await privacyKit.createEphemeralTokenGenerator({
            service: 'github-happy',
            seed: process.env.HANDY_MASTER_SECRET!,
            ttl: 5 * 60 * 1000 // 5 minutes
        });

        const githubVerifier = await privacyKit.createEphemeralTokenVerifier({
            service: 'github-happy',
            publicKey: Uint8Array.from(githubGenerator.publicKey),
        });


        this.tokens = { generator, verifier, githubVerifier, githubGenerator };

        // Start periodic cleanup of expired cache entries
        this.cleanupTimer = setInterval(() => this.cleanup(), CLEANUP_INTERVAL);

        log({ module: 'auth' }, 'Auth module initialized');
    }
    
    async createToken(userId: string, extras?: any): Promise<string> {
        if (!this.tokens) {
            throw new Error('Auth module not initialized');
        }
        
        const payload: any = { user: userId };
        if (extras) {
            payload.extras = extras;
        }
        
        const token = await this.tokens.generator.new(payload);
        
        // Cache the token immediately
        this.tokenCache.set(token, {
            userId,
            extras,
            cachedAt: Date.now()
        });
        
        return token;
    }
    
    async verifyToken(token: string): Promise<{ userId: string; extras?: any } | null> {
        // Check cache first (with TTL)
        const cached = this.tokenCache.get(token);
        if (cached) {
            if (Date.now() - cached.cachedAt > TOKEN_CACHE_TTL) {
                this.tokenCache.delete(token);
            } else if (await this.accountExists(cached.userId)) {
                // Cache hit is only valid while the account still exists
                // (accountCache has a short TTL, so this stays cheap).
                return {
                    userId: cached.userId,
                    extras: cached.extras
                };
            } else {
                this.tokenCache.delete(token);
                return null;
            }
        }
        
        // Cache miss - verify token
        if (!this.tokens) {
            throw new Error('Auth module not initialized');
        }
        
        try {
            const verified = await this.tokens.verifier.verify(token);
            if (!verified) {
                return null;
            }
            
            const userId = verified.user as string;
            const extras = verified.extras;

            if (!(await this.accountExists(userId))) {
                return null;
            }
            
            // Evict oldest entries if cache is at capacity
            if (this.tokenCache.size >= MAX_CACHE_SIZE) {
                const oldest = [...this.tokenCache.entries()]
                    .sort((a, b) => a[1].cachedAt - b[1].cachedAt)
                    .slice(0, Math.floor(MAX_CACHE_SIZE * 0.2));
                for (const [key] of oldest) {
                    this.tokenCache.delete(key);
                }
            }

            this.tokenCache.set(token, {
                userId,
                extras,
                cachedAt: Date.now()
            });
            
            return { userId, extras };
            
        } catch (error) {
            log({ module: 'auth', level: 'error' }, `Token verification failed: ${error}`);
            return null;
        }
    }
    
    invalidateUserTokens(userId: string): void {
        // Remove all tokens for a specific user
        // This is expensive but rarely needed
        for (const [token, entry] of this.tokenCache.entries()) {
            if (entry.userId === userId) {
                this.tokenCache.delete(token);
            }
        }
        this.accountCache.delete(userId);
        
        log({ module: 'auth' }, `Invalidated tokens for user: ${userId}`);
    }
    
    invalidateToken(token: string): void {
        this.tokenCache.delete(token);
    }
    
    getCacheStats(): { size: number; oldestEntry: number | null } {
        if (this.tokenCache.size === 0) {
            return { size: 0, oldestEntry: null };
        }
        
        let oldest = Date.now();
        for (const entry of this.tokenCache.values()) {
            if (entry.cachedAt < oldest) {
                oldest = entry.cachedAt;
            }
        }
        
        return {
            size: this.tokenCache.size,
            oldestEntry: oldest
        };
    }
    
    async createGithubToken(userId: string): Promise<string> {
        if (!this.tokens) {
            throw new Error('Auth module not initialized');
        }
        
        const payload = { user: userId, purpose: 'github-oauth' };
        const token = await this.tokens.githubGenerator.new(payload);
        
        return token;
    }

    async verifyGithubToken(token: string): Promise<{ userId: string } | null> {
        if (!this.tokens) {
            throw new Error('Auth module not initialized');
        }
        
        try {
            const verified = await this.tokens.githubVerifier.verify(token);
            if (!verified) {
                return null;
            }
            
            return { userId: verified.user as string };
        } catch (error) {
            log({ module: 'auth', level: 'error' }, `GitHub token verification failed: ${error}`);
            return null;
        }
    }

    /** Remove expired entries from the cache */
    cleanup(): void {
        const now = Date.now();
        let removed = 0;
        for (const [token, entry] of this.tokenCache.entries()) {
            if (now - entry.cachedAt > TOKEN_CACHE_TTL) {
                this.tokenCache.delete(token);
                removed++;
            }
        }
        if (removed > 0) {
            log({ module: 'auth' }, `Token cache cleanup: removed ${removed}, remaining ${this.tokenCache.size}`);
        }
    }
}

// Global instance
export const auth = new AuthModule();