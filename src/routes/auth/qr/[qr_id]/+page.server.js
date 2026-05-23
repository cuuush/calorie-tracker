import { redirect, fail } from '@sveltejs/kit';

function parseUa(ua) {
    if (!ua) return 'Unknown device';
    let browser = 'Unknown browser';
    if (/Edg\//i.test(ua)) browser = 'Edge';
    else if (/Chrome\//i.test(ua) && !/Chromium/i.test(ua)) browser = 'Chrome';
    else if (/Firefox\//i.test(ua)) browser = 'Firefox';
    else if (/Safari\//i.test(ua)) browser = 'Safari';

    let os = 'Unknown OS';
    if (/Windows/i.test(ua)) os = 'Windows';
    else if (/Mac OS X/i.test(ua) || /Macintosh/i.test(ua)) os = 'macOS';
    else if (/iPhone|iPad|iPod/i.test(ua)) os = 'iOS';
    else if (/Android/i.test(ua)) os = 'Android';
    else if (/Linux/i.test(ua)) os = 'Linux';

    return `${browser} on ${os}`;
}

/** @type {import('./$types').PageServerLoad} */
export async function load({ params, locals, url }) {
    const qrId = params.qr_id;

    if (!locals.user) {
        const next = `/auth/qr/${encodeURIComponent(qrId)}`;
        throw redirect(303, `/login?next=${encodeURIComponent(next)}`);
    }

    const row = await locals.auth.getQrRequest(qrId);
    if (!row) {
        return { qrId, state: 'expired' };
    }

    const expired = new Date(row.expires_at) < new Date();
    if (expired) return { qrId, state: 'expired' };
    if (row.status === 'approved') return { qrId, state: 'already_approved' };
    if (row.status === 'denied') return { qrId, state: 'already_denied' };

    return {
        qrId,
        state: 'pending',
        email: locals.user.email,
        device: parseUa(row.created_ua),
        ip: row.created_ip,
        country: row.created_country,
        expiresAt: row.expires_at
    };
}

/** @type {import('./$types').Actions} */
export const actions = {
    approve: async ({ params, locals }) => {
        if (!locals.user) return fail(401, { error: 'Unauthorized' });
        const result = await locals.auth.approveQrRequest(params.qr_id, locals.user.id);
        if (result.error) return fail(400, { error: result.error });
        return { approved: true };
    },
    deny: async ({ params, locals }) => {
        if (!locals.user) return fail(401, { error: 'Unauthorized' });
        const result = await locals.auth.denyQrRequest(params.qr_id);
        if (result.error) return fail(400, { error: result.error });
        return { denied: true };
    }
};
