import { describe, it, expect, vi, beforeAll, afterAll, beforeEach, afterEach } from 'vitest';
import {
    applySchema, resetAll, seedSettings, seedEntry,
    TEST_USER_ID, TEST_USER_EMAIL
} from '../../../tests/setup.js';
import {
    createTextStreamChunks, createToolCallStreamChunks, mockFetchSSE
} from '../../../tests/mocks/llm.js';
import { Storage } from '../../../lib/server/storage.js';

let proxy, storage;
const originalFetch = globalThis.fetch;

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

afterEach(() => {
    globalThis.fetch = originalFetch;
});

afterAll(async () => {
    await proxy.dispose();
});

function createMockEvent(body) {
    return {
        request: new Request('http://localhost/api/chat', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(body)
        }),
        locals: {
            user: { id: TEST_USER_ID, email: TEST_USER_EMAIL },
            storage
        },
        platform: {
            env: { ...proxy.env, OPENROUTER_API_KEY: 'test-key' },
            context: { waitUntil: () => {} }
        },
        cookies: { get: () => null, set: () => {}, delete: () => {} },
        url: new URL('http://localhost/api/chat')
    };
}

async function consumeSSE(response) {
    const text = await response.text();
    const events = [];
    for (const line of text.split('\n')) {
        if (line.startsWith('data: ')) {
            try {
                const data = JSON.parse(line.slice(6));
                events.push(data);
            } catch {}
        }
        if (line.startsWith('event: ')) {
            events.push({ _event: line.slice(7) });
        }
    }
    return { text, events };
}

async function consumeSSEParsed(response) {
    const text = await response.text();
    const parsed = [];
    const lines = text.split('\n');
    let currentEvent = null;
    for (const line of lines) {
        if (line.startsWith('event: ')) {
            currentEvent = line.slice(7);
        } else if (line.startsWith('data: ')) {
            try {
                parsed.push({ event: currentEvent, data: JSON.parse(line.slice(6)) });
            } catch {}
            currentEvent = null;
        }
    }
    return parsed;
}

describe('Chat endpoint POST', () => {
    it('returns 401 without a user', async () => {
        const { POST } = await import('./+server.js');
        const event = createMockEvent({
            messages: [{ role: 'user', content: 'hi' }],
            clientNow: '2026-05-24T12:00:00',
            timezone: 'America/New_York'
        });
        event.locals.user = null;

        const response = await POST(event);
        expect(response.status).toBe(401);
    });

    it('returns 400 with missing fields', async () => {
        const { POST } = await import('./+server.js');
        const event = createMockEvent({ messages: [] });
        // missing clientNow and timezone
        const response = await POST(event);
        expect(response.status).toBe(400);
    });

    it('persists a simple text conversation correctly', async () => {
        globalThis.fetch = mockFetchSSE([
            createTextStreamChunks('Great question! You had 60g protein today.')
        ]);

        const { POST } = await import('./+server.js');
        const event = createMockEvent({
            messages: [{ role: 'user', content: 'How much protein today?' }],
            clientNow: '2026-05-24T12:00:00',
            timezone: 'America/New_York'
        });

        const response = await POST(event);
        expect(response.status).toBe(200);

        const parsed = await consumeSSEParsed(response);
        const convoEvent = parsed.find(e => e.event === 'conversation');
        expect(convoEvent).toBeDefined();
        const convoId = convoEvent.data.id;

        const doneEvent = parsed.find(e => e.event === 'done');
        expect(doneEvent).toBeDefined();

        const convo = await storage.getChatConversation(convoId, TEST_USER_ID);
        expect(convo).toBeDefined();
        expect(convo.messages.length).toBeGreaterThanOrEqual(2);
        const userMsg = convo.messages.find(m => m.role === 'user');
        expect(userMsg.content).toBe('How much protein today?');
        const assistantMsg = convo.messages.find(m => m.role === 'assistant' && m.content);
        expect(assistantMsg.content).toContain('60g protein');
    });

    it('persists tool_calls and tool messages in conversation (bug regression)', async () => {
        await seedEntry(proxy.env.DB, TEST_USER_ID, {
            id: 'e-week1',
            timestamp: '2026-05-20T12:00:00',
            meal_title: 'Past Lunch',
            total_calories: 600,
            total_protein: 40,
            total_carbs: 60
        });

        globalThis.fetch = mockFetchSSE([
            createToolCallStreamChunks('get_meals_last_7_days', {}),
            createTextStreamChunks('Based on your meals this week, you averaged 600 calories per day.')
        ]);

        const { POST } = await import('./+server.js');
        const event = createMockEvent({
            messages: [{ role: 'user', content: 'Show me my weekly summary' }],
            clientNow: '2026-05-24T12:00:00',
            timezone: 'America/New_York'
        });

        const response = await POST(event);
        expect(response.status).toBe(200);

        const parsed = await consumeSSEParsed(response);
        const convoId = parsed.find(e => e.event === 'conversation').data.id;

        const convo = await storage.getChatConversation(convoId, TEST_USER_ID);
        expect(convo).toBeDefined();

        const messages = convo.messages;
        const hasToolCallsMsg = messages.some(m => m.tool_calls && m.tool_calls.length > 0);
        const hasToolResultMsg = messages.some(m => m.role === 'tool');
        const hasUserMsg = messages.some(m => m.role === 'user');
        const hasFinalAssistant = messages.some(m => m.role === 'assistant' && m.content && m.content.includes('averaged'));

        expect(hasUserMsg).toBe(true);
        expect(hasToolCallsMsg).toBe(true);
        expect(hasToolResultMsg).toBe(true);
        expect(hasFinalAssistant).toBe(true);
    });

    it('follow-up message after tool call has tool results in context', async () => {
        const convoId = await storage.createChatConversation(TEST_USER_ID, 'Tool Chat');
        const existingMessages = [
            { role: 'user', content: 'Weekly summary' },
            {
                role: 'assistant',
                content: null,
                tool_calls: [{ id: 'call_1', type: 'function', function: { name: 'get_meals_last_7_days', arguments: '{}' } }]
            },
            { role: 'tool', tool_call_id: 'call_1', content: '{"entries":[],"count":0}' },
            { role: 'assistant', content: 'No meals logged last week.' }
        ];
        await storage.saveChatConversation(convoId, TEST_USER_ID, existingMessages, 'Tool Chat');

        const loaded = await storage.getChatConversation(convoId, TEST_USER_ID);
        const msgs = loaded.messages;

        expect(msgs.some(m => m.tool_calls)).toBe(true);
        expect(msgs.some(m => m.role === 'tool')).toBe(true);
        expect(msgs).toHaveLength(4);
    });

    it('respects MAX_TURNS limit to prevent infinite tool loops', async () => {
        const toolChunks = createToolCallStreamChunks('get_meals_last_7_days', {});
        const mockFn = mockFetchSSE([
            toolChunks, toolChunks, toolChunks, toolChunks, toolChunks
        ]);
        let callCount = 0;
        globalThis.fetch = async (...args) => {
            callCount++;
            return mockFn(...args);
        };

        const { POST } = await import('./+server.js');
        const event = createMockEvent({
            messages: [{ role: 'user', content: 'Keep calling tools forever' }],
            clientNow: '2026-05-24T12:00:00',
            timezone: 'America/New_York'
        });

        const response = await POST(event);
        expect(response.status).toBe(200);
        await response.text();

        expect(callCount).toBeGreaterThan(0);
        expect(callCount).toBeLessThanOrEqual(4);
    });

    it('preserves tool_calls and tool_call_id in follow-up messages sent to OpenRouter', async () => {
        let capturedBody = null;
        globalThis.fetch = async (url, opts) => {
            if (typeof url === 'string' && url.includes('openrouter.ai')) {
                capturedBody = JSON.parse(opts.body);
                const body = createStreamChunks(
                    createTextStreamChunks('You averaged 600 cal last week.')
                );
                return new Response(body, {
                    status: 200,
                    headers: { 'Content-Type': 'text/event-stream' }
                });
            }
            throw new Error(`Unexpected fetch to: ${url}`);
        };

        const { POST } = await import('./+server.js');
        const event = createMockEvent({
            messages: [
                { role: 'user', content: 'Weekly summary' },
                {
                    role: 'assistant',
                    content: null,
                    tool_calls: [{ id: 'call_1', type: 'function', function: { name: 'get_meals_last_7_days', arguments: '{}' } }]
                },
                { role: 'tool', tool_call_id: 'call_1', content: '{"entries":[{"date":"2026-05-20","meal_title":"Lunch","calories":600}],"count":1}' },
                { role: 'assistant', content: 'You had 600 cal on Tuesday.' },
                { role: 'user', content: 'What about protein?' }
            ],
            clientNow: '2026-05-24T12:00:00',
            timezone: 'America/New_York'
        });

        const response = await POST(event);
        expect(response.status).toBe(200);
        await response.text();

        expect(capturedBody).not.toBeNull();
        const msgs = capturedBody.messages;

        const toolCallMsg = msgs.find(m => m.tool_calls);
        expect(toolCallMsg).toBeDefined();
        expect(toolCallMsg.tool_calls[0].function.name).toBe('get_meals_last_7_days');

        const toolResultMsg = msgs.find(m => m.role === 'tool');
        expect(toolResultMsg).toBeDefined();
        expect(toolResultMsg.tool_call_id).toBe('call_1');
        expect(toolResultMsg.content).toContain('600');
    });
});
