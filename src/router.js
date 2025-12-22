import { Storage } from './storage.js';
import { Auth } from './auth.js';
import { requireAuth, setSessionCookie, clearSessionCookie, extractSessionCookie } from './middleware.js';
import { Base64 } from 'js-base64';

export class Router {
    constructor(env) {
        this.env = env;
        this.storage = new Storage(env);
        this.auth = new Auth(env);
    }

    async handle(request) {
        const url = new URL(request.url);
        const path = url.pathname;
        const method = request.method;

        // Redirect HTTP to HTTPS in production
        const isDev = this.env.DEV === 'true' || this.env.DEV === true;
        if (!isDev && url.protocol === 'http:') {
            return Response.redirect(url.href.replace('http:', 'https:'), 301);
        }

        // API Routes
        try {
            // Auth endpoints (public)
            if (path === '/auth/login' && method === 'POST') {
                return await this.handleLogin(request);
            }
            if (path === '/auth/verify' && method === 'GET') {
                return await this.handleVerify(request);
            }
            if (path === '/auth/logout' && method === 'POST') {
                return await this.handleLogout(request);
            }
            if (path === '/auth/me' && method === 'GET') {
                return await this.handleMe(request);
            }

            // Protected endpoints (require auth)
            if (path === '/transcribe' && method === 'POST') {
                return await this.handleTranscribe(request);
            }
            if (path === '/analyze' && method === 'POST') {
                return await this.handleAnalyze(request);
            }
            if (path === '/history' && method === 'GET') {
                return await this.handleGetHistory(request);
            }
            if (path.startsWith('/entry/') && method === 'GET') {
                const id = path.split('/').pop();
                return await this.handleGetEntry(id, request);
            }
            if (path.startsWith('/entry/') && method === 'DELETE') {
                const id = path.split('/').pop();
                return await this.handleDeleteEntry(id, request);
            }
            if (path === '/followup' && method === 'POST') {
                return await this.handleFollowup(request);
            }
            if (path === '/settings' && method === 'GET') {
                return await this.handleGetSettings(request);
            }
            if (path === '/settings' && method === 'POST') {
                return await this.handleSaveSettings(request);
            }
            if (path === '/entry' && method === 'POST') {
                return await this.handleSaveEntry(request);
            }
        } catch (error) {
            console.error('API Error:', error);
            return new Response(JSON.stringify({ error: error.message }), {
                status: 500,
                headers: { 'Content-Type': 'application/json' }
            });
        }

        return new Response('Not Found', { status: 404 });
    }

    // Helper to call OpenRouter via fetch
    async callOpenRouter(messages, tools = null, toolChoice = 'auto') {
        const body = {
            model: 'google/gemini-3-flash-preview',
            messages: messages,
            reasoning: {
                enabled: true
            }
        };

        if (tools) {
            body.tools = tools;
            body.tool_choice = toolChoice;
        }

        const response = await fetch('https://openrouter.ai/api/v1/chat/completions', {
            method: 'POST',
            headers: {
                'Authorization': `Bearer ${this.env.OPENROUTER_API_KEY}`,
                'Content-Type': 'application/json',
                'HTTP-Referer': 'https://cuuush.com',
                'X-Title': 'Calorie Tracker'
            },
            body: JSON.stringify(body)
        });

        if (!response.ok) {
            const err = await response.text();
            throw new Error(`OpenRouter Error: ${err}`);
        }

        return await response.json();
    }

    async handleTranscribe(request) {
        const userId = await requireAuth(request, this.auth);
        if (!userId) {
            return new Response('Unauthorized', { status: 401 });
        }

        const formData = await request.formData();
        const audioFile = formData.get('audio');
        if (!audioFile) throw new Error('No audio provided');

        // Convert Blob/File to Base64
        const arrayBuffer = await audioFile.arrayBuffer();
        const base64Audio = Base64.fromUint8Array(new Uint8Array(arrayBuffer));

        // Prompt Gemini to transcribe
        const messages = [
            {
                role: 'user',
                content: [
                    { type: 'text', text: 'Please transcribe this audio exactly as spoken. Do not add any commentary.' },
                    {
                        type: 'input_audio',
                        input_audio: {
                            data: base64Audio,
                            format: 'wav' // Assuming wav from MediaRecorder, or we can detect
                        }
                    }
                ]
            }
        ];

        const data = await this.callOpenRouter(messages);
        const transcript = data.choices[0]?.message?.content || "";

        return new Response(JSON.stringify({ text: transcript }), {
            headers: { 'Content-Type': 'application/json' }
        });
    }

    async handleAnalyze(request) {
        const userId = await requireAuth(request, this.auth);
        if (!userId) {
            return new Response('Unauthorized', { status: 401 });
        }

        const formData = await request.formData();
        const imageFile = formData.get('image');
        const userMessage = formData.get('message') || '';

        // Build messages
        const content = [];
        if (userMessage) {
            content.push({ type: 'text', text: userMessage });
        } else {
            content.push({ type: 'text', text: 'Analyze this food.' });
        }

        if (imageFile) {
            const arrayBuffer = await imageFile.arrayBuffer();
            const base64Image = Base64.fromUint8Array(new Uint8Array(arrayBuffer));
            content.push({
                type: 'image_url',
                image_url: { url: `data:${imageFile.type};base64,${base64Image}` }
            });
        }

        const imagePrompt = `You are an expert nutritionist and visual food analyst. 
Your task is to identify foods from images and estimate their nutritional content.
- Be precise in identifying ingredients.
- Estimate portion sizes based on visual cues (plates, utensils, etc.).
- If parts of the food are obscured, make a reasonable estimate based on the visible parts and the dish type.
- Always provide a breakdown of individual items.`;

        const textPrompt = `You are an expert nutritionist and culinary analyst.
Your task is to estimate nutritional content from text descriptions of meals.
- Interpret descriptive language and culinary terms accurately.
- Assume standard portion sizes unless specific amounts are mentioned.
- If a description is vague, provide a most likely estimate for a standard serving.
- Always provide a breakdown of individual items mentioned or implied.`;

        const systemPrompt = imageFile ? imagePrompt : textPrompt;
        const messages = [
            { role: 'system', content: systemPrompt },
            { role: 'user', content }
        ];

        // Define Tools
        const tools = [{
            type: 'function',
            function: {
                name: 'log_meal',
                description: 'Log a meal entry. Provide individual meal items with their macros (calories, protein, carbs)',
                parameters: {
                    type: 'object',
                    properties: {
                        meal_title: { type: 'string', description: 'A short, straightforward title for the meal' },
                        items: {
                            type: 'array',
                            items: {
                                type: 'object',
                                properties: {
                                    name: { type: 'string' },
                                    calories: { type: 'number' },
                                    protein: { type: 'number' },
                                    carbs: { type: 'number' }
                                },
                                required: ['name', 'calories', 'protein', 'carbs']
                            }
                        }
                    },
                    required: ['meal_title', 'items']
                }
            }
        }];

        // Force the tool call
        const responseData = await this.callOpenRouter(messages, tools, { type: 'function', function: { name: 'log_meal' } });

        const choice = responseData.choices[0];
        const toolCall = choice.message.tool_calls?.[0];

        if (!toolCall) {
            console.log("NO TOOL CALL", JSON.stringify(responseData));
            // Fallback if model refuses to call tool (rare with force)
            throw new Error('AI did not return a valid food log.');
        }

        const args = JSON.parse(toolCall.function.arguments);

        // Calculate totals from items
        const items = args.items || [];
        const total_calories = items.reduce((sum, item) => sum + (item.calories || 0), 0);
        const total_protein = items.reduce((sum, item) => sum + (item.protein || 0), 0);
        const total_carbs = items.reduce((sum, item) => sum + (item.carbs || 0), 0);

        // Extract reasoning if available (OpenRouter extended reasoning format)
        let reasoning = null;
        let reasoning_summary = null;

        // Check for extended reasoning in response (output array format)
        if (responseData.output) {
            const reasoningOutput = responseData.output.find(o => o.type === 'reasoning');
            if (reasoningOutput?.summary) {
                reasoning_summary = reasoningOutput.summary;
                reasoning = reasoningOutput.summary.join('\n');
            }
        }

        // Check for reasoning in the message itself
        if (!reasoning && choice.message.reasoning) {
            reasoning = choice.message.reasoning;
        }

        // Construct Entry - return but don't save yet
        const entryData = {
            ...args,
            total_calories,
            total_protein,
            total_carbs,
            reasoning,
            reasoning_summary,
            user_message: userMessage,
            raw_response: JSON.stringify(responseData),
            messages: [
                { role: 'system', content: systemPrompt },
                { role: 'user', content: [{ type: 'text', text: userMessage || 'Analyze this image' }] },
                choice.message
            ]
        };

        return new Response(JSON.stringify(entryData), {
            headers: { 'Content-Type': 'application/json' }
        });
    }

    async handleSaveEntry(request) {
        const userId = await requireAuth(request, this.auth);
        if (!userId) {
            return new Response('Unauthorized', { status: 401 });
        }

        const entryData = await request.json();
        const doc = await this.storage.saveEntry(entryData, userId);

        return new Response(JSON.stringify(doc), {
            headers: { 'Content-Type': 'application/json' }
        });
    }

    async handleGetHistory(request) {
        const userId = await requireAuth(request, this.auth);
        if (!userId) {
            return new Response('Unauthorized', { status: 401 });
        }

        const history = await this.storage.getHistory(userId);
        return new Response(JSON.stringify(history), {
            headers: { 'Content-Type': 'application/json' }
        });
    }

    async handleGetEntry(id, request) {
        const userId = await requireAuth(request, this.auth);
        if (!userId) {
            return new Response('Unauthorized', { status: 401 });
        }

        const entry = await this.storage.getEntryDetails(id, userId);
        if (!entry) return new Response('Entry not found', { status: 404 });
        return new Response(JSON.stringify(entry), {
            headers: { 'Content-Type': 'application/json' }
        });
    }

    async handleDeleteEntry(id, request) {
        const userId = await requireAuth(request, this.auth);
        if (!userId) {
            return new Response('Unauthorized', { status: 401 });
        }

        await this.storage.deleteEntry(id, userId);
        return new Response(JSON.stringify({ success: true }), {
            headers: { 'Content-Type': 'application/json' }
        });
    }

    async handleFollowup(request) {
        const userId = await requireAuth(request, this.auth);
        if (!userId) {
            return new Response('Unauthorized', { status: 401 });
        }

        const body = await request.json();
        const { entryId, message, messages: providedMessages } = body;

        let conversation = [];
        let entry = null;

        if (entryId) {
            entry = await this.storage.getEntryDetails(entryId, userId);
            if (!entry) throw new Error('Entry not found');
            conversation = entry.conversation_messages || [];
        } else if (providedMessages) {
            conversation = providedMessages;
        } else {
            throw new Error('Either entryId or messages must be provided');
        }

        // Add user message
        conversation.push({ role: 'user', content: message });

        // Define Tools
        const tools = [
            {
                type: 'function',
                function: {
                    name: 'update_log',
                    description: 'Update the food log entry details. Provide updated items with their macros - totals will be calculated automatically.',
                    parameters: {
                        type: 'object',
                        properties: {
                            items: {
                                type: 'array',
                                items: {
                                    type: 'object',
                                    properties: {
                                        name: { type: 'string' },
                                        calories: { type: 'number' },
                                        protein: { type: 'number' },
                                        carbs: { type: 'number' }
                                    },
                                    required: ['name', 'calories', 'protein', 'carbs']
                                }
                            }
                        },
                        required: ['items']
                    }
                }
            }
        ];

        const responseData = await this.callOpenRouter(conversation, tools, 'auto');
        const choice = responseData.choices[0];
        const responseMsg = choice.message;

        conversation.push(responseMsg);

        let updatedEntry = null;

        // Check for tool calls
        if (responseMsg.tool_calls) {
            for (const toolCall of responseMsg.tool_calls) {
                if (toolCall.function.name === 'update_log') {
                    const args = JSON.parse(toolCall.function.arguments);

                    // Calculate totals from updated items
                    const items = args.items || [];
                    const total_calories = items.reduce((sum, item) => sum + (item.calories || 0), 0);
                    const total_protein = items.reduce((sum, item) => sum + (item.protein || 0), 0);
                    const total_carbs = items.reduce((sum, item) => sum + (item.carbs || 0), 0);

                    if (entry) {
                        const newEntry = {
                            ...entry,
                            items,
                            total_calories,
                            total_protein,
                            total_carbs
                        };

                        await this.storage.saveEntry(newEntry, userId);
                        updatedEntry = newEntry;
                    } else {
                        // For stateless/unsaved entries, we just return the new content
                        updatedEntry = {
                            items,
                            total_calories,
                            total_protein,
                            total_carbs
                        };
                    }

                    // Add tool result to conversation
                    conversation.push({
                        role: 'tool',
                        tool_call_id: toolCall.id,
                        content: JSON.stringify({ success: true, message: "Log updated successfully" })
                    });
                }
            }
        }

        if (entryId) {
            await this.storage.updateConversation(entryId, conversation, null, null);
        }

        // If we had tool calls, we should call the model one more time to get a final response
        let finalResponseMsg = responseMsg;
        let finalReasoning = responseMsg.reasoning || null;

        if (responseMsg.tool_calls) {
            const finalResponseData = await this.callOpenRouter(conversation, tools, 'auto');
            finalResponseMsg = finalResponseData.choices[0].message;
            finalReasoning = finalResponseMsg.reasoning || null;
            conversation.push(finalResponseMsg);

            if (entryId) {
                await this.storage.updateConversation(entryId, conversation, null, null);
            }
        }

        return new Response(JSON.stringify({
            role: 'assistant',
            content: finalResponseMsg.content,
            reasoning: finalReasoning,
            updatedEntry: updatedEntry,
            messages: conversation
        }), {
            headers: { 'Content-Type': 'application/json' }
        });
    }

    async handleGetSettings(request) {
        const userId = await requireAuth(request, this.auth);
        if (!userId) {
            return new Response('Unauthorized', { status: 401 });
        }

        const settings = await this.storage.getUserSettings(userId);
        return new Response(JSON.stringify(settings || {}), {
            headers: { 'Content-Type': 'application/json' }
        });
    }

    async handleSaveSettings(request) {
        const userId = await requireAuth(request, this.auth);
        if (!userId) {
            return new Response('Unauthorized', { status: 401 });
        }

        const settings = await request.json();
        const updated = await this.storage.saveUserSettings(settings, userId);
        return new Response(JSON.stringify(updated), {
            headers: { 'Content-Type': 'application/json' }
        });
    }

    // Auth handlers
    async handleLogin(request) {
        try {
            const { email } = await request.json();

            if (!email) {
                return new Response(JSON.stringify({ error: 'Email required' }), {
                    status: 400,
                    headers: { 'Content-Type': 'application/json' }
                });
            }

            await this.auth.sendMagicLink(email, request);

            return new Response(JSON.stringify({ success: true }), {
                headers: { 'Content-Type': 'application/json' }
            });
        } catch (error) {
            console.error('Login error:', error);
            return new Response(JSON.stringify({ error: error.message }), {
                status: 500,
                headers: { 'Content-Type': 'application/json' }
            });
        }
    }

    async handleVerify(request) {
        try {
            const url = new URL(request.url);
            const token = url.searchParams.get('token');

            if (!token) {
                return new Response('Missing token', { status: 400 });
            }

            const result = await this.auth.verifyToken(token);

            if (!result) {
                return new Response('Invalid or expired token', { status: 400 });
            }

            const isDev = this.env.DEV === 'true' || this.env.DEV === true;

            // Set session cookie and redirect to app
            return new Response(null, {
                status: 302,
                headers: {
                    'Location': '/',
                    'Set-Cookie': setSessionCookie(result.sessionToken, isDev)
                }
            });
        } catch (error) {
            console.error('Verify error:', error);
            return new Response('Verification failed', { status: 500 });
        }
    }

    async handleLogout(request) {
        try {
            const cookie = request.headers.get('Cookie');
            if (cookie) {
                const sessionToken = extractSessionCookie(cookie);
                if (sessionToken) {
                    await this.auth.deleteSession(sessionToken);
                }
            }

            const isDev = this.env.DEV === 'true' || this.env.DEV === true;

            return new Response(JSON.stringify({ success: true }), {
                headers: {
                    'Content-Type': 'application/json',
                    'Set-Cookie': clearSessionCookie(isDev)
                }
            });
        } catch (error) {
            console.error('Logout error:', error);
            return new Response(JSON.stringify({ error: error.message }), {
                status: 500,
                headers: { 'Content-Type': 'application/json' }
            });
        }
    }

    async handleMe(request) {
        try {
            const userId = await requireAuth(request, this.auth);

            if (!userId) {
                return new Response(JSON.stringify({ authenticated: false }), {
                    headers: { 'Content-Type': 'application/json' }
                });
            }

            const user = await this.auth.getUser(userId);

            return new Response(JSON.stringify({
                authenticated: true,
                user
            }), {
                headers: { 'Content-Type': 'application/json' }
            });
        } catch (error) {
            console.error('Me error:', error);
            return new Response(JSON.stringify({ authenticated: false }), {
                headers: { 'Content-Type': 'application/json' }
            });
        }
    }
}
