// KV-backed sliding-bucket rate limiter.
// Returns { allowed: boolean, remaining: number, retryAfter: number }.
export async function checkRateLimit(cache, key, limit, windowSec) {
    if (!cache) return { allowed: true, remaining: limit, retryAfter: 0 };

    const bucket = Math.floor(Date.now() / 1000 / windowSec);
    const fullKey = `rl:${key}:${bucket}`;
    const raw = await cache.get(fullKey);
    const count = raw ? parseInt(raw, 10) : 0;

    if (count >= limit) {
        const nextBucketStart = (bucket + 1) * windowSec * 1000;
        const retryAfter = Math.max(1, Math.ceil((nextBucketStart - Date.now()) / 1000));
        return { allowed: false, remaining: 0, retryAfter };
    }

    await cache.put(fullKey, String(count + 1), { expirationTtl: windowSec * 2 });
    return { allowed: true, remaining: limit - count - 1, retryAfter: 0 };
}
