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

function createMockEvent() {
    return {
        request: new Request('http://localhost/api/history'),
        locals: {
            user: { id: TEST_USER_ID, email: TEST_USER_EMAIL },
            storage
        },
        platform: { env: proxy.env },
        url: new URL('http://localhost/api/history')
    };
}

describe('History GET', () => {
    it('returns 401 without a user', async () => {
        const { GET } = await import('./+server.js');
        const event = createMockEvent();
        event.locals.user = null;

        const response = await GET(event);
        expect(response.status).toBe(401);
        const body = await response.json();
        expect(body.error).toBe('Unauthorized');
    });

    it('returns empty array for new user with no entries', async () => {
        const { GET } = await import('./+server.js');
        const event = createMockEvent();

        const response = await GET(event);
        expect(response.status).toBe(200);
        const body = await response.json();
        expect(body).toEqual([]);
    });

    it('returns entries newest first', async () => {
        const { GET } = await import('./+server.js');

        await seedEntry(proxy.env.DB, TEST_USER_ID, {
            id: 'e-old', timestamp: '2026-05-20T08:00:00',
            meal_title: 'Old Breakfast', total_calories: 300, total_protein: 15, total_carbs: 40
        });
        await seedEntry(proxy.env.DB, TEST_USER_ID, {
            id: 'e-mid', timestamp: '2026-05-22T12:00:00',
            meal_title: 'Mid Lunch', total_calories: 500, total_protein: 30, total_carbs: 50
        });
        await seedEntry(proxy.env.DB, TEST_USER_ID, {
            id: 'e-new', timestamp: '2026-05-25T19:00:00',
            meal_title: 'New Dinner', total_calories: 800, total_protein: 50, total_carbs: 30
        });

        const event = createMockEvent();
        const response = await GET(event);
        expect(response.status).toBe(200);
        const body = await response.json();

        expect(body.length).toBe(3);
        expect(body[0].id).toBe('e-new');
        expect(body[1].id).toBe('e-mid');
        expect(body[2].id).toBe('e-old');
    });

    it('parses items JSON in returned entries', async () => {
        const { GET } = await import('./+server.js');

        const items = [
            { name: 'Chicken', calories: 300, protein: 40, carbs: 0, fat: 10 },
            { name: 'Salad', calories: 50, protein: 2, carbs: 8, fat: 1 }
        ];

        await seedEntry(proxy.env.DB, TEST_USER_ID, {
            id: 'e-items', timestamp: '2026-05-25T12:00:00',
            meal_title: 'Chicken Salad', total_calories: 350, total_protein: 42, total_carbs: 8,
            items
        });

        const event = createMockEvent();
        const response = await GET(event);
        const body = await response.json();

        expect(body.length).toBe(1);
        expect(Array.isArray(body[0].items)).toBe(true);
        expect(body[0].items.length).toBe(2);
        expect(body[0].items[0].name).toBe('Chicken');
        expect(body[0].items[1].name).toBe('Salad');
    });

    it('includes status field defaulting to committed', async () => {
        const { GET } = await import('./+server.js');

        await seedEntry(proxy.env.DB, TEST_USER_ID, {
            id: 'e-committed', timestamp: '2026-05-25T12:00:00',
            meal_title: 'Committed Entry', total_calories: 400, total_protein: 25, total_carbs: 45,
            status: 'committed'
        });

        const event = createMockEvent();
        const response = await GET(event);
        const body = await response.json();

        expect(body[0].status).toBe('committed');
    });

    it('does not return entries from other users', async () => {
        const { GET } = await import('./+server.js');

        const otherUserId = 'other-user-789';
        await proxy.env.DB.prepare(
            `INSERT OR IGNORE INTO users (id, email, created_at, updated_at) VALUES (?, ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`
        ).bind(otherUserId, 'other@example.com').run();

        await seedEntry(proxy.env.DB, otherUserId, {
            id: 'e-other', timestamp: '2026-05-25T12:00:00',
            meal_title: 'Other User Meal', total_calories: 999, total_protein: 99, total_carbs: 99
        });
        await seedEntry(proxy.env.DB, TEST_USER_ID, {
            id: 'e-mine', timestamp: '2026-05-25T14:00:00',
            meal_title: 'My Meal', total_calories: 500, total_protein: 30, total_carbs: 40
        });

        const event = createMockEvent();
        const response = await GET(event);
        const body = await response.json();

        expect(body.length).toBe(1);
        expect(body[0].id).toBe('e-mine');
    });

    it('returns all expected fields', async () => {
        const { GET } = await import('./+server.js');

        await seedEntry(proxy.env.DB, TEST_USER_ID, {
            id: 'e-full', timestamp: '2026-05-25T12:00:00',
            user_message: 'I had a chicken wrap',
            meal_title: 'Chicken Wrap', total_calories: 450, total_protein: 35, total_carbs: 40,
            items: [{ name: 'Chicken Wrap', calories: 450 }]
        });

        const event = createMockEvent();
        const response = await GET(event);
        const body = await response.json();

        const entry = body[0];
        expect(entry.id).toBe('e-full');
        expect(entry.user_id).toBe(TEST_USER_ID);
        expect(entry.timestamp).toBe('2026-05-25T12:00:00');
        expect(entry.user_message).toBe('I had a chicken wrap');
        expect(entry.meal_title).toBe('Chicken Wrap');
        expect(entry.total_calories).toBe(450);
        expect(entry.total_protein).toBe(35);
        expect(entry.total_carbs).toBe(40);
        expect(entry.status).toBe('committed');
        expect(Array.isArray(entry.items)).toBe(true);
    });
});
