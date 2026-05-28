import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import {
    applySchema, resetAll,
    TEST_USER_ID, TEST_USER_EMAIL
} from '../../../tests/setup.js';
import { Storage } from '../../../lib/server/storage.js';

let proxy, storage;

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

function createPostEvent(file, user = { id: TEST_USER_ID, email: TEST_USER_EMAIL }) {
    const form = new FormData();
    if (file) {
        form.append('file', file);
    }

    const waitUntilPromises = [];
    const event = {
        request: new Request('http://localhost/api/upload', {
            method: 'POST',
            body: form
        }),
        locals: {
            user,
            storage
        },
        platform: {
            env: { ...proxy.env },
            context: { waitUntil: (p) => waitUntilPromises.push(p) }
        },
        getClientAddress: () => '127.0.0.1',
        waitUntilPromises
    };
    return event;
}

function createDeleteEvent(body, user = { id: TEST_USER_ID, email: TEST_USER_EMAIL }) {
    return {
        request: new Request('http://localhost/api/upload', {
            method: 'DELETE',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(body)
        }),
        locals: {
            user,
            storage
        },
        platform: {
            env: { ...proxy.env }
        }
    };
}

describe('Upload POST', () => {
    it('returns 401 without user', async () => {
        const { POST } = await import('./+server.js');
        const file = new File([new Uint8Array(100)], 'test.jpg', { type: 'image/jpeg' });
        const event = createPostEvent(file, null);
        event.locals.user = null;

        const response = await POST(event);
        expect(response.status).toBe(401);
        const data = await response.json();
        expect(data.error).toBe('Unauthorized');
    });

    it('returns 400 with no file', async () => {
        const { POST } = await import('./+server.js');
        const event = createPostEvent(null);

        const response = await POST(event);
        expect(response.status).toBe(400);
        const data = await response.json();
        expect(data.error).toBe('No file provided');
    });

    it('returns 413 for file too large (>20MB)', async () => {
        const { POST } = await import('./+server.js');
        // Create a file that's just over 20MB
        const bigBuffer = new Uint8Array(20 * 1024 * 1024 + 1);
        const file = new File([bigBuffer], 'huge.jpg', { type: 'image/jpeg' });
        const event = createPostEvent(file);

        const response = await POST(event);
        expect(response.status).toBe(413);
        const data = await response.json();
        expect(data.error).toBe('File too large');
    });

    it('returns 415 for unsupported file type (application/pdf)', async () => {
        const { POST } = await import('./+server.js');
        const file = new File([new Uint8Array(100)], 'test.pdf', { type: 'application/pdf' });
        const event = createPostEvent(file);

        const response = await POST(event);
        expect(response.status).toBe(415);
        const data = await response.json();
        expect(data.error).toBe('Unsupported file type');
    });

    it('returns 415 for text/plain file type', async () => {
        const { POST } = await import('./+server.js');
        const file = new File(['hello world'], 'notes.txt', { type: 'text/plain' });
        const event = createPostEvent(file);

        const response = await POST(event);
        expect(response.status).toBe(415);
    });

    it('successful image upload returns key/kind/mime/size with correct prefix', async () => {
        const { POST } = await import('./+server.js');
        const imageData = new Uint8Array(256);
        const file = new File([imageData], 'photo.jpg', { type: 'image/jpeg' });
        const event = createPostEvent(file);

        const response = await POST(event);
        expect(response.status).toBe(200);

        const data = await response.json();
        expect(data.key).toBeDefined();
        expect(data.key.startsWith(`pending/${TEST_USER_ID}/`)).toBe(true);
        expect(data.key).toContain('-image.');
        expect(data.key.endsWith('.jpeg')).toBe(true);
        expect(data.kind).toBe('image');
        expect(data.mime).toBe('image/jpeg');
        expect(data.size).toBe(256);
    });

    it('successful audio upload returns correct kind and key', async () => {
        const { POST } = await import('./+server.js');
        const audioData = new Uint8Array(512);
        const file = new File([audioData], 'recording.webm', { type: 'audio/webm' });
        const event = createPostEvent(file);

        const response = await POST(event);
        expect(response.status).toBe(200);

        const data = await response.json();
        expect(data.key).toBeDefined();
        expect(data.key.startsWith(`pending/${TEST_USER_ID}/`)).toBe(true);
        expect(data.key).toContain('-audio.');
        expect(data.kind).toBe('audio');
        expect(data.mime).toBe('audio/webm');
        expect(data.size).toBe(512);
    });

    it('successful PNG upload has correct extension', async () => {
        const { POST } = await import('./+server.js');
        const file = new File([new Uint8Array(64)], 'screenshot.png', { type: 'image/png' });
        const event = createPostEvent(file);

        const response = await POST(event);
        expect(response.status).toBe(200);

        const data = await response.json();
        expect(data.key.endsWith('.png')).toBe(true);
        expect(data.kind).toBe('image');
        expect(data.mime).toBe('image/png');
    });

    it('file is actually stored in R2 after upload', async () => {
        const { POST } = await import('./+server.js');
        const content = new Uint8Array([1, 2, 3, 4, 5]);
        const file = new File([content], 'test.jpg', { type: 'image/jpeg' });
        const event = createPostEvent(file);

        const response = await POST(event);
        expect(response.status).toBe(200);
        const data = await response.json();

        // Verify the file exists in R2
        const r2Object = await proxy.env.IMAGES.get(data.key);
        expect(r2Object).not.toBeNull();

        const stored = new Uint8Array(await r2Object.arrayBuffer());
        expect(stored.length).toBe(5);
        expect(stored[0]).toBe(1);
        expect(stored[4]).toBe(5);
    });

    it('file at exactly 20MB is accepted', async () => {
        const { POST } = await import('./+server.js');
        const exactLimit = new Uint8Array(20 * 1024 * 1024);
        const file = new File([exactLimit], 'exact.jpg', { type: 'image/jpeg' });
        const event = createPostEvent(file);

        const response = await POST(event);
        expect(response.status).toBe(200);
    });

    it('opportunistically sweeps this user\'s stale pending uploads via waitUntil', async () => {
        // Seed a stale pending file for this user (older than 24h cutoff would be impossible
        // to set on R2 directly via timestamp, so we use maxAgeMs=0 via the storage method...
        // but the endpoint hardcodes 24h. Instead, seed and rely on the fact that fresh files
        // should NOT be swept). Then verify the endpoint enqueues a sweep at all.
        await proxy.env.IMAGES.put(`pending/${TEST_USER_ID}/abandoned.jpeg`, 'old');

        const { POST } = await import('./+server.js');
        const file = new File([new Uint8Array(100)], 'new.jpg', { type: 'image/jpeg' });
        const event = createPostEvent(file);

        const response = await POST(event);
        expect(response.status).toBe(200);

        // Endpoint scheduled exactly one sweep promise via waitUntil
        expect(event.waitUntilPromises).toHaveLength(1);
        await Promise.all(event.waitUntilPromises);

        // Fresh files (both the seeded one and the just-uploaded one) survive 24h cutoff
        const listed = await proxy.env.IMAGES.list({ prefix: `pending/${TEST_USER_ID}/` });
        expect(listed.objects.length).toBe(2);
    });
});

describe('Upload DELETE', () => {
    it('returns 401 without user', async () => {
        const { DELETE } = await import('./+server.js');
        const event = createDeleteEvent({ key: `pending/${TEST_USER_ID}/abc-image.jpg` }, null);
        event.locals.user = null;

        const response = await DELETE(event);
        expect(response.status).toBe(401);
        const data = await response.json();
        expect(data.error).toBe('Unauthorized');
    });

    it('returns 400 with missing key', async () => {
        const { DELETE } = await import('./+server.js');
        const event = createDeleteEvent({});

        const response = await DELETE(event);
        expect(response.status).toBe(400);
        const data = await response.json();
        expect(data.error).toBe('Missing key');
    });

    it('returns 400 with non-string key', async () => {
        const { DELETE } = await import('./+server.js');
        const event = createDeleteEvent({ key: 12345 });

        const response = await DELETE(event);
        expect(response.status).toBe(400);
        const data = await response.json();
        expect(data.error).toBe('Missing key');
    });

    it('returns 403 when key does not match user prefix', async () => {
        const { DELETE } = await import('./+server.js');
        const event = createDeleteEvent({ key: 'pending/other-user-id/file-image.jpg' });

        const response = await DELETE(event);
        expect(response.status).toBe(403);
        const data = await response.json();
        expect(data.error).toBe('Forbidden');
    });

    it('returns 403 for key outside pending directory', async () => {
        const { DELETE } = await import('./+server.js');
        const event = createDeleteEvent({ key: `entry/some-entry.json` });

        const response = await DELETE(event);
        expect(response.status).toBe(403);
    });

    it('successful deletion removes file from R2', async () => {
        const { POST, DELETE } = await import('./+server.js');

        // First upload a file
        const file = new File([new Uint8Array(100)], 'todelete.jpg', { type: 'image/jpeg' });
        const uploadEvent = createPostEvent(file);
        const uploadResponse = await POST(uploadEvent);
        expect(uploadResponse.status).toBe(200);
        const { key } = await uploadResponse.json();

        // Verify it's in R2
        const before = await proxy.env.IMAGES.get(key);
        expect(before).not.toBeNull();

        // Delete it
        const deleteEvent = createDeleteEvent({ key });
        const deleteResponse = await DELETE(deleteEvent);
        expect(deleteResponse.status).toBe(200);
        const deleteData = await deleteResponse.json();
        expect(deleteData.ok).toBe(true);

        // Verify it's gone from R2
        const after = await proxy.env.IMAGES.get(key);
        expect(after).toBeNull();
    });
});
