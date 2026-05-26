import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import {
    applySchema, resetAll,
    TEST_USER_ID, TEST_USER_EMAIL
} from '../../../../tests/setup.js';
import { Storage } from '../../../../lib/server/storage.js';

let proxy, storage;

const CRON_SECRET = 'test-cron-secret-abc123';

beforeAll(async () => {
    const { getPlatformProxy } = await import('wrangler');
    proxy = await getPlatformProxy({ persist: false });
    await applySchema(proxy.env.DB);
    storage = new Storage(proxy.env);
});

beforeEach(async () => {
    await resetAll(proxy.env);
});

afterAll(async () => {
    await proxy.dispose();
});

function createCronEvent(authHeader = null) {
    const headers = {};
    if (authHeader) {
        headers['authorization'] = authHeader;
    }

    return {
        request: new Request('http://localhost/api/cron/cleanup-uploads', {
            method: 'POST',
            headers
        }),
        locals: {
            storage
        },
        platform: {
            env: { ...proxy.env, CRON_SECRET }
        }
    };
}

describe('Cleanup uploads POST', () => {
    it('returns 401 without authorization header', async () => {
        const { POST } = await import('./+server.js');
        const event = createCronEvent();

        const response = await POST(event);
        expect(response.status).toBe(401);
        const data = await response.json();
        expect(data.error).toBe('Unauthorized');
    });

    it('returns 401 with wrong bearer token', async () => {
        const { POST } = await import('./+server.js');
        const event = createCronEvent('Bearer wrong-secret');

        const response = await POST(event);
        expect(response.status).toBe(401);
        const data = await response.json();
        expect(data.error).toBe('Unauthorized');
    });

    it('returns 401 with missing CRON_SECRET in env', async () => {
        const { POST } = await import('./+server.js');
        const event = createCronEvent(`Bearer ${CRON_SECRET}`);
        // Remove CRON_SECRET from env
        event.platform.env = { ...proxy.env };
        delete event.platform.env.CRON_SECRET;

        const response = await POST(event);
        expect(response.status).toBe(401);
    });

    it('returns 401 with non-Bearer auth format', async () => {
        const { POST } = await import('./+server.js');
        const event = createCronEvent(`Basic ${CRON_SECRET}`);

        const response = await POST(event);
        expect(response.status).toBe(401);
    });

    it('successful cleanup with no pending files returns deleted: 0', async () => {
        const { POST } = await import('./+server.js');
        const event = createCronEvent(`Bearer ${CRON_SECRET}`);

        const response = await POST(event);
        expect(response.status).toBe(200);
        const data = await response.json();
        expect(data.ok).toBe(true);
        expect(data.deleted).toBe(0);
    });

    it('successful cleanup deletes old pending files from R2', async () => {
        const { POST } = await import('./+server.js');

        // Put some files in R2 under pending/ prefix
        // These will have recent uploaded timestamps, so cleanupPendingUploads
        // with default 24hr maxAge won't delete them unless we override.
        // The cleanupPendingUploads method checks obj.uploaded < cutoff.
        // Since we can't backdate R2 uploaded timestamps easily,
        // we call cleanupPendingUploads with a very small maxAge (0ms)
        // to make everything "old".

        await proxy.env.IMAGES.put(
            `pending/${TEST_USER_ID}/file1-image.jpg`,
            new Uint8Array(10),
            { httpMetadata: { contentType: 'image/jpeg' } }
        );
        await proxy.env.IMAGES.put(
            `pending/${TEST_USER_ID}/file2-audio.webm`,
            new Uint8Array(20),
            { httpMetadata: { contentType: 'audio/webm' } }
        );
        await proxy.env.IMAGES.put(
            `pending/other-user/file3-image.png`,
            new Uint8Array(15),
            { httpMetadata: { contentType: 'image/png' } }
        );

        // Verify files exist
        const before1 = await proxy.env.IMAGES.get(`pending/${TEST_USER_ID}/file1-image.jpg`);
        expect(before1).not.toBeNull();

        // Use a custom storage with 0ms maxAge to force cleanup of all pending files
        const customStorage = new Storage(proxy.env);
        const originalCleanup = customStorage.cleanupPendingUploads.bind(customStorage);

        const event = createCronEvent(`Bearer ${CRON_SECRET}`);
        // Override storage's cleanupPendingUploads to use 0ms maxAge
        event.locals.storage = {
            ...storage,
            cleanupPendingUploads: () => originalCleanup(0)
        };

        const response = await POST(event);
        expect(response.status).toBe(200);
        const data = await response.json();
        expect(data.ok).toBe(true);
        expect(data.deleted).toBe(3);

        // Verify files are gone
        const after1 = await proxy.env.IMAGES.get(`pending/${TEST_USER_ID}/file1-image.jpg`);
        const after2 = await proxy.env.IMAGES.get(`pending/${TEST_USER_ID}/file2-audio.webm`);
        const after3 = await proxy.env.IMAGES.get(`pending/other-user/file3-image.png`);
        expect(after1).toBeNull();
        expect(after2).toBeNull();
        expect(after3).toBeNull();
    });

    it('cleanup does not delete non-pending files', async () => {
        const { POST } = await import('./+server.js');

        // Put a non-pending file in R2
        await proxy.env.IMAGES.put(
            `entry/some-entry.json`,
            JSON.stringify({ items: [] }),
            { httpMetadata: { contentType: 'application/json' } }
        );
        // Put a pending file
        await proxy.env.IMAGES.put(
            `pending/${TEST_USER_ID}/file1-image.jpg`,
            new Uint8Array(10),
            { httpMetadata: { contentType: 'image/jpeg' } }
        );

        const customStorage = new Storage(proxy.env);
        const event = createCronEvent(`Bearer ${CRON_SECRET}`);
        event.locals.storage = {
            ...storage,
            cleanupPendingUploads: () => customStorage.cleanupPendingUploads(0)
        };

        const response = await POST(event);
        expect(response.status).toBe(200);
        const data = await response.json();
        expect(data.deleted).toBe(1); // only the pending file

        // Non-pending file should still exist
        const entryFile = await proxy.env.IMAGES.get('entry/some-entry.json');
        expect(entryFile).not.toBeNull();
    });
});
