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
        request: new Request('http://localhost/api/export'),
        locals: {
            user: { id: TEST_USER_ID, email: TEST_USER_EMAIL },
            storage
        },
        platform: { env: proxy.env },
        url: new URL('http://localhost/api/export')
    };
}

describe('Export GET', () => {
    it('returns 401 without a user', async () => {
        const { GET } = await import('./+server.js');
        const event = createMockEvent();
        event.locals.user = null;

        const response = await GET(event);
        expect(response.status).toBe(401);
        const body = await response.json();
        expect(body.error).toBe('Unauthorized');
    });

    it('returns empty export for user with no entries', async () => {
        const { GET } = await import('./+server.js');
        const event = createMockEvent();

        const response = await GET(event);
        expect(response.status).toBe(200);
        const body = await response.json();

        expect(body.exportInfo).toBeDefined();
        expect(body.exportInfo.totalDays).toBe(0);
        expect(body.exportInfo.totalEntries).toBe(0);
        expect(body.dailyHistory).toEqual([]);
        expect(body.overallStats.averageDailyCalories).toBe(0);
        expect(body.overallStats.averageDailyProtein).toBe(0);
    });

    it('returns structured export with user profile and goals', async () => {
        const { GET } = await import('./+server.js');

        await seedEntry(proxy.env.DB, TEST_USER_ID, {
            id: 'e1', timestamp: '2026-05-25T12:00:00',
            meal_title: 'Lunch', total_calories: 600, total_protein: 40, total_carbs: 50
        });

        const event = createMockEvent();
        const response = await GET(event);
        expect(response.status).toBe(200);
        const body = await response.json();

        // exportInfo
        expect(body.exportInfo.totalDays).toBe(1);
        expect(body.exportInfo.totalEntries).toBe(1);
        expect(body.exportInfo.exportDate).toBeDefined();

        // userProfile reflects seeded settings
        expect(body.userProfile.goals.dailyCalories).toBe(2200);
        expect(body.userProfile.goals.dailyProtein).toBe(150);
        expect(body.userProfile.physicalStats.weight).toBe(180);
        expect(body.userProfile.physicalStats.weightUnit).toBe('lbs');
        expect(body.userProfile.physicalStats.age).toBe(30);
        expect(body.userProfile.physicalStats.gender).toBe('male');
        expect(body.userProfile.physicalStats.activityLevel).toBe('moderate');
        expect(body.userProfile.preferences.proteinFocusedMode).toBe(false);
    });

    it('correctly groups entries by date', async () => {
        const { GET } = await import('./+server.js');

        // Two entries on day 1, one on day 2
        await seedEntry(proxy.env.DB, TEST_USER_ID, {
            id: 'e1', timestamp: '2026-05-20T08:00:00',
            meal_title: 'Breakfast', total_calories: 400, total_protein: 25, total_carbs: 50
        });
        await seedEntry(proxy.env.DB, TEST_USER_ID, {
            id: 'e2', timestamp: '2026-05-20T12:30:00',
            meal_title: 'Lunch', total_calories: 600, total_protein: 35, total_carbs: 60
        });
        await seedEntry(proxy.env.DB, TEST_USER_ID, {
            id: 'e3', timestamp: '2026-05-21T19:00:00',
            meal_title: 'Dinner', total_calories: 700, total_protein: 45, total_carbs: 55
        });

        const event = createMockEvent();
        const response = await GET(event);
        const body = await response.json();

        expect(body.exportInfo.totalDays).toBe(2);
        expect(body.exportInfo.totalEntries).toBe(3);
        expect(body.dailyHistory.length).toBe(2);

        // Find the days by date
        const day20 = body.dailyHistory.find(d => d.date === '2026-05-20');
        const day21 = body.dailyHistory.find(d => d.date === '2026-05-21');

        expect(day20).toBeDefined();
        expect(day20.entries.length).toBe(2);
        expect(day20.totalCalories).toBe(1000);
        expect(day20.totalProtein).toBe(60);

        expect(day21).toBeDefined();
        expect(day21.entries.length).toBe(1);
        expect(day21.totalCalories).toBe(700);
        expect(day21.totalProtein).toBe(45);
    });

    it('calculates daily totals and percentages vs goals', async () => {
        const { GET } = await import('./+server.js');

        // Seed settings with known goals: 2200 cal, 150g protein
        await seedEntry(proxy.env.DB, TEST_USER_ID, {
            id: 'e1', timestamp: '2026-05-25T08:00:00',
            meal_title: 'Breakfast', total_calories: 500, total_protein: 30, total_carbs: 60
        });
        await seedEntry(proxy.env.DB, TEST_USER_ID, {
            id: 'e2', timestamp: '2026-05-25T13:00:00',
            meal_title: 'Lunch', total_calories: 700, total_protein: 45, total_carbs: 70
        });

        const event = createMockEvent();
        const response = await GET(event);
        const body = await response.json();

        const day = body.dailyHistory[0];
        expect(day.totalCalories).toBe(1200);
        expect(day.totalProtein).toBe(75);

        // Percentages: 1200/2200 = ~55%, 75/150 = 50%
        expect(day.percentages.caloriesPercent).toBe(Math.round((1200 / 2200) * 100));
        expect(day.percentages.proteinPercent).toBe(50);

        // Remaining
        expect(day.remaining.calories).toBe(1000);
        expect(day.remaining.protein).toBe(75);
    });

    it('calculates overall stats averages correctly', async () => {
        const { GET } = await import('./+server.js');

        // Day 1: 1000 cal, 60g protein
        await seedEntry(proxy.env.DB, TEST_USER_ID, {
            id: 'e1', timestamp: '2026-05-20T12:00:00',
            meal_title: 'Lunch', total_calories: 1000, total_protein: 60, total_carbs: 80
        });
        // Day 2: 2000 cal, 100g protein
        await seedEntry(proxy.env.DB, TEST_USER_ID, {
            id: 'e2', timestamp: '2026-05-21T12:00:00',
            meal_title: 'Lunch', total_calories: 2000, total_protein: 100, total_carbs: 120
        });

        const event = createMockEvent();
        const response = await GET(event);
        const body = await response.json();

        expect(body.overallStats.averageDailyCalories).toBe(1500); // (1000+2000)/2
        expect(body.overallStats.averageDailyProtein).toBe(80);    // (60+100)/2
        // vs goals: 1500/2200 ~ 68%, 80/150 ~ 53%
        expect(body.overallStats.averageCaloriesVsGoal).toBe(Math.round((1500 / 2200) * 100));
        expect(body.overallStats.averageProteinVsGoal).toBe(Math.round((80 / 150) * 100));
    });

    it('assigns correct mealType based on timestamp hour', async () => {
        const { GET } = await import('./+server.js');

        await seedEntry(proxy.env.DB, TEST_USER_ID, {
            id: 'breakfast', timestamp: '2026-05-25T08:00:00',
            meal_title: 'Morning Oats', total_calories: 300, total_protein: 10, total_carbs: 50
        });
        await seedEntry(proxy.env.DB, TEST_USER_ID, {
            id: 'lunch', timestamp: '2026-05-25T13:00:00',
            meal_title: 'Noon Salad', total_calories: 500, total_protein: 30, total_carbs: 40
        });
        await seedEntry(proxy.env.DB, TEST_USER_ID, {
            id: 'dinner', timestamp: '2026-05-25T19:00:00',
            meal_title: 'Evening Steak', total_calories: 800, total_protein: 60, total_carbs: 20
        });
        await seedEntry(proxy.env.DB, TEST_USER_ID, {
            id: 'snack', timestamp: '2026-05-25T23:30:00',
            meal_title: 'Late Snack', total_calories: 200, total_protein: 5, total_carbs: 30
        });

        const event = createMockEvent();
        const response = await GET(event);
        const body = await response.json();

        const day = body.dailyHistory[0];
        const types = day.entries.map(e => ({ title: e.mealTitle, type: e.mealType }));

        expect(types.find(t => t.title === 'Morning Oats').type).toBe('breakfast');
        expect(types.find(t => t.title === 'Noon Salad').type).toBe('lunch');
        expect(types.find(t => t.title === 'Evening Steak').type).toBe('dinner');
        expect(types.find(t => t.title === 'Late Snack').type).toBe('snack');
    });

    it('formats timeOfDay correctly', async () => {
        const { GET } = await import('./+server.js');

        await seedEntry(proxy.env.DB, TEST_USER_ID, {
            id: 'e-am', timestamp: '2026-05-25T09:15:00',
            meal_title: 'AM Meal', total_calories: 400, total_protein: 20, total_carbs: 50
        });
        await seedEntry(proxy.env.DB, TEST_USER_ID, {
            id: 'e-pm', timestamp: '2026-05-25T14:30:00',
            meal_title: 'PM Meal', total_calories: 500, total_protein: 30, total_carbs: 40
        });

        const event = createMockEvent();
        const response = await GET(event);
        const body = await response.json();

        const entries = body.dailyHistory[0].entries;
        const amEntry = entries.find(e => e.mealTitle === 'AM Meal');
        const pmEntry = entries.find(e => e.mealTitle === 'PM Meal');

        expect(amEntry.timeOfDay).toBe('09:15 AM');
        expect(pmEntry.timeOfDay).toBe('02:30 PM');
    });

    it('uses default goals when settings are missing', async () => {
        const { GET } = await import('./+server.js');

        // Clear settings for this test
        await proxy.env.DB.prepare('DELETE FROM user_settings WHERE user_id = ?').bind(TEST_USER_ID).run();

        await seedEntry(proxy.env.DB, TEST_USER_ID, {
            id: 'e1', timestamp: '2026-05-25T12:00:00',
            meal_title: 'Lunch', total_calories: 600, total_protein: 40, total_carbs: 50
        });

        const event = createMockEvent();
        const response = await GET(event);
        const body = await response.json();

        // Default goals: 2000 cal, 150g protein
        expect(body.userProfile.goals.dailyCalories).toBe(2000);
        expect(body.userProfile.goals.dailyProtein).toBe(150);
        expect(body.userProfile.physicalStats).toBeNull();

        const day = body.dailyHistory[0];
        expect(day.percentages.caloriesPercent).toBe(Math.round((600 / 2000) * 100));
    });

    it('includes items detail in entry data', async () => {
        const { GET } = await import('./+server.js');

        const items = [
            { name: 'Chicken breast', calories: 300, protein: 50, carbs: 0, fat: 8 },
            { name: 'Rice', calories: 200, protein: 4, carbs: 45, fat: 1 }
        ];

        await seedEntry(proxy.env.DB, TEST_USER_ID, {
            id: 'e-items', timestamp: '2026-05-25T12:00:00',
            meal_title: 'Chicken and Rice', total_calories: 500, total_protein: 54, total_carbs: 45,
            items
        });

        const event = createMockEvent();
        const response = await GET(event);
        const body = await response.json();

        const entry = body.dailyHistory[0].entries[0];
        expect(entry.items.length).toBe(2);
        expect(entry.items[0].name).toBe('Chicken breast');
        expect(entry.items[0].calories).toBe(300);
        expect(entry.items[1].name).toBe('Rice');
    });
});
