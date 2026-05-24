import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { applySchema, resetAll, TEST_USER_ID, seedSettings, seedEntry } from '../../tests/setup.js';
import { Storage } from './storage.js';

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

describe('Storage.saveEntry + getEntryDetails', () => {
    it('round-trips a nutrition entry through D1 + R2', async () => {
        const entry = {
            id: 'test-entry-1',
            timestamp: '2026-05-24T12:00:00',
            user_message: 'chicken and rice',
            meal_title: 'Chicken and Rice',
            total_calories: 500,
            total_protein: 40,
            total_carbs: 50,
            items: [
                { name: 'Grilled Chicken', calories: 300, protein: 35, carbs: 0 },
                { name: 'Brown Rice', calories: 200, protein: 5, carbs: 50 }
            ]
        };

        await storage.saveEntry(entry, TEST_USER_ID);
        const details = await storage.getEntryDetails('test-entry-1', TEST_USER_ID);

        expect(details).toBeDefined();
        expect(details.meal_title).toBe('Chicken and Rice');
        expect(details.total_calories).toBe(500);
        expect(details.total_protein).toBe(40);
        expect(details.items).toHaveLength(2);
        expect(details.items[0].name).toBe('Grilled Chicken');
    });

    it('updates an existing entry via upsert', async () => {
        const entry = {
            id: 'test-entry-2',
            timestamp: '2026-05-24T08:00:00',
            meal_title: 'Oatmeal',
            total_calories: 300,
            total_protein: 10,
            total_carbs: 50,
            items: [{ name: 'Oatmeal', calories: 300, protein: 10, carbs: 50 }]
        };

        await storage.saveEntry(entry, TEST_USER_ID);
        await storage.saveEntry({ ...entry, meal_title: 'Updated Oatmeal', total_calories: 350 }, TEST_USER_ID);

        const details = await storage.getEntryDetails('test-entry-2', TEST_USER_ID);
        expect(details.meal_title).toBe('Updated Oatmeal');
        expect(details.total_calories).toBe(350);
    });
});

describe('Storage.getHistory', () => {
    it('returns entries newest first', async () => {
        await seedEntry(proxy.env.DB, TEST_USER_ID, {
            id: 'e1', timestamp: '2026-05-24T08:00:00', meal_title: 'Breakfast', total_calories: 300, total_protein: 20, total_carbs: 40
        });
        await seedEntry(proxy.env.DB, TEST_USER_ID, {
            id: 'e2', timestamp: '2026-05-24T12:00:00', meal_title: 'Lunch', total_calories: 600, total_protein: 45, total_carbs: 60
        });

        const history = await storage.getHistory(TEST_USER_ID);
        expect(history).toHaveLength(2);
        expect(history[0].meal_title).toBe('Lunch');
        expect(history[1].meal_title).toBe('Breakfast');
    });
});

describe('Storage.getEntriesBetween', () => {
    it('filters entries by date range', async () => {
        await seedEntry(proxy.env.DB, TEST_USER_ID, {
            id: 'e1', timestamp: '2026-05-23T12:00:00', meal_title: 'Yesterday Lunch', total_calories: 500
        });
        await seedEntry(proxy.env.DB, TEST_USER_ID, {
            id: 'e2', timestamp: '2026-05-24T08:00:00', meal_title: 'Today Breakfast', total_calories: 300
        });
        await seedEntry(proxy.env.DB, TEST_USER_ID, {
            id: 'e3', timestamp: '2026-05-24T19:00:00', meal_title: 'Today Dinner', total_calories: 700
        });

        const todayEntries = await storage.getEntriesBetween(
            TEST_USER_ID, '2026-05-24T00:00:00', '2026-05-24T23:59:59'
        );
        expect(todayEntries).toHaveLength(2);
        expect(todayEntries.map(e => e.meal_title)).toContain('Today Breakfast');
        expect(todayEntries.map(e => e.meal_title)).toContain('Today Dinner');
    });
});

describe('Storage chat conversations', () => {
    it('creates, saves, and retrieves a conversation', async () => {
        const convoId = await storage.createChatConversation(TEST_USER_ID, 'Test Chat');
        expect(convoId).toBeDefined();

        const messages = [
            { role: 'user', content: 'How much protein today?' },
            { role: 'assistant', content: "You've had 60g so far." }
        ];
        await storage.saveChatConversation(convoId, TEST_USER_ID, messages, 'Test Chat');

        const convo = await storage.getChatConversation(convoId, TEST_USER_ID);
        expect(convo).toBeDefined();
        expect(convo.title).toBe('Test Chat');
        const parsed = typeof convo.messages === 'string' ? JSON.parse(convo.messages) : convo.messages;
        expect(parsed).toHaveLength(2);
        expect(parsed[0].role).toBe('user');
        expect(parsed[1].content).toContain('60g');
    });

    it('persists tool_calls and tool messages in conversation', async () => {
        const convoId = await storage.createChatConversation(TEST_USER_ID, 'Tool Chat');

        const messages = [
            { role: 'user', content: 'Weekly summary please' },
            {
                role: 'assistant',
                content: null,
                tool_calls: [{
                    id: 'call_1',
                    type: 'function',
                    function: { name: 'get_meals_last_7_days', arguments: '{}' }
                }]
            },
            {
                role: 'tool',
                tool_call_id: 'call_1',
                content: JSON.stringify({ entries: [], count: 0 })
            },
            { role: 'assistant', content: 'Here is your summary.' }
        ];
        await storage.saveChatConversation(convoId, TEST_USER_ID, messages, 'Tool Chat');

        const convo = await storage.getChatConversation(convoId, TEST_USER_ID);
        const parsed = typeof convo.messages === 'string' ? JSON.parse(convo.messages) : convo.messages;
        expect(parsed).toHaveLength(4);
        expect(parsed[1].tool_calls).toBeDefined();
        expect(parsed[1].tool_calls[0].function.name).toBe('get_meals_last_7_days');
        expect(parsed[2].role).toBe('tool');
        expect(parsed[2].tool_call_id).toBe('call_1');
    });

    it('lists conversations', async () => {
        await storage.createChatConversation(TEST_USER_ID, 'Chat 1');
        await storage.createChatConversation(TEST_USER_ID, 'Chat 2');

        const list = await storage.listChatConversations(TEST_USER_ID);
        expect(list.length).toBeGreaterThanOrEqual(2);
    });

    it('deletes a conversation', async () => {
        const convoId = await storage.createChatConversation(TEST_USER_ID, 'To Delete');
        await storage.deleteChatConversation(convoId, TEST_USER_ID);

        const convo = await storage.getChatConversation(convoId, TEST_USER_ID);
        expect(convo).toBeNull();
    });
});

describe('Storage.getUserSettings with KV caching', () => {
    it('returns settings from D1', async () => {
        await seedSettings(proxy.env.DB, TEST_USER_ID, {
            protein_goal: 180,
            maintenance_calories: 2500
        });

        const settings = await storage.getUserSettings(TEST_USER_ID);
        expect(settings).toBeDefined();
        expect(settings.protein_goal).toBe(180);
        expect(settings.maintenance_calories).toBe(2500);
    });
});

describe('Storage.deleteEntry', () => {
    it('removes entry from D1 and R2', async () => {
        const entry = {
            id: 'to-delete',
            timestamp: '2026-05-24T12:00:00',
            meal_title: 'To Delete',
            total_calories: 100,
            items: []
        };
        await storage.saveEntry(entry, TEST_USER_ID);

        let details = await storage.getEntryDetails('to-delete', TEST_USER_ID);
        expect(details).toBeDefined();

        await storage.deleteEntry('to-delete', TEST_USER_ID);

        details = await storage.getEntryDetails('to-delete', TEST_USER_ID);
        expect(details).toBeNull();
    });
});
