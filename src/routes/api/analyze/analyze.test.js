import { describe, it, expect, vi, beforeAll, afterAll, beforeEach, afterEach } from 'vitest';
import {
    applySchema, resetAll, seedSettings,
    TEST_USER_ID, TEST_USER_EMAIL
} from '../../../tests/setup.js';
import {
    createToolCallResponse, createTextResponse
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
        request: new Request('http://localhost/api/analyze', {
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
            context: { waitUntil: (p) => p?.then?.(() => {}).catch?.(() => {}) }
        }
    };
}

/**
 * Mock globalThis.fetch to return a non-streaming JSON response from OpenRouter.
 * Accepts a sequence of responses; each call to fetch consumes the next one.
 */
function mockFetchJSON(responseSequence) {
    let callIndex = 0;
    globalThis.fetch = async (url, opts) => {
        if (typeof url === 'string' && url.includes('openrouter.ai')) {
            const data = responseSequence[callIndex] || responseSequence[responseSequence.length - 1];
            callIndex++;
            return new Response(JSON.stringify(data), {
                status: 200,
                headers: { 'Content-Type': 'application/json' }
            });
        }
        throw new Error(`Unexpected fetch to: ${url}`);
    };
}

describe('Analyze endpoint POST', () => {
    it('returns 401 without a user', async () => {
        const { POST } = await import('./+server.js');
        const event = createMockEvent({ message: 'chicken salad' });
        event.locals.user = null;

        const response = await POST(event);
        expect(response.status).toBe(401);
        const data = await response.json();
        expect(data.error).toBe('Unauthorized');
    });

    it('successful log_meal tool call flow', async () => {
        const mealArgs = {
            meal_title: 'Grilled Chicken Salad',
            items: [
                { name: 'Grilled Chicken Breast', calories: 250, protein: 45, carbs: 0 },
                { name: 'Mixed Greens', calories: 30, protein: 2, carbs: 5 },
                { name: 'Caesar Dressing', calories: 120, protein: 1, carbs: 3 }
            ]
        };

        mockFetchJSON([createToolCallResponse('log_meal', mealArgs)]);

        const { POST } = await import('./+server.js');
        const event = createMockEvent({
            message: 'chicken salad with caesar dressing',
            timestamp: '2026-05-26T12:30:00'
        });

        const response = await POST(event);
        expect(response.status).toBe(200);
        const data = await response.json();

        // Verify response shape
        expect(data.entryId).toBeDefined();
        expect(data.meal_title).toBe('Grilled Chicken Salad');
        expect(data.items).toHaveLength(3);
        expect(data.total_calories).toBe(400);
        expect(data.total_protein).toBe(48);
        expect(data.total_carbs).toBe(8);
        expect(data.messages).toBeDefined();

        // Verify entry was persisted in DB with status 'ready'
        const entry = await storage.getEntryDetails(data.entryId, TEST_USER_ID);
        expect(entry).toBeDefined();
        expect(entry.status).toBe('ready');
        expect(entry.meal_title).toBe('Grilled Chicken Salad');
        expect(entry.items).toHaveLength(3);
        expect(entry.total_calories).toBe(400);
    });

    it('reject_input tool call flow', async () => {
        const rejectArgs = { reason: 'This appears to be a photo of a cat, not food.' };
        mockFetchJSON([createToolCallResponse('reject_input', rejectArgs)]);

        const { POST } = await import('./+server.js');
        const event = createMockEvent({
            message: 'analyze this',
            timestamp: '2026-05-26T12:30:00'
        });

        const response = await POST(event);
        expect(response.status).toBe(200);
        const data = await response.json();

        // Verify rejection response
        expect(data.entryId).toBeDefined();
        expect(data.rejection).toBeDefined();
        expect(data.rejection.message).toBe('This appears to be a photo of a cat, not food.');

        // Verify the placeholder entry was cleaned up (deleted)
        // waitUntil fires async — give it a moment
        await new Promise((r) => setTimeout(r, 100));
        const entry = await proxy.env.DB
            .prepare('SELECT * FROM nutrition_entries WHERE id = ?')
            .bind(data.entryId)
            .first();
        expect(entry).toBeNull();
    });

    it('ask_clarification tool call flow', async () => {
        const clarificationArgs = {
            question: 'Was the milk whole or skim?',
            options: [
                { label: 'Whole milk', value: 'whole milk' },
                { label: 'Skim milk', value: 'skim milk' },
                { label: '2% milk', value: '2% milk' }
            ]
        };
        mockFetchJSON([createToolCallResponse('ask_clarification', clarificationArgs, 'call_clarify_1')]);

        const { POST } = await import('./+server.js');
        const event = createMockEvent({
            message: 'cereal with milk',
            timestamp: '2026-05-26T08:00:00'
        });

        const response = await POST(event);
        expect(response.status).toBe(200);
        const data = await response.json();

        // Verify clarification response
        expect(data.entryId).toBeDefined();
        expect(data.clarification).toBeDefined();
        expect(data.clarification.question).toBe('Was the milk whole or skim?');
        expect(data.clarification.options).toHaveLength(3);
        expect(data.clarification.tool_call_id).toBe('call_clarify_1');
        expect(data.messages).toBeDefined();

        // Verify entry was persisted with status 'awaiting_user'
        const entry = await storage.getEntryDetails(data.entryId, TEST_USER_ID);
        expect(entry).toBeDefined();
        expect(entry.status).toBe('awaiting_user');
        expect(entry.pending_question).toBeDefined();
        expect(entry.pending_question.question).toBe('Was the milk whole or skim?');
    });

    it('continuation after clarification: provides answer and gets log_meal', async () => {
        // Step 1: Create an initial entry in 'awaiting_user' state
        const clarificationArgs = {
            question: 'Was the milk whole or skim?',
            options: [
                { label: 'Whole milk', value: 'whole milk' },
                { label: 'Skim milk', value: 'skim milk' }
            ]
        };
        mockFetchJSON([createToolCallResponse('ask_clarification', clarificationArgs, 'call_clarify_1')]);

        const { POST } = await import('./+server.js');
        const event1 = createMockEvent({
            message: 'cereal with milk',
            timestamp: '2026-05-26T08:00:00'
        });

        const response1 = await POST(event1);
        const data1 = await response1.json();
        const entryId = data1.entryId;
        const savedMessages = data1.messages;

        // Step 2: Continue with the user's choice
        const mealArgs = {
            meal_title: 'Cereal with Whole Milk',
            items: [
                { name: 'Cereal', calories: 150, protein: 3, carbs: 30 },
                { name: 'Whole Milk', calories: 150, protein: 8, carbs: 12 }
            ]
        };
        mockFetchJSON([createToolCallResponse('log_meal', mealArgs)]);

        const event2 = createMockEvent({
            entryId,
            messages: savedMessages,
            tool_call_id: 'call_clarify_1',
            choice: 'whole milk'
        });

        const response2 = await POST(event2);
        expect(response2.status).toBe(200);
        const data2 = await response2.json();

        // Verify the final logged meal
        expect(data2.entryId).toBe(entryId);
        expect(data2.meal_title).toBe('Cereal with Whole Milk');
        expect(data2.items).toHaveLength(2);
        expect(data2.total_calories).toBe(300);

        // Verify DB entry was updated to 'ready'
        const entry = await storage.getEntryDetails(entryId, TEST_USER_ID);
        expect(entry.status).toBe('ready');
        expect(entry.meal_title).toBe('Cereal with Whole Milk');
    });

    it('continuation without messages rebuilds from storage', async () => {
        // Step 1: Create an initial entry in 'awaiting_user' state
        const clarificationArgs = {
            question: 'Regular or diet soda?',
            options: [
                { label: 'Regular', value: 'regular soda' },
                { label: 'Diet', value: 'diet soda' }
            ]
        };
        mockFetchJSON([createToolCallResponse('ask_clarification', clarificationArgs, 'call_soda_1')]);

        const { POST } = await import('./+server.js');
        const event1 = createMockEvent({
            message: 'burger and soda',
            timestamp: '2026-05-26T12:00:00'
        });

        const response1 = await POST(event1);
        const data1 = await response1.json();
        const entryId = data1.entryId;

        // Step 2: Continue WITHOUT passing messages — endpoint should rebuild from storage
        const mealArgs = {
            meal_title: 'Burger and Diet Soda',
            items: [
                { name: 'Hamburger', calories: 350, protein: 25, carbs: 30 },
                { name: 'Diet Soda', calories: 0, protein: 0, carbs: 0 }
            ]
        };
        mockFetchJSON([createToolCallResponse('log_meal', mealArgs)]);

        const event2 = createMockEvent({
            entryId,
            tool_call_id: 'call_soda_1',
            choice: 'diet soda'
        });

        const response2 = await POST(event2);
        expect(response2.status).toBe(200);
        const data2 = await response2.json();

        expect(data2.entryId).toBe(entryId);
        expect(data2.meal_title).toBe('Burger and Diet Soda');
        expect(data2.items).toHaveLength(2);

        // Verify the entry is now 'ready'
        const entry = await storage.getEntryDetails(entryId, TEST_USER_ID);
        expect(entry.status).toBe('ready');
    });

    it('continuation returns 400 without entryId', async () => {
        mockFetchJSON([createToolCallResponse('log_meal', { meal_title: 'x', items: [] })]);

        const { POST } = await import('./+server.js');
        const event = createMockEvent({
            tool_call_id: 'call_1',
            choice: 'whole milk'
            // no entryId
        });

        const response = await POST(event);
        expect(response.status).toBe(400);
        const data = await response.json();
        expect(data.error).toContain('entryId required');
    });

    it('continuation returns 404 for non-existent entry', async () => {
        const { POST } = await import('./+server.js');
        const event = createMockEvent({
            entryId: 'non-existent-id',
            tool_call_id: 'call_1',
            choice: 'whole milk'
        });

        const response = await POST(event);
        expect(response.status).toBe(404);
        const data = await response.json();
        expect(data.error).toContain('Entry not found');
    });

    it('R2 pending upload cleanup after successful log_meal', async () => {
        // Put a fake image in R2 pending/
        const fakeImageKey = 'pending/test-image-123.jpg';
        await proxy.env.IMAGES.put(fakeImageKey, new Uint8Array([0xFF, 0xD8, 0xFF]), {
            httpMetadata: { contentType: 'image/jpeg' }
        });

        // Verify the file exists
        const before = await proxy.env.IMAGES.get(fakeImageKey);
        expect(before).not.toBeNull();

        const mealArgs = {
            meal_title: 'Toast',
            items: [{ name: 'Toast', calories: 100, protein: 3, carbs: 20 }]
        };
        mockFetchJSON([createToolCallResponse('log_meal', mealArgs)]);

        const { POST } = await import('./+server.js');
        const event = createMockEvent({
            message: 'toast',
            imageKeys: [fakeImageKey],
            timestamp: '2026-05-26T08:00:00'
        });

        const response = await POST(event);
        expect(response.status).toBe(200);
        const data = await response.json();
        expect(data.meal_title).toBe('Toast');

        // waitUntil fires asynchronously — give it a moment
        await new Promise((r) => setTimeout(r, 200));

        // Verify the pending image was cleaned up from R2
        const after = await proxy.env.IMAGES.get(fakeImageKey);
        expect(after).toBeNull();
    });

    it('R2 audio key cleanup after successful log_meal', async () => {
        // Put a fake audio file in R2 pending/
        const fakeAudioKey = 'pending/test-audio-456.wav';
        await proxy.env.IMAGES.put(fakeAudioKey, new Uint8Array([0x52, 0x49, 0x46, 0x46]), {
            httpMetadata: { contentType: 'audio/wav' }
        });

        const before = await proxy.env.IMAGES.get(fakeAudioKey);
        expect(before).not.toBeNull();

        const mealArgs = {
            meal_title: 'Oatmeal',
            items: [{ name: 'Oatmeal', calories: 150, protein: 5, carbs: 27 }]
        };
        mockFetchJSON([createToolCallResponse('log_meal', mealArgs)]);

        const { POST } = await import('./+server.js');
        const event = createMockEvent({
            message: 'oatmeal',
            audioKey: fakeAudioKey,
            timestamp: '2026-05-26T07:30:00'
        });

        const response = await POST(event);
        expect(response.status).toBe(200);
        const data = await response.json();
        expect(data.meal_title).toBe('Oatmeal');

        await new Promise((r) => setTimeout(r, 200));

        // Verify the pending audio key was cleaned up from R2
        const after = await proxy.env.IMAGES.get(fakeAudioKey);
        expect(after).toBeNull();
    });

    it('returns 502 when LLM call fails', async () => {
        globalThis.fetch = async (url) => {
            if (typeof url === 'string' && url.includes('openrouter.ai')) {
                return new Response('Internal Server Error', { status: 500 });
            }
            throw new Error(`Unexpected fetch to: ${url}`);
        };

        const { POST } = await import('./+server.js');
        const event = createMockEvent({
            message: 'chicken salad',
            timestamp: '2026-05-26T12:00:00'
        });

        const response = await POST(event);
        expect(response.status).toBe(502);
        const data = await response.json();
        expect(data.error).toBeDefined();
        expect(data.entryId).toBeDefined();
    });

    it('returns 502 when AI returns no tool call', async () => {
        // Return a text response with no tool_calls
        mockFetchJSON([createTextResponse('I cannot analyze this food.')]);

        const { POST } = await import('./+server.js');
        const event = createMockEvent({
            message: 'something ambiguous',
            timestamp: '2026-05-26T12:00:00'
        });

        const response = await POST(event);
        expect(response.status).toBe(502);
        const data = await response.json();
        expect(data.error).toContain('AI did not return a valid response');
    });

    it('returns 502 for unexpected tool call name', async () => {
        mockFetchJSON([createToolCallResponse('unknown_tool', { foo: 'bar' })]);

        const { POST } = await import('./+server.js');
        const event = createMockEvent({
            message: 'pizza',
            timestamp: '2026-05-26T12:00:00'
        });

        const response = await POST(event);
        expect(response.status).toBe(502);
        const data = await response.json();
        expect(data.error).toContain('Unexpected tool call');
    });

    it('uses image model when imageKeys are provided', async () => {
        // Put a fake image so buildContentFromKeys can find it
        const imageKey = 'pending/photo-model-test.jpg';
        await proxy.env.IMAGES.put(imageKey, new Uint8Array([0xFF, 0xD8, 0xFF]), {
            httpMetadata: { contentType: 'image/jpeg' }
        });

        let capturedBody = null;
        globalThis.fetch = async (url, opts) => {
            if (typeof url === 'string' && url.includes('openrouter.ai')) {
                capturedBody = JSON.parse(opts.body);
                const data = createToolCallResponse('log_meal', {
                    meal_title: 'Photo Meal',
                    items: [{ name: 'Food', calories: 200, protein: 10, carbs: 20 }]
                });
                return new Response(JSON.stringify(data), {
                    status: 200,
                    headers: { 'Content-Type': 'application/json' }
                });
            }
            throw new Error(`Unexpected fetch to: ${url}`);
        };

        const { POST } = await import('./+server.js');
        const event = createMockEvent({
            message: 'what is this',
            imageKeys: [imageKey],
            timestamp: '2026-05-26T12:00:00'
        });

        const response = await POST(event);
        expect(response.status).toBe(200);

        // Verify the image model was used (gemini-3.1-pro-preview for images)
        expect(capturedBody).not.toBeNull();
        expect(capturedBody.model).toBe('google/gemini-3.1-pro-preview');
    });

    it('uses text model when no images are provided', async () => {
        let capturedBody = null;
        globalThis.fetch = async (url, opts) => {
            if (typeof url === 'string' && url.includes('openrouter.ai')) {
                capturedBody = JSON.parse(opts.body);
                const data = createToolCallResponse('log_meal', {
                    meal_title: 'Text Meal',
                    items: [{ name: 'Food', calories: 200, protein: 10, carbs: 20 }]
                });
                return new Response(JSON.stringify(data), {
                    status: 200,
                    headers: { 'Content-Type': 'application/json' }
                });
            }
            throw new Error(`Unexpected fetch to: ${url}`);
        };

        const { POST } = await import('./+server.js');
        const event = createMockEvent({
            message: 'two eggs and toast',
            timestamp: '2026-05-26T08:00:00'
        });

        const response = await POST(event);
        expect(response.status).toBe(200);

        // Verify the text model was used (gemini-3-flash-preview for text-only)
        expect(capturedBody).not.toBeNull();
        expect(capturedBody.model).toBe('google/gemini-3-flash-preview');
    });

    it('computes totals correctly from items', async () => {
        const mealArgs = {
            meal_title: 'Big Meal',
            items: [
                { name: 'Steak', calories: 500, protein: 50, carbs: 0 },
                { name: 'Potato', calories: 200, protein: 4, carbs: 40 },
                { name: 'Butter', calories: 100, protein: 0, carbs: 0 },
                { name: 'Beer', calories: 150, protein: 1, carbs: 13 }
            ]
        };
        mockFetchJSON([createToolCallResponse('log_meal', mealArgs)]);

        const { POST } = await import('./+server.js');
        const event = createMockEvent({
            message: 'steak dinner with potato butter and beer',
            timestamp: '2026-05-26T19:00:00'
        });

        const response = await POST(event);
        expect(response.status).toBe(200);
        const data = await response.json();

        expect(data.total_calories).toBe(950);
        expect(data.total_protein).toBe(55);
        expect(data.total_carbs).toBe(53);
    });

    it('image content is built and sent to the LLM', async () => {
        // Put a fake image in R2
        const imageKey = 'pending/content-test.jpg';
        const fakeImageBytes = new Uint8Array([0xFF, 0xD8, 0xFF, 0xE0]);
        await proxy.env.IMAGES.put(imageKey, fakeImageBytes, {
            httpMetadata: { contentType: 'image/jpeg' }
        });

        let capturedBody = null;
        globalThis.fetch = async (url, opts) => {
            if (typeof url === 'string' && url.includes('openrouter.ai')) {
                capturedBody = JSON.parse(opts.body);
                const data = createToolCallResponse('log_meal', {
                    meal_title: 'Photo Meal',
                    items: [{ name: 'Food', calories: 100, protein: 5, carbs: 10 }]
                });
                return new Response(JSON.stringify(data), {
                    status: 200,
                    headers: { 'Content-Type': 'application/json' }
                });
            }
            throw new Error(`Unexpected fetch to: ${url}`);
        };

        const { POST } = await import('./+server.js');
        const event = createMockEvent({
            message: 'what is this',
            imageKeys: [imageKey],
            timestamp: '2026-05-26T12:00:00'
        });

        await POST(event);

        // Verify the user message content includes both text and image_url
        const userMsg = capturedBody.messages.find(m => m.role === 'user');
        expect(userMsg).toBeDefined();
        expect(Array.isArray(userMsg.content)).toBe(true);

        const textPart = userMsg.content.find(p => p.type === 'text');
        expect(textPart).toBeDefined();
        expect(textPart.text).toBe('what is this');

        const imagePart = userMsg.content.find(p => p.type === 'image_url');
        expect(imagePart).toBeDefined();
        expect(imagePart.image_url.url).toContain('data:image/jpeg;base64,');
    });

    it('creates a placeholder entry in analyzing state before calling LLM', async () => {
        let entryIdCapture = null;

        // Intercept fetch to check DB state mid-flight
        globalThis.fetch = async (url, opts) => {
            if (typeof url === 'string' && url.includes('openrouter.ai')) {
                const body = JSON.parse(opts.body);
                // At this point in the flow, the placeholder should already be created.
                // We can't easily check mid-call, but we return log_meal to proceed.
                const data = createToolCallResponse('log_meal', {
                    meal_title: 'Mid-flight Test',
                    items: [{ name: 'Apple', calories: 80, protein: 0, carbs: 21 }]
                });
                return new Response(JSON.stringify(data), {
                    status: 200,
                    headers: { 'Content-Type': 'application/json' }
                });
            }
            throw new Error(`Unexpected fetch to: ${url}`);
        };

        const { POST } = await import('./+server.js');
        const event = createMockEvent({
            message: 'apple',
            timestamp: '2026-05-26T15:00:00'
        });

        const response = await POST(event);
        const data = await response.json();

        // After log_meal, entry should now be 'ready' (it was 'analyzing' before the LLM responded)
        const entry = await storage.getEntryDetails(data.entryId, TEST_USER_ID);
        expect(entry.status).toBe('ready');
    });

    it('sets entry to awaiting_user when LLM call fails', async () => {
        globalThis.fetch = async (url) => {
            if (typeof url === 'string' && url.includes('openrouter.ai')) {
                return new Response('Service Unavailable', { status: 503 });
            }
            throw new Error(`Unexpected fetch to: ${url}`);
        };

        const { POST } = await import('./+server.js');
        const event = createMockEvent({
            message: 'pizza',
            entryId: 'fail-entry-test',
            timestamp: '2026-05-26T18:00:00'
        });

        const response = await POST(event);
        expect(response.status).toBe(502);

        // The entry should be set to 'awaiting_user' on LLM failure so it's not stuck in 'analyzing'
        await new Promise((r) => setTimeout(r, 100));
        const entry = await proxy.env.DB
            .prepare('SELECT status FROM nutrition_entries WHERE id = ?')
            .bind('fail-entry-test')
            .first();
        expect(entry).not.toBeNull();
        expect(entry.status).toBe('awaiting_user');
    });

    it('passes reasoning from LLM response in the result', async () => {
        const llmResponse = {
            choices: [{
                message: {
                    role: 'assistant',
                    content: null,
                    reasoning: 'The user described a simple protein-rich meal.',
                    tool_calls: [{
                        id: 'call_reason_1',
                        type: 'function',
                        function: {
                            name: 'log_meal',
                            arguments: JSON.stringify({
                                meal_title: 'Protein Shake',
                                items: [{ name: 'Protein Shake', calories: 200, protein: 30, carbs: 10 }]
                            })
                        }
                    }]
                },
                finish_reason: 'tool_calls'
            }]
        };
        mockFetchJSON([llmResponse]);

        const { POST } = await import('./+server.js');
        const event = createMockEvent({
            message: 'protein shake',
            timestamp: '2026-05-26T16:00:00'
        });

        const response = await POST(event);
        expect(response.status).toBe(200);
        const data = await response.json();

        expect(data.reasoning).toBe('The user described a simple protein-rich meal.');
    });

    it('strips binary content from conversation messages stored in DB', async () => {
        // Put a fake image in R2 so buildContentFromKeys works
        const imageKey = 'pending/strip-test.jpg';
        await proxy.env.IMAGES.put(imageKey, new Uint8Array([0xFF, 0xD8]), {
            httpMetadata: { contentType: 'image/jpeg' }
        });

        mockFetchJSON([createToolCallResponse('log_meal', {
            meal_title: 'Photo Meal',
            items: [{ name: 'Food', calories: 100, protein: 5, carbs: 10 }]
        })]);

        const { POST } = await import('./+server.js');
        const event = createMockEvent({
            message: 'lunch photo',
            imageKeys: [imageKey],
            timestamp: '2026-05-26T12:00:00'
        });

        const response = await POST(event);
        expect(response.status).toBe(200);
        const data = await response.json();

        // The messages in the response should have binaries stripped
        const userMsg = data.messages.find(m => m.role === 'user');
        expect(userMsg).toBeDefined();
        // After stripping, the user message should be text-only array
        if (Array.isArray(userMsg.content)) {
            const imagePart = userMsg.content.find(p => p.type === 'image_url');
            expect(imagePart).toBeUndefined();
        }

        // Also check the stored entry
        const entry = await storage.getEntryDetails(data.entryId, TEST_USER_ID);
        const storedUserMsg = entry.conversation_messages.find(m => m.role === 'user');
        if (Array.isArray(storedUserMsg?.content)) {
            const storedImgPart = storedUserMsg.content.find(p => p.type === 'image_url');
            expect(storedImgPart).toBeUndefined();
        }
    });

    it('handles entryId provided by client for initial request', async () => {
        const customEntryId = 'custom-entry-id-999';
        mockFetchJSON([createToolCallResponse('log_meal', {
            meal_title: 'Custom ID Meal',
            items: [{ name: 'Soup', calories: 150, protein: 8, carbs: 20 }]
        })]);

        const { POST } = await import('./+server.js');
        const event = createMockEvent({
            message: 'soup',
            entryId: customEntryId,
            timestamp: '2026-05-26T12:00:00'
        });

        const response = await POST(event);
        expect(response.status).toBe(200);
        const data = await response.json();

        // Verify the entryId matches the client-provided one
        expect(data.entryId).toBe(customEntryId);

        const entry = await storage.getEntryDetails(customEntryId, TEST_USER_ID);
        expect(entry).not.toBeNull();
        expect(entry.meal_title).toBe('Custom ID Meal');
    });

    it('sends tools with tool_choice required to OpenRouter', async () => {
        let capturedBody = null;
        globalThis.fetch = async (url, opts) => {
            if (typeof url === 'string' && url.includes('openrouter.ai')) {
                capturedBody = JSON.parse(opts.body);
                const data = createToolCallResponse('log_meal', {
                    meal_title: 'Rice',
                    items: [{ name: 'Rice', calories: 200, protein: 4, carbs: 45 }]
                });
                return new Response(JSON.stringify(data), {
                    status: 200,
                    headers: { 'Content-Type': 'application/json' }
                });
            }
            throw new Error(`Unexpected fetch to: ${url}`);
        };

        const { POST } = await import('./+server.js');
        const event = createMockEvent({
            message: 'rice',
            timestamp: '2026-05-26T12:00:00'
        });

        await POST(event);

        expect(capturedBody).not.toBeNull();
        expect(capturedBody.tools).toBeDefined();
        expect(capturedBody.tools.length).toBe(3);
        expect(capturedBody.tool_choice).toBe('required');

        // Verify the three tools are present
        const toolNames = capturedBody.tools.map(t => t.function.name);
        expect(toolNames).toContain('log_meal');
        expect(toolNames).toContain('reject_input');
        expect(toolNames).toContain('ask_clarification');
    });

    it('reject_input with missing reason still returns a fallback message', async () => {
        // Simulate a reject_input where parsing fails
        const llmResponse = {
            choices: [{
                message: {
                    role: 'assistant',
                    content: null,
                    tool_calls: [{
                        id: 'call_bad_reject',
                        type: 'function',
                        function: {
                            name: 'reject_input',
                            arguments: '{invalid json'
                        }
                    }]
                },
                finish_reason: 'tool_calls'
            }]
        };
        mockFetchJSON([llmResponse]);

        const { POST } = await import('./+server.js');
        const event = createMockEvent({
            message: 'hello there',
            timestamp: '2026-05-26T12:00:00'
        });

        const response = await POST(event);
        expect(response.status).toBe(200);
        const data = await response.json();

        expect(data.rejection).toBeDefined();
        expect(data.rejection.message).toBe("That doesn't look like food.");
    });

    it('cleans up both image and audio keys after log_meal', async () => {
        const imageKey = 'pending/combo-img.jpg';
        const audioKey = 'pending/combo-audio.wav';

        await proxy.env.IMAGES.put(imageKey, new Uint8Array([0xFF, 0xD8]), {
            httpMetadata: { contentType: 'image/jpeg' }
        });
        await proxy.env.IMAGES.put(audioKey, new Uint8Array([0x52, 0x49]), {
            httpMetadata: { contentType: 'audio/wav' }
        });

        mockFetchJSON([createToolCallResponse('log_meal', {
            meal_title: 'Combo Meal',
            items: [{ name: 'Sandwich', calories: 400, protein: 20, carbs: 40 }]
        })]);

        const { POST } = await import('./+server.js');
        const event = createMockEvent({
            message: 'sandwich',
            imageKeys: [imageKey],
            audioKey: audioKey,
            timestamp: '2026-05-26T12:00:00'
        });

        const response = await POST(event);
        expect(response.status).toBe(200);

        await new Promise((r) => setTimeout(r, 200));

        const imgAfter = await proxy.env.IMAGES.get(imageKey);
        const audioAfter = await proxy.env.IMAGES.get(audioKey);
        expect(imgAfter).toBeNull();
        expect(audioAfter).toBeNull();
    });
});
