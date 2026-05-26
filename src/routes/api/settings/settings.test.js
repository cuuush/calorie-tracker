import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import {
    applySchema, resetAll, seedSettings,
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

function createGetEvent() {
    return {
        request: new Request('http://localhost/api/settings'),
        locals: {
            user: { id: TEST_USER_ID, email: TEST_USER_EMAIL },
            storage
        },
        platform: { env: proxy.env },
        url: new URL('http://localhost/api/settings')
    };
}

function createPostEvent(body) {
    return {
        request: new Request('http://localhost/api/settings', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(body)
        }),
        locals: {
            user: { id: TEST_USER_ID, email: TEST_USER_EMAIL },
            storage
        },
        platform: { env: proxy.env },
        url: new URL('http://localhost/api/settings')
    };
}

describe('Settings GET', () => {
    it('returns 401 without a user', async () => {
        const { GET } = await import('./+server.js');
        const event = createGetEvent();
        event.locals.user = null;

        const response = await GET(event);
        expect(response.status).toBe(401);
        const body = await response.json();
        expect(body.error).toBe('Unauthorized');
    });

    it('returns empty object for user with no settings', async () => {
        const { GET } = await import('./+server.js');
        const event = createGetEvent();

        const response = await GET(event);
        expect(response.status).toBe(200);
        const body = await response.json();
        expect(body).toEqual({});
    });

    it('returns settings for user', async () => {
        const { GET } = await import('./+server.js');

        await seedSettings(proxy.env.DB, TEST_USER_ID, {
            weight: 180,
            weight_unit: 'lbs',
            height: 72,
            height_unit: 'in',
            age: 30,
            gender: 'male',
            activity_level: 'moderate',
            maintenance_calories: 2200,
            protein_goal: 150,
            protein_focused_mode: 0,
            goals: 'lose fat, build muscle'
        });

        const event = createGetEvent();
        const response = await GET(event);
        expect(response.status).toBe(200);
        const body = await response.json();

        expect(body.user_id).toBe(TEST_USER_ID);
        expect(body.weight).toBe(180);
        expect(body.weight_unit).toBe('lbs');
        expect(body.height).toBe(72);
        expect(body.height_unit).toBe('in');
        expect(body.age).toBe(30);
        expect(body.gender).toBe('male');
        expect(body.activity_level).toBe('moderate');
        expect(body.maintenance_calories).toBe(2200);
        expect(body.protein_goal).toBe(150);
        expect(body.protein_focused_mode).toBe(0);
        expect(body.goals).toBe('lose fat, build muscle');
    });
});

describe('Settings POST', () => {
    it('returns 401 without a user', async () => {
        const { POST } = await import('./+server.js');
        const event = createPostEvent({ weight: 180 });
        event.locals.user = null;

        const response = await POST(event);
        expect(response.status).toBe(401);
        const body = await response.json();
        expect(body.error).toBe('Unauthorized');
    });

    it('saves new settings', async () => {
        const { POST } = await import('./+server.js');
        const newSettings = {
            weight: 200,
            weight_unit: 'lbs',
            height: 70,
            height_unit: 'in',
            age: 35,
            gender: 'female',
            activity_level: 'high',
            maintenance_calories: 2500,
            protein_goal: 180,
            protein_focused_mode: 1,
            goals: 'gain muscle'
        };

        const event = createPostEvent(newSettings);
        const response = await POST(event);
        expect(response.status).toBe(200);
        const body = await response.json();

        expect(body.weight).toBe(200);
        expect(body.weight_unit).toBe('lbs');
        expect(body.age).toBe(35);
        expect(body.gender).toBe('female');
        expect(body.activity_level).toBe('high');
        expect(body.maintenance_calories).toBe(2500);
        expect(body.protein_goal).toBe(180);
        expect(body.protein_focused_mode).toBe(1);
        expect(body.goals).toBe('gain muscle');
    });

    it('updates existing settings', async () => {
        const { POST } = await import('./+server.js');

        // First, seed initial settings
        await seedSettings(proxy.env.DB, TEST_USER_ID, {
            weight: 180,
            maintenance_calories: 2200,
            protein_goal: 150
        });

        // Update some fields
        const updatedSettings = {
            weight: 175,
            weight_unit: 'lbs',
            height: 72,
            height_unit: 'in',
            age: 30,
            gender: 'male',
            activity_level: 'high',
            maintenance_calories: 2400,
            protein_goal: 160,
            protein_focused_mode: 1,
            goals: 'updated goals'
        };

        const event = createPostEvent(updatedSettings);
        const response = await POST(event);
        expect(response.status).toBe(200);
        const body = await response.json();

        expect(body.weight).toBe(175);
        expect(body.maintenance_calories).toBe(2400);
        expect(body.protein_goal).toBe(160);
        expect(body.protein_focused_mode).toBe(1);
        expect(body.goals).toBe('updated goals');
    });

    it('persists settings so GET returns updated values', async () => {
        const { GET, POST } = await import('./+server.js');

        const newSettings = {
            weight: 190,
            weight_unit: 'kg',
            height: 180,
            height_unit: 'cm',
            age: 28,
            gender: 'male',
            activity_level: 'low',
            maintenance_calories: 1800,
            protein_goal: 120,
            protein_focused_mode: 0,
            goals: 'maintain weight'
        };

        // POST new settings
        const postEvent = createPostEvent(newSettings);
        const postResponse = await POST(postEvent);
        expect(postResponse.status).toBe(200);

        // GET should return the same values
        const getEvent = createGetEvent();
        const getResponse = await GET(getEvent);
        expect(getResponse.status).toBe(200);
        const body = await getResponse.json();

        expect(body.weight).toBe(190);
        expect(body.weight_unit).toBe('kg');
        expect(body.height).toBe(180);
        expect(body.height_unit).toBe('cm');
        expect(body.age).toBe(28);
        expect(body.gender).toBe('male');
        expect(body.activity_level).toBe('low');
        expect(body.maintenance_calories).toBe(1800);
        expect(body.protein_goal).toBe(120);
        expect(body.goals).toBe('maintain weight');
    });

    it('handles partial settings with defaults', async () => {
        const { POST } = await import('./+server.js');

        // POST with only a few fields, others should get defaults
        const partialSettings = {
            weight: 170,
            age: 25
        };

        const event = createPostEvent(partialSettings);
        const response = await POST(event);
        expect(response.status).toBe(200);
        const body = await response.json();

        expect(body.weight).toBe(170);
        expect(body.age).toBe(25);
        // Defaults from saveUserSettings
        expect(body.weight_unit).toBe('lbs');
        expect(body.height_unit).toBe('in');
        expect(body.protein_goal).toBe(150);
        expect(body.protein_focused_mode).toBe(0);
    });

    it('GET after POST returns updated values (full round trip)', async () => {
        const { GET, POST } = await import('./+server.js');

        // Start with no settings
        const getEvent1 = createGetEvent();
        const response1 = await GET(getEvent1);
        const body1 = await response1.json();
        expect(body1).toEqual({});

        // POST settings
        const settings = {
            weight: 165,
            weight_unit: 'lbs',
            height: 68,
            height_unit: 'in',
            age: 40,
            gender: 'female',
            activity_level: 'moderate',
            maintenance_calories: 1900,
            protein_goal: 130,
            protein_focused_mode: 0,
            goals: 'general health'
        };
        const postEvent = createPostEvent(settings);
        await POST(postEvent);

        // GET again
        const getEvent2 = createGetEvent();
        const response2 = await GET(getEvent2);
        const body2 = await response2.json();

        expect(body2.weight).toBe(165);
        expect(body2.age).toBe(40);
        expect(body2.gender).toBe('female');
        expect(body2.maintenance_calories).toBe(1900);
        expect(body2.protein_goal).toBe(130);
        expect(body2.goals).toBe('general health');

        // POST updated settings
        const updatedSettings = {
            ...settings,
            weight: 160,
            maintenance_calories: 1850,
            goals: 'lose 5 lbs'
        };
        const postEvent2 = createPostEvent(updatedSettings);
        await POST(postEvent2);

        // GET should reflect the update
        const getEvent3 = createGetEvent();
        const response3 = await GET(getEvent3);
        const body3 = await response3.json();

        expect(body3.weight).toBe(160);
        expect(body3.maintenance_calories).toBe(1850);
        expect(body3.goals).toBe('lose 5 lbs');
    });
});
