import { json } from '@sveltejs/kit';
import { checkRateLimit } from '$lib/server/ratelimit';

const MAX_BYTES = 20 * 1024 * 1024;
const ALLOWED_PREFIXES = ['image/', 'audio/'];

function extFromMime(mime) {
    if (!mime) return 'bin';
    const sub = mime.split('/')[1] || 'bin';
    return sub.split(';')[0].split('+')[0];
}

function nano() {
    return Math.random().toString(36).slice(2, 10) + Date.now().toString(36);
}

/** @type {import('./$types').RequestHandler} */
export async function POST({ request, locals, platform, getClientAddress }) {
    if (!locals.user) {
        return json({ error: 'Unauthorized' }, { status: 401 });
    }

    const ip = getClientAddress?.() || 'unknown';
    const rl = await checkRateLimit(platform?.env?.CACHE, `upload:${locals.user.id}:${ip}`, 60, 60);
    if (!rl.allowed) {
        return json({ error: 'Too many uploads, try again shortly' }, { status: 429 });
    }

    const form = await request.formData();
    const file = form.get('file');
    if (!file || typeof file === 'string') {
        return json({ error: 'No file provided' }, { status: 400 });
    }

    if (file.size > MAX_BYTES) {
        return json({ error: 'File too large' }, { status: 413 });
    }

    const mime = file.type || 'application/octet-stream';
    if (!ALLOWED_PREFIXES.some((p) => mime.startsWith(p))) {
        return json({ error: 'Unsupported file type' }, { status: 415 });
    }

    const kind = mime.startsWith('image/') ? 'image' : 'audio';
    const ext = extFromMime(mime);
    const key = `pending/${locals.user.id}/${nano()}-${kind}.${ext}`;

    const buffer = await file.arrayBuffer();
    await platform.env.IMAGES.put(key, buffer, {
        httpMetadata: { contentType: mime }
    });

    // Stale pending uploads (client-side DELETE missed due to tab-close, network
    // failure, crash) are reaped by the R2 lifecycle rule on the `pending/` prefix —
    // see wrangler.toml. No in-band sweep needed.
    return json({ key, kind, mime, size: file.size });
}

/** @type {import('./$types').RequestHandler} */
export async function DELETE({ request, locals, platform }) {
    if (!locals.user) {
        return json({ error: 'Unauthorized' }, { status: 401 });
    }

    const { key } = await request.json();
    if (!key || typeof key !== 'string') {
        return json({ error: 'Missing key' }, { status: 400 });
    }

    const prefix = `pending/${locals.user.id}/`;
    if (!key.startsWith(prefix)) {
        return json({ error: 'Forbidden' }, { status: 403 });
    }

    await platform.env.IMAGES.delete(key);
    return json({ ok: true });
}
