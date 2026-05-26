import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { clearKV } from '../../tests/setup.js';
import { checkRateLimit } from './ratelimit.js';

let proxy;

beforeAll(async () => {
    const { getPlatformProxy } = await import('wrangler');
    proxy = await getPlatformProxy({ persist: false });
});

beforeEach(async () => {
    await clearKV(proxy.env.CACHE);
});

afterAll(async () => {
    await proxy.dispose();
});

describe('checkRateLimit', () => {
    it('returns allowed with full remaining when cache is null', async () => {
        const result = await checkRateLimit(null, 'user:1', 10, 60);
        expect(result).toEqual({ allowed: true, remaining: 10, retryAfter: 0 });
    });

    it('allows the first request', async () => {
        const result = await checkRateLimit(proxy.env.CACHE, 'test:first', 5, 60);
        expect(result.allowed).toBe(true);
        expect(result.remaining).toBe(4);
        expect(result.retryAfter).toBe(0);
    });

    it('decrements remaining with each request', async () => {
        const key = 'test:decrement';
        const limit = 5;
        const window = 60;

        const r1 = await checkRateLimit(proxy.env.CACHE, key, limit, window);
        expect(r1.remaining).toBe(4);

        const r2 = await checkRateLimit(proxy.env.CACHE, key, limit, window);
        expect(r2.remaining).toBe(3);

        const r3 = await checkRateLimit(proxy.env.CACHE, key, limit, window);
        expect(r3.remaining).toBe(2);
    });

    it('allows requests up to the limit', async () => {
        const key = 'test:limit';
        const limit = 3;
        const window = 60;

        for (let i = 0; i < limit; i++) {
            const result = await checkRateLimit(proxy.env.CACHE, key, limit, window);
            expect(result.allowed).toBe(true);
        }
    });

    it('denies requests exceeding the limit', async () => {
        const key = 'test:exceed';
        const limit = 2;
        const window = 60;

        // Use up the limit
        await checkRateLimit(proxy.env.CACHE, key, limit, window);
        await checkRateLimit(proxy.env.CACHE, key, limit, window);

        // Third request should be denied
        const result = await checkRateLimit(proxy.env.CACHE, key, limit, window);
        expect(result.allowed).toBe(false);
        expect(result.remaining).toBe(0);
    });

    it('returns retryAfter > 0 when denied', async () => {
        const key = 'test:retry';
        const limit = 1;
        const window = 60;

        await checkRateLimit(proxy.env.CACHE, key, limit, window);

        const denied = await checkRateLimit(proxy.env.CACHE, key, limit, window);
        expect(denied.allowed).toBe(false);
        expect(denied.retryAfter).toBeGreaterThan(0);
        expect(denied.retryAfter).toBeLessThanOrEqual(window);
    });

    it('uses different buckets for different keys', async () => {
        const window = 60;
        const limit = 1;

        const r1 = await checkRateLimit(proxy.env.CACHE, 'user:alice', limit, window);
        expect(r1.allowed).toBe(true);

        const r2 = await checkRateLimit(proxy.env.CACHE, 'user:bob', limit, window);
        expect(r2.allowed).toBe(true);

        // Alice is now rate-limited, but Bob used a different key
        const r3 = await checkRateLimit(proxy.env.CACHE, 'user:alice', limit, window);
        expect(r3.allowed).toBe(false);
    });

    it('handles a limit of 1 correctly', async () => {
        const key = 'test:one';
        const limit = 1;
        const window = 60;

        const first = await checkRateLimit(proxy.env.CACHE, key, limit, window);
        expect(first.allowed).toBe(true);
        expect(first.remaining).toBe(0);

        const second = await checkRateLimit(proxy.env.CACHE, key, limit, window);
        expect(second.allowed).toBe(false);
        expect(second.remaining).toBe(0);
    });

    it('retryAfter is at least 1 second', async () => {
        const key = 'test:minretry';
        const limit = 1;
        const window = 60;

        await checkRateLimit(proxy.env.CACHE, key, limit, window);

        const denied = await checkRateLimit(proxy.env.CACHE, key, limit, window);
        expect(denied.retryAfter).toBeGreaterThanOrEqual(1);
    });
});
