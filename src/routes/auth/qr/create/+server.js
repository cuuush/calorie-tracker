import { json } from '@sveltejs/kit';
import { checkRateLimit } from '$lib/server/ratelimit';

/** @type {import('./$types').RequestHandler} */
export async function POST({ request, locals, platform }) {
    if (!locals.auth) {
        return json({ error: 'Server not initialized' }, { status: 500 });
    }

    const ip = request.headers.get('CF-Connecting-IP') || 'unknown';
    const ua = request.headers.get('User-Agent') || null;
    const country = request.headers.get('CF-IPCountry') || null;

    const cache = platform?.env?.CACHE;
    const perMinute = await checkRateLimit(cache, `qrcreate:${ip}`, 5, 60);
    if (!perMinute.allowed) {
        return json(
            { error: 'Too many requests. Try again in a moment.' },
            { status: 429, headers: { 'Retry-After': String(perMinute.retryAfter) } }
        );
    }
    const perHour = await checkRateLimit(cache, `qrcreateH:${ip}`, 30, 3600);
    if (!perHour.allowed) {
        return json(
            { error: 'Hourly limit reached. Try again later.' },
            { status: 429, headers: { 'Retry-After': String(perHour.retryAfter) } }
        );
    }

    const result = await locals.auth.createQrRequest({ ip, ua, country });
    return json(result);
}
