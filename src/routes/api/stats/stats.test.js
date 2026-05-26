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

function createMockEvent({ date = null, tz = null } = {}) {
    const params = new URLSearchParams();
    if (date) params.set('date', date);
    const qs = params.toString();
    const url = new URL(`http://localhost/api/stats${qs ? '?' + qs : ''}`);

    return {
        request: new Request(url.toString()),
        locals: {
            user: { id: TEST_USER_ID, email: TEST_USER_EMAIL },
            storage
        },
        platform: { env: proxy.env },
        url,
        cookies: {
            get: (name) => {
                if (name === 'tz') return tz || null;
                return null;
            },
            set: () => {},
            delete: () => {}
        }
    };
}

describe('Stats GET', () => {
    it('returns 401 without a user', async () => {
        const { GET } = await import('./+server.js');
        const event = createMockEvent();
        event.locals.user = null;

        const response = await GET(event);
        expect(response.status).toBe(401);
        const body = await response.json();
        expect(body.error).toBe('Unauthorized');
    });

    it('returns zeroed stats for user with no entries', async () => {
        const { GET } = await import('./+server.js');
        const event = createMockEvent({ date: '2026-05-26' });

        const response = await GET(event);
        expect(response.status).toBe(200);
        const body = await response.json();

        expect(body.todayTotal).toBe(0);
        expect(body.todayProtein).toBe(0);
        expect(body.groups).toEqual({ BREAKFAST: 0, LUNCH: 0, DINNER: 0, SNACK: 0 });
        expect(body.proteinGroups).toEqual({ BREAKFAST: 0, LUNCH: 0, DINNER: 0, SNACK: 0 });
        expect(body.weeklyData).toEqual([0, 0, 0, 0, 0, 0, 0]);
        expect(body.weeklyProteinData).toEqual([0, 0, 0, 0, 0, 0, 0]);
    });

    it('returns today totals and meal group breakdown', async () => {
        const { GET } = await import('./+server.js');

        // Seed entries for 2026-05-26 (the "today" date we'll query)
        // Breakfast: 08:00 (h=8, 4<=h<11 -> BREAKFAST)
        await seedEntry(proxy.env.DB, TEST_USER_ID, {
            id: 'e-bf', timestamp: '2026-05-26T08:00:00',
            meal_title: 'Oatmeal', total_calories: 350, total_protein: 15, total_carbs: 50
        });
        // Lunch: 12:30 (h=12, 11<=h<16 -> LUNCH)
        await seedEntry(proxy.env.DB, TEST_USER_ID, {
            id: 'e-lunch', timestamp: '2026-05-26T12:30:00',
            meal_title: 'Sandwich', total_calories: 600, total_protein: 35, total_carbs: 60
        });
        // Dinner: 19:00 (h=19, 16<=h<22 -> DINNER)
        await seedEntry(proxy.env.DB, TEST_USER_ID, {
            id: 'e-dinner', timestamp: '2026-05-26T19:00:00',
            meal_title: 'Steak', total_calories: 800, total_protein: 55, total_carbs: 20
        });

        const event = createMockEvent({ date: '2026-05-26' });
        const response = await GET(event);
        expect(response.status).toBe(200);
        const body = await response.json();

        expect(body.todayTotal).toBe(1750);
        expect(body.todayProtein).toBe(105);

        expect(body.groups.BREAKFAST).toBe(350);
        expect(body.groups.LUNCH).toBe(600);
        expect(body.groups.DINNER).toBe(800);
        expect(body.groups.SNACK).toBe(0);

        expect(body.proteinGroups.BREAKFAST).toBe(15);
        expect(body.proteinGroups.LUNCH).toBe(35);
        expect(body.proteinGroups.DINNER).toBe(55);
    });

    it('categorizes meals by time correctly (breakfast/lunch/dinner/snack)', async () => {
        const { GET } = await import('./+server.js');

        // Breakfast boundary: 4:00 (h=4, 4<=h<11 -> BREAKFAST)
        await seedEntry(proxy.env.DB, TEST_USER_ID, {
            id: 'e-early', timestamp: '2026-05-26T04:00:00',
            meal_title: 'Early Breakfast', total_calories: 100, total_protein: 5, total_carbs: 15
        });
        // Lunch boundary: 11:00 (h=11, 11<=h<16 -> LUNCH)
        await seedEntry(proxy.env.DB, TEST_USER_ID, {
            id: 'e-11', timestamp: '2026-05-26T11:00:00',
            meal_title: 'Brunch', total_calories: 200, total_protein: 10, total_carbs: 25
        });
        // Dinner boundary: 16:00 (h=16, 16<=h<22 -> DINNER)
        await seedEntry(proxy.env.DB, TEST_USER_ID, {
            id: 'e-16', timestamp: '2026-05-26T16:00:00',
            meal_title: 'Early Dinner', total_calories: 300, total_protein: 20, total_carbs: 30
        });
        // Snack boundary: 22:00 (h=22, >=22 -> SNACK)
        await seedEntry(proxy.env.DB, TEST_USER_ID, {
            id: 'e-22', timestamp: '2026-05-26T22:00:00',
            meal_title: 'Late Snack', total_calories: 150, total_protein: 3, total_carbs: 20
        });
        // Snack: 03:00 (h=3, <4 -> SNACK)
        await seedEntry(proxy.env.DB, TEST_USER_ID, {
            id: 'e-3am', timestamp: '2026-05-26T03:00:00',
            meal_title: 'Midnight Snack', total_calories: 50, total_protein: 2, total_carbs: 8
        });

        const event = createMockEvent({ date: '2026-05-26' });
        const response = await GET(event);
        const body = await response.json();

        expect(body.groups.BREAKFAST).toBe(100);  // 04:00 only
        expect(body.groups.LUNCH).toBe(200);      // 11:00 only
        expect(body.groups.DINNER).toBe(300);      // 16:00 only
        expect(body.groups.SNACK).toBe(200);       // 22:00 + 03:00
    });

    it('calculates weekly data correctly', async () => {
        const { GET } = await import('./+server.js');

        // 2026-05-26 is a Tuesday. Week starts Sunday = 2026-05-24.
        // Sunday 2026-05-24 (day 0)
        await seedEntry(proxy.env.DB, TEST_USER_ID, {
            id: 'e-sun', timestamp: '2026-05-24T12:00:00',
            meal_title: 'Sunday Lunch', total_calories: 500, total_protein: 30, total_carbs: 50
        });
        // Monday 2026-05-25 (day 1)
        await seedEntry(proxy.env.DB, TEST_USER_ID, {
            id: 'e-mon', timestamp: '2026-05-25T12:00:00',
            meal_title: 'Monday Lunch', total_calories: 600, total_protein: 35, total_carbs: 60
        });
        // Tuesday 2026-05-26 (day 2) - "today"
        await seedEntry(proxy.env.DB, TEST_USER_ID, {
            id: 'e-tue', timestamp: '2026-05-26T12:00:00',
            meal_title: 'Tuesday Lunch', total_calories: 700, total_protein: 40, total_carbs: 70
        });

        const event = createMockEvent({ date: '2026-05-26' });
        const response = await GET(event);
        const body = await response.json();

        // weeklyData[0]=Sun, [1]=Mon, [2]=Tue
        expect(body.weeklyData[0]).toBe(500);  // Sunday
        expect(body.weeklyData[1]).toBe(600);  // Monday
        expect(body.weeklyData[2]).toBe(700);  // Tuesday
        expect(body.weeklyData[3]).toBe(0);    // Wed
        expect(body.weeklyData[4]).toBe(0);    // Thu
        expect(body.weeklyData[5]).toBe(0);    // Fri
        expect(body.weeklyData[6]).toBe(0);    // Sat

        expect(body.weeklyProteinData[0]).toBe(30);
        expect(body.weeklyProteinData[1]).toBe(35);
        expect(body.weeklyProteinData[2]).toBe(40);
    });

    it('handles date query param', async () => {
        const { GET } = await import('./+server.js');

        // Seed entries on two different dates
        await seedEntry(proxy.env.DB, TEST_USER_ID, {
            id: 'e-old', timestamp: '2026-05-20T12:00:00',
            meal_title: 'Old Lunch', total_calories: 400, total_protein: 25, total_carbs: 40
        });
        await seedEntry(proxy.env.DB, TEST_USER_ID, {
            id: 'e-new', timestamp: '2026-05-26T12:00:00',
            meal_title: 'New Lunch', total_calories: 800, total_protein: 50, total_carbs: 80
        });

        // Query for the old date
        const event = createMockEvent({ date: '2026-05-20' });
        const response = await GET(event);
        const body = await response.json();

        expect(body.todayTotal).toBe(400);
        expect(body.todayProtein).toBe(25);
    });

    it('uses tz cookie for date calculation when no date param', async () => {
        const { GET } = await import('./+server.js');

        // We just verify it does not crash and returns a valid response
        // when tz cookie is set and no date param is provided
        const event = createMockEvent({ tz: 'America/New_York' });
        const response = await GET(event);
        expect(response.status).toBe(200);
        const body = await response.json();
        expect(body.todayTotal).toBeDefined();
        expect(body.groups).toBeDefined();
        expect(body.weeklyData).toBeDefined();
    });

    it('does not include entries from other dates in today totals', async () => {
        const { GET } = await import('./+server.js');

        // Entry on a different date
        await seedEntry(proxy.env.DB, TEST_USER_ID, {
            id: 'e-other', timestamp: '2026-05-20T12:00:00',
            meal_title: 'Other Day', total_calories: 999, total_protein: 99, total_carbs: 99
        });
        // Entry on queried date
        await seedEntry(proxy.env.DB, TEST_USER_ID, {
            id: 'e-today', timestamp: '2026-05-26T12:00:00',
            meal_title: 'Today Meal', total_calories: 500, total_protein: 30, total_carbs: 40
        });

        const event = createMockEvent({ date: '2026-05-26' });
        const response = await GET(event);
        const body = await response.json();

        expect(body.todayTotal).toBe(500);
        expect(body.todayProtein).toBe(30);
    });

    it('aggregates multiple entries on the same day', async () => {
        const { GET } = await import('./+server.js');

        await seedEntry(proxy.env.DB, TEST_USER_ID, {
            id: 'e1', timestamp: '2026-05-26T08:00:00',
            meal_title: 'Breakfast', total_calories: 300, total_protein: 15, total_carbs: 40
        });
        await seedEntry(proxy.env.DB, TEST_USER_ID, {
            id: 'e2', timestamp: '2026-05-26T12:00:00',
            meal_title: 'Lunch', total_calories: 600, total_protein: 40, total_carbs: 60
        });
        await seedEntry(proxy.env.DB, TEST_USER_ID, {
            id: 'e3', timestamp: '2026-05-26T19:00:00',
            meal_title: 'Dinner', total_calories: 800, total_protein: 50, total_carbs: 30
        });

        const event = createMockEvent({ date: '2026-05-26' });
        const response = await GET(event);
        const body = await response.json();

        expect(body.todayTotal).toBe(1700);
        expect(body.todayProtein).toBe(105);
    });
});
