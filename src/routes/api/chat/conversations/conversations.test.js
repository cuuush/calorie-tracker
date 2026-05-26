import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import {
    applySchema, resetAll,
    TEST_USER_ID, TEST_USER_EMAIL
} from '../../../../tests/setup.js';
import { Storage } from '../../../../lib/server/storage.js';

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

function createGetEvent(user = { id: TEST_USER_ID, email: TEST_USER_EMAIL }) {
    return {
        request: new Request('http://localhost/api/chat/conversations', {
            method: 'GET'
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

describe('Conversations GET', () => {
    it('returns 401 without user', async () => {
        const { GET } = await import('./+server.js');
        const event = createGetEvent(null);
        event.locals.user = null;

        const response = await GET(event);
        expect(response.status).toBe(401);
        const data = await response.json();
        expect(data.error).toBe('Unauthorized');
    });

    it('returns empty array for user with no conversations', async () => {
        const { GET } = await import('./+server.js');
        const event = createGetEvent();

        const response = await GET(event);
        expect(response.status).toBe(200);
        const data = await response.json();
        expect(Array.isArray(data)).toBe(true);
        expect(data.length).toBe(0);
    });

    it('returns list of conversations', async () => {
        const { GET } = await import('./+server.js');

        // Seed conversations
        const id1 = await storage.createChatConversation(TEST_USER_ID, 'First Chat');
        const id2 = await storage.createChatConversation(TEST_USER_ID, 'Second Chat');

        // Save some messages to the second one
        await storage.saveChatConversation(id2, TEST_USER_ID, [
            { role: 'user', content: 'Hello' },
            { role: 'assistant', content: 'Hi there!' }
        ], 'Second Chat');

        const event = createGetEvent();
        const response = await GET(event);
        expect(response.status).toBe(200);

        const data = await response.json();
        expect(Array.isArray(data)).toBe(true);
        expect(data.length).toBe(2);

        // Should have id, title, updated_at, created_at but not messages
        for (const item of data) {
            expect(item.id).toBeDefined();
            expect(item.title).toBeDefined();
            expect(item.updated_at).toBeDefined();
            expect(item.created_at).toBeDefined();
            expect(item.messages).toBeUndefined();
        }

        // Check titles are present
        const titles = data.map(d => d.title);
        expect(titles).toContain('First Chat');
        expect(titles).toContain('Second Chat');
    });

    it('returns conversations ordered by updated_at desc', async () => {
        const { GET } = await import('./+server.js');

        const id1 = await storage.createChatConversation(TEST_USER_ID, 'Older Chat');
        const id2 = await storage.createChatConversation(TEST_USER_ID, 'Newer Chat');

        // Update the first one so it becomes "newer" by updated_at
        await storage.saveChatConversation(id1, TEST_USER_ID, [
            { role: 'user', content: 'Updated!' }
        ], 'Older Chat');

        const event = createGetEvent();
        const response = await GET(event);
        const data = await response.json();

        expect(data.length).toBe(2);
        // id1 was updated most recently so should come first
        expect(data[0].id).toBe(id1);
        expect(data[1].id).toBe(id2);
    });

    it('does not return conversations from other users', async () => {
        const { GET } = await import('./+server.js');

        // Seed a conversation for a different user
        const otherUserId = 'other-user-456';
        await proxy.env.DB.prepare(`
            INSERT OR IGNORE INTO users (id, email, created_at, updated_at)
            VALUES (?, ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
        `).bind(otherUserId, 'other@example.com').run();

        await storage.createChatConversation(otherUserId, 'Other User Chat');
        await storage.createChatConversation(TEST_USER_ID, 'My Chat');

        const event = createGetEvent();
        const response = await GET(event);
        const data = await response.json();

        expect(data.length).toBe(1);
        expect(data[0].title).toBe('My Chat');
    });
});
