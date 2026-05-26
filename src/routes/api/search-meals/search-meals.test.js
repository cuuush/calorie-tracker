import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import {
    applySchema, resetAll, seedEntry,
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

function createMockEvent(query) {
    const url = new URL(`http://localhost/api/search-meals${query ? `?q=${encodeURIComponent(query)}` : ''}`);
    return {
        request: new Request(url.toString()),
        locals: {
            user: { id: TEST_USER_ID, email: TEST_USER_EMAIL },
            storage
        },
        platform: { env: proxy.env },
        url
    };
}

describe('Search meals GET', () => {
    it('returns 401 without a user', async () => {
        const { GET } = await import('./+server.js');
        const event = createMockEvent('chicken');
        event.locals.user = null;

        const response = await GET(event);
        expect(response.status).toBe(401);
        const body = await response.json();
        expect(body.error).toBe('Unauthorized');
    });

    it('returns empty array when query is missing', async () => {
        const { GET } = await import('./+server.js');
        const event = createMockEvent(null);

        const response = await GET(event);
        expect(response.status).toBe(200);
        const body = await response.json();
        expect(body).toEqual([]);
    });

    it('returns empty array when query is less than 3 characters', async () => {
        const { GET } = await import('./+server.js');

        for (const q of ['ab', 'x', '']) {
            const event = createMockEvent(q);
            const response = await GET(event);
            expect(response.status).toBe(200);
            const body = await response.json();
            expect(body).toEqual([]);
        }
    });

    it('returns matching meals sorted by frequency', async () => {
        const { GET } = await import('./+server.js');

        // Seed entries: "Chicken Salad" x3, "Grilled Chicken" x1
        await seedEntry(proxy.env.DB, TEST_USER_ID, {
            id: 'e1', timestamp: '2026-05-20T12:00:00',
            meal_title: 'Chicken Salad', total_calories: 400, total_protein: 30, total_carbs: 20
        });
        await seedEntry(proxy.env.DB, TEST_USER_ID, {
            id: 'e2', timestamp: '2026-05-21T12:00:00',
            meal_title: 'Chicken Salad', total_calories: 420, total_protein: 32, total_carbs: 18
        });
        await seedEntry(proxy.env.DB, TEST_USER_ID, {
            id: 'e3', timestamp: '2026-05-22T12:00:00',
            meal_title: 'Chicken Salad', total_calories: 410, total_protein: 31, total_carbs: 19
        });
        await seedEntry(proxy.env.DB, TEST_USER_ID, {
            id: 'e4', timestamp: '2026-05-23T08:00:00',
            meal_title: 'Grilled Chicken', total_calories: 350, total_protein: 40, total_carbs: 5
        });

        const event = createMockEvent('chicken');
        const response = await GET(event);
        expect(response.status).toBe(200);
        const body = await response.json();

        expect(body.length).toBe(2);
        // "Chicken Salad" should be first (count=3) then "Grilled Chicken" (count=1)
        expect(body[0].meal_title).toBe('Chicken Salad');
        expect(body[0].count).toBe(3);
        // Most recent entry for "Chicken Salad" should be used (e3 from 2026-05-22)
        expect(body[0].id).toBe('e3');
        expect(body[0].total_calories).toBe(410);

        expect(body[1].meal_title).toBe('Grilled Chicken');
        expect(body[1].count).toBe(1);
    });

    it('returns max 5 results', async () => {
        const { GET } = await import('./+server.js');

        // Seed 7 different meals with "Bowl" in the title
        for (let i = 0; i < 7; i++) {
            await seedEntry(proxy.env.DB, TEST_USER_ID, {
                id: `bowl-${i}`, timestamp: `2026-05-${String(20 + i).padStart(2, '0')}T12:00:00`,
                meal_title: `Bowl Type ${i}`, total_calories: 500 + i, total_protein: 30, total_carbs: 50
            });
        }

        const event = createMockEvent('Bowl');
        const response = await GET(event);
        expect(response.status).toBe(200);
        const body = await response.json();
        expect(body.length).toBe(5);
    });

    it('search is case-insensitive', async () => {
        const { GET } = await import('./+server.js');

        await seedEntry(proxy.env.DB, TEST_USER_ID, {
            id: 'e-pasta', timestamp: '2026-05-20T12:00:00',
            meal_title: 'Pasta Primavera', total_calories: 600, total_protein: 20, total_carbs: 70
        });

        const event = createMockEvent('pasta');
        const response = await GET(event);
        const body = await response.json();
        expect(body.length).toBe(1);
        expect(body[0].meal_title).toBe('Pasta Primavera');
    });

    it('does not return meals from other users', async () => {
        const { GET } = await import('./+server.js');

        const otherUserId = 'other-user-456';
        // Seed a user for the other user
        await proxy.env.DB.prepare(
            `INSERT OR IGNORE INTO users (id, email, created_at, updated_at) VALUES (?, ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`
        ).bind(otherUserId, 'other@example.com').run();

        await seedEntry(proxy.env.DB, otherUserId, {
            id: 'e-other', timestamp: '2026-05-20T12:00:00',
            meal_title: 'Secret Tacos', total_calories: 700, total_protein: 35, total_carbs: 60
        });

        await seedEntry(proxy.env.DB, TEST_USER_ID, {
            id: 'e-mine', timestamp: '2026-05-20T12:00:00',
            meal_title: 'My Tacos', total_calories: 500, total_protein: 25, total_carbs: 40
        });

        const event = createMockEvent('Tacos');
        const response = await GET(event);
        const body = await response.json();
        expect(body.length).toBe(1);
        expect(body[0].meal_title).toBe('My Tacos');
    });

    it('returns no results for non-matching query', async () => {
        const { GET } = await import('./+server.js');

        await seedEntry(proxy.env.DB, TEST_USER_ID, {
            id: 'e-pizza', timestamp: '2026-05-20T12:00:00',
            meal_title: 'Pizza Margherita', total_calories: 800, total_protein: 25, total_carbs: 90
        });

        const event = createMockEvent('sushi');
        const response = await GET(event);
        const body = await response.json();
        expect(body).toEqual([]);
    });

    it('uses the most recent entry data for grouped meals', async () => {
        const { GET } = await import('./+server.js');

        await seedEntry(proxy.env.DB, TEST_USER_ID, {
            id: 'old', timestamp: '2026-05-10T12:00:00',
            meal_title: 'Oatmeal Bowl', total_calories: 300, total_protein: 10, total_carbs: 50,
            items: [{ name: 'Oatmeal', calories: 300 }]
        });
        await seedEntry(proxy.env.DB, TEST_USER_ID, {
            id: 'new', timestamp: '2026-05-25T08:00:00',
            meal_title: 'Oatmeal Bowl', total_calories: 350, total_protein: 12, total_carbs: 55,
            items: [{ name: 'Oatmeal with berries', calories: 350 }]
        });

        const event = createMockEvent('Oatmeal');
        const response = await GET(event);
        const body = await response.json();
        expect(body.length).toBe(1);
        expect(body[0].id).toBe('new');
        expect(body[0].total_calories).toBe(350);
        expect(body[0].count).toBe(2);
    });
});
