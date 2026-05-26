import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import {
    applySchema, resetAll, seedSettings, seedEntry,
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
    await seedSettings(proxy.env.DB, TEST_USER_ID);
});

afterAll(async () => {
    await proxy.dispose();
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function createPostEvent(body) {
    return {
        request: new Request('http://localhost/api/entry', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(body)
        }),
        locals: {
            user: { id: TEST_USER_ID, email: TEST_USER_EMAIL },
            storage
        },
        platform: {
            env: proxy.env,
            context: { waitUntil: (p) => p?.then?.(() => {}).catch?.(() => {}) }
        }
    };
}

function createIdEvent(method, id, body = null) {
    const init = {
        method,
        headers: { 'Content-Type': 'application/json' }
    };
    if (body) init.body = JSON.stringify(body);
    return {
        request: new Request(`http://localhost/api/entry/${id}`, init),
        params: { id },
        locals: {
            user: { id: TEST_USER_ID, email: TEST_USER_EMAIL },
            storage
        },
        platform: {
            env: proxy.env,
            context: { waitUntil: (p) => p?.then?.(() => {}).catch?.(() => {}) }
        }
    };
}

// ---------------------------------------------------------------------------
// POST /api/entry
// ---------------------------------------------------------------------------

describe('POST /api/entry', () => {
    it('returns 401 without a user', async () => {
        const { POST } = await import('./+server.js');
        const event = createPostEvent({
            meal_title: 'Lunch',
            items: [{ name: 'Salad', calories: 200, protein: 10, carbs: 15 }]
        });
        event.locals.user = null;

        const response = await POST(event);
        expect(response.status).toBe(401);
    });

    it('creates an entry with items and macros', async () => {
        const { POST } = await import('./+server.js');
        const items = [
            { name: 'Grilled Chicken', calories: 300, protein: 45, carbs: 0 },
            { name: 'Brown Rice', calories: 200, protein: 5, carbs: 40 }
        ];
        const event = createPostEvent({
            meal_title: 'Chicken & Rice',
            items,
            total_calories: 500,
            total_protein: 50,
            total_carbs: 40,
            timestamp: '2026-05-26T12:30:00',
            user_message: 'chicken and rice for lunch'
        });

        const response = await POST(event);
        expect(response.status).toBe(200);

        const data = await response.json();
        expect(data.id).toBeDefined();
        expect(data.meal_title).toBe('Chicken & Rice');
        expect(data.total_calories).toBe(500);
        expect(data.total_protein).toBe(50);
        expect(data.total_carbs).toBe(40);
        expect(data.timestamp).toBe('2026-05-26T12:30:00');
        expect(data.status).toBe('committed');

        // Verify it's actually persisted in DB
        const dbRow = await proxy.env.DB.prepare(
            'SELECT * FROM nutrition_entries WHERE id = ?'
        ).bind(data.id).first();

        expect(dbRow).not.toBeNull();
        expect(dbRow.meal_title).toBe('Chicken & Rice');
        expect(dbRow.total_calories).toBe(500);
        expect(dbRow.total_protein).toBe(50);
        expect(dbRow.total_carbs).toBe(40);
        expect(dbRow.user_message).toBe('chicken and rice for lunch');
        expect(JSON.parse(dbRow.items)).toEqual(items);

        // Verify R2 blob was written
        const r2Obj = await proxy.env.IMAGES.get(`entry/${data.id}.json`);
        expect(r2Obj).not.toBeNull();
        const blob = await r2Obj.json();
        expect(blob.items).toEqual(items);
    });

    it('generates a timestamp when none is provided', async () => {
        const { POST } = await import('./+server.js');
        const event = createPostEvent({
            meal_title: 'Snack',
            items: [{ name: 'Apple', calories: 95, protein: 0, carbs: 25 }],
            total_calories: 95,
            total_protein: 0,
            total_carbs: 25
        });

        const response = await POST(event);
        expect(response.status).toBe(200);
        const data = await response.json();
        expect(data.timestamp).toBeDefined();
        // Should be an ISO-like datetime string
        expect(data.timestamp).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/);
    });

    it('defaults status to committed', async () => {
        const { POST } = await import('./+server.js');
        const event = createPostEvent({
            meal_title: 'Dinner',
            items: [],
            total_calories: 0
        });
        const response = await POST(event);
        const data = await response.json();
        expect(data.status).toBe('committed');
    });

    it('preserves a non-committed status when provided', async () => {
        const { POST } = await import('./+server.js');
        const event = createPostEvent({
            meal_title: 'Pending Meal',
            items: [],
            total_calories: 0,
            status: 'analyzing'
        });
        const response = await POST(event);
        const data = await response.json();
        expect(data.status).toBe('analyzing');
    });

    it('stores conversation messages in R2', async () => {
        const { POST } = await import('./+server.js');
        const messages = [
            { role: 'user', content: 'I had chicken' },
            { role: 'assistant', content: 'Got it!' }
        ];
        const event = createPostEvent({
            meal_title: 'Chicken',
            items: [{ name: 'Chicken', calories: 250, protein: 40, carbs: 0 }],
            total_calories: 250,
            total_protein: 40,
            total_carbs: 0,
            messages
        });

        const response = await POST(event);
        const data = await response.json();

        const r2Obj = await proxy.env.IMAGES.get(`entry/${data.id}.json`);
        const blob = await r2Obj.json();
        expect(blob.conversation_messages).toEqual(messages);
    });
});

// ---------------------------------------------------------------------------
// GET /api/entry/[id]
// ---------------------------------------------------------------------------

describe('GET /api/entry/[id]', () => {
    it('returns 401 without a user', async () => {
        const { GET } = await import('./[id]/+server.js');
        const event = createIdEvent('GET', 'some-id');
        event.locals.user = null;

        const response = await GET(event);
        expect(response.status).toBe(401);
    });

    it('returns 404 for nonexistent entry', async () => {
        const { GET } = await import('./[id]/+server.js');
        const event = createIdEvent('GET', 'nonexistent-id');

        const response = await GET(event);
        expect(response.status).toBe(404);
    });

    it('fetches an entry with full details from R2', async () => {
        // Create an entry through storage so both D1 and R2 are populated
        const items = [
            { name: 'Steak', calories: 600, protein: 50, carbs: 0 },
            { name: 'Mashed Potatoes', calories: 230, protein: 4, carbs: 35 }
        ];
        const saved = await storage.saveEntry({
            id: 'test-get-entry',
            meal_title: 'Steak Dinner',
            timestamp: '2026-05-26T19:00:00',
            items,
            total_calories: 830,
            total_protein: 54,
            total_carbs: 35,
            user_message: 'steak and potatoes',
            messages: [{ role: 'user', content: 'steak and potatoes' }],
            image_keys: ['pending/img1.jpg'],
            audio_key: 'pending/audio1.webm',
            pending_question: null
        }, TEST_USER_ID);

        const { GET } = await import('./[id]/+server.js');
        const event = createIdEvent('GET', 'test-get-entry');

        const response = await GET(event);
        expect(response.status).toBe(200);

        const data = await response.json();
        expect(data.meal_title).toBe('Steak Dinner');
        expect(data.total_calories).toBe(830);
        expect(data.total_protein).toBe(54);
        expect(data.items).toEqual(items);
        // R2 content fields
        expect(data.conversation_messages).toEqual([{ role: 'user', content: 'steak and potatoes' }]);
        expect(data.image_keys).toEqual(['pending/img1.jpg']);
        expect(data.audio_key).toBe('pending/audio1.webm');
    });

    it('does not return an entry belonging to another user', async () => {
        // Seed an entry owned by a different user
        const otherUserId = 'other-user-999';
        await proxy.env.DB.prepare(
            "INSERT OR IGNORE INTO users (id, email, created_at, updated_at) VALUES (?, ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)"
        ).bind(otherUserId, 'other@example.com').run();
        await storage.saveEntry({
            id: 'other-user-entry',
            meal_title: 'Secret Meal',
            items: [],
            total_calories: 100
        }, otherUserId);

        const { GET } = await import('./[id]/+server.js');
        const event = createIdEvent('GET', 'other-user-entry');

        const response = await GET(event);
        expect(response.status).toBe(404);
    });
});

// ---------------------------------------------------------------------------
// PATCH /api/entry/[id]
// ---------------------------------------------------------------------------

describe('PATCH /api/entry/[id]', () => {
    it('returns 401 without a user', async () => {
        const { PATCH } = await import('./[id]/+server.js');
        const event = createIdEvent('PATCH', 'some-id', { timestamp: '2026-05-26T20:00:00' });
        event.locals.user = null;

        const response = await PATCH(event);
        expect(response.status).toBe(401);
    });

    it('returns 404 for nonexistent entry', async () => {
        const { PATCH } = await import('./[id]/+server.js');
        const event = createIdEvent('PATCH', 'ghost-id', { timestamp: '2026-05-26T20:00:00' });

        const response = await PATCH(event);
        expect(response.status).toBe(404);
    });

    it('updates timestamp', async () => {
        await storage.saveEntry({
            id: 'patch-ts',
            meal_title: 'Breakfast',
            timestamp: '2026-05-26T08:00:00',
            items: [],
            total_calories: 0
        }, TEST_USER_ID);

        const { PATCH } = await import('./[id]/+server.js');
        const event = createIdEvent('PATCH', 'patch-ts', {
            timestamp: '2026-05-26T09:30:00'
        });

        const response = await PATCH(event);
        expect(response.status).toBe(200);
        const data = await response.json();
        expect(data.success).toBe(true);
        expect(data.timestamp).toBe('2026-05-26T09:30:00');

        // Verify in DB
        const row = await proxy.env.DB.prepare(
            'SELECT timestamp FROM nutrition_entries WHERE id = ?'
        ).bind('patch-ts').first();
        expect(row.timestamp).toBe('2026-05-26T09:30:00');
    });

    it('updates meal_title', async () => {
        await storage.saveEntry({
            id: 'patch-title',
            meal_title: 'Old Name',
            timestamp: '2026-05-26T12:00:00',
            items: [],
            total_calories: 0
        }, TEST_USER_ID);

        const { PATCH } = await import('./[id]/+server.js');
        const event = createIdEvent('PATCH', 'patch-title', {
            meal_title: 'New Name'
        });

        const response = await PATCH(event);
        expect(response.status).toBe(200);
        const data = await response.json();
        expect(data.meal_title).toBe('New Name');
    });

    it('updates items and recalculates totals', async () => {
        await storage.saveEntry({
            id: 'patch-items',
            meal_title: 'Lunch',
            timestamp: '2026-05-26T12:00:00',
            items: [{ name: 'Salad', calories: 150, protein: 5, carbs: 20 }],
            total_calories: 150,
            total_protein: 5,
            total_carbs: 20
        }, TEST_USER_ID);

        const newItems = [
            { name: 'Salad', calories: 150, protein: 5, carbs: 20 },
            { name: 'Grilled Chicken Breast', calories: 280, protein: 52, carbs: 0 },
            { name: 'Dressing', calories: 120, protein: 0, carbs: 6 }
        ];

        const { PATCH } = await import('./[id]/+server.js');
        const event = createIdEvent('PATCH', 'patch-items', { items: newItems });

        const response = await PATCH(event);
        expect(response.status).toBe(200);

        // Verify totals are recalculated correctly
        const entry = await storage.getEntryDetails('patch-items', TEST_USER_ID);
        expect(entry.total_calories).toBe(550);   // 150+280+120
        expect(entry.total_protein).toBe(57);      // Math.round(5+52+0)
        expect(entry.total_carbs).toBe(26);        // 20+0+6
        expect(entry.items).toEqual(newItems);
    });

    it('updates status', async () => {
        await storage.saveEntry({
            id: 'patch-status',
            meal_title: 'TBD',
            timestamp: '2026-05-26T12:00:00',
            items: [],
            total_calories: 0,
            status: 'ready'
        }, TEST_USER_ID);

        const { PATCH } = await import('./[id]/+server.js');
        const event = createIdEvent('PATCH', 'patch-status', { status: 'committed' });

        const response = await PATCH(event);
        expect(response.status).toBe(200);
        const data = await response.json();
        expect(data.status).toBe('committed');
    });

    it('cleans up pending R2 keys on commit', async () => {
        const imgKey = 'pending/img-commit-test.jpg';
        const audioKey = 'pending/audio-commit-test.webm';

        // Put fake files into R2 at pending/ keys
        await proxy.env.IMAGES.put(imgKey, 'fake-image-data');
        await proxy.env.IMAGES.put(audioKey, 'fake-audio-data');

        // Verify they exist
        expect(await proxy.env.IMAGES.get(imgKey)).not.toBeNull();
        expect(await proxy.env.IMAGES.get(audioKey)).not.toBeNull();

        // Create entry via storage with those keys
        await storage.saveEntry({
            id: 'commit-cleanup',
            meal_title: 'Uploaded Meal',
            timestamp: '2026-05-26T13:00:00',
            items: [{ name: 'Toast', calories: 100, protein: 3, carbs: 18 }],
            total_calories: 100,
            total_protein: 3,
            total_carbs: 18,
            image_keys: [imgKey],
            audio_key: audioKey,
            status: 'ready'
        }, TEST_USER_ID);

        const { PATCH } = await import('./[id]/+server.js');
        const event = createIdEvent('PATCH', 'commit-cleanup', { status: 'committed' });

        const response = await PATCH(event);
        expect(response.status).toBe(200);
        const data = await response.json();
        expect(data.status).toBe('committed');

        // Wait a tick for the waitUntil cleanup to settle
        await new Promise((r) => setTimeout(r, 100));

        // Pending keys should be deleted
        const imgAfter = await proxy.env.IMAGES.get(imgKey);
        expect(imgAfter).toBeNull();
        const audioAfter = await proxy.env.IMAGES.get(audioKey);
        expect(audioAfter).toBeNull();

        // The entry R2 blob itself should still exist
        const entryBlob = await proxy.env.IMAGES.get('entry/commit-cleanup.json');
        expect(entryBlob).not.toBeNull();
    });

    it('does not delete R2 keys for non-commit status changes', async () => {
        const imgKey = 'pending/img-no-commit.jpg';
        await proxy.env.IMAGES.put(imgKey, 'fake-image');

        await storage.saveEntry({
            id: 'no-commit',
            meal_title: 'Pending',
            timestamp: '2026-05-26T14:00:00',
            items: [],
            total_calories: 0,
            image_keys: [imgKey],
            status: 'analyzing'
        }, TEST_USER_ID);

        const { PATCH } = await import('./[id]/+server.js');
        const event = createIdEvent('PATCH', 'no-commit', { status: 'ready' });

        await PATCH(event);
        await new Promise((r) => setTimeout(r, 50));

        // Key should still exist
        const imgAfter = await proxy.env.IMAGES.get(imgKey);
        expect(imgAfter).not.toBeNull();
    });
});

// ---------------------------------------------------------------------------
// DELETE /api/entry/[id]
// ---------------------------------------------------------------------------

describe('DELETE /api/entry/[id]', () => {
    it('returns 401 without a user', async () => {
        const { DELETE } = await import('./[id]/+server.js');
        const event = createIdEvent('DELETE', 'some-id');
        event.locals.user = null;

        const response = await DELETE(event);
        expect(response.status).toBe(401);
    });

    it('removes entry from DB and R2', async () => {
        await storage.saveEntry({
            id: 'delete-me',
            meal_title: 'Doomed',
            timestamp: '2026-05-26T10:00:00',
            items: [{ name: 'Toast', calories: 100, protein: 3, carbs: 18 }],
            total_calories: 100,
            total_protein: 3,
            total_carbs: 18
        }, TEST_USER_ID);

        // Confirm it exists
        const before = await storage.getEntryDetails('delete-me', TEST_USER_ID);
        expect(before).not.toBeNull();

        const { DELETE: DEL } = await import('./[id]/+server.js');
        const event = createIdEvent('DELETE', 'delete-me');

        const response = await DEL(event);
        expect(response.status).toBe(200);
        const data = await response.json();
        expect(data.success).toBe(true);

        // Verify removed from DB
        const dbRow = await proxy.env.DB.prepare(
            'SELECT * FROM nutrition_entries WHERE id = ?'
        ).bind('delete-me').first();
        expect(dbRow).toBeNull();

        // Verify R2 blob removed
        const r2Obj = await proxy.env.IMAGES.get('entry/delete-me.json');
        expect(r2Obj).toBeNull();
    });

    it('cleans up associated pending upload keys in R2', async () => {
        const imgKey = 'pending/delete-img.jpg';
        const audioKey = 'pending/delete-audio.webm';

        await proxy.env.IMAGES.put(imgKey, 'fake-image');
        await proxy.env.IMAGES.put(audioKey, 'fake-audio');

        await storage.saveEntry({
            id: 'delete-with-uploads',
            meal_title: 'Uploaded',
            timestamp: '2026-05-26T11:00:00',
            items: [],
            total_calories: 0,
            image_keys: [imgKey],
            audio_key: audioKey
        }, TEST_USER_ID);

        const { DELETE: DEL } = await import('./[id]/+server.js');
        const event = createIdEvent('DELETE', 'delete-with-uploads');

        const response = await DEL(event);
        expect(response.status).toBe(200);

        // Pending uploads should also be cleaned up
        const imgAfter = await proxy.env.IMAGES.get(imgKey);
        expect(imgAfter).toBeNull();
        const audioAfter = await proxy.env.IMAGES.get(audioKey);
        expect(audioAfter).toBeNull();
    });

    it('succeeds even if entry does not exist (idempotent)', async () => {
        const { DELETE: DEL } = await import('./[id]/+server.js');
        const event = createIdEvent('DELETE', 'never-existed');

        const response = await DEL(event);
        expect(response.status).toBe(200);
        const data = await response.json();
        expect(data.success).toBe(true);
    });
});
