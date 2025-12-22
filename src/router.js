import { Storage } from './storage.js';
import OpenAI from 'openai';

export class Router {
    constructor(env) {
        this.env = env;
        this.storage = new Storage(env);
    }

    async handle(request) {
        const url = new URL(request.url);
        const path = url.pathname;
        const method = request.method;

        // API Routes
        try {
            if (path === '/analyze' && method === 'POST') {
                return await this.handleAnalyze(request);
            }
            if (path === '/history' && method === 'GET') {
                return await this.handleGetHistory();
            }
            if (path.startsWith('/entry/') && method === 'GET') {
                const id = path.split('/').pop();
                return await this.handleGetEntry(id);
            }
            if (path.startsWith('/entry/') && method === 'DELETE') {
                const id = path.split('/').pop();
                return await this.handleDeleteEntry(id);
            }
            if (path === '/followup' && method === 'POST') {
                return await this.handleFollowup(request);
            }
            if (path === '/debug' && method === 'POST') {
                return await this.handleDebug(request);
            }
            if (path === '/settings' && method === 'GET') {
                return await this.handleGetSettings();
            }
            if (path === '/settings' && method === 'POST') {
                return await this.handleSaveSettings(request);
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

    async handleAnalyze(request) {
        const formData = await request.formData();
        const imageFile = formData.get('image');
        const userMessage = formData.get('message') || '';

        if (!imageFile) throw new Error('No image provided');

        // Encode image
        // Encode image safely handling large files
        const arrayBuffer = await imageFile.arrayBuffer();
        const bytes = new Uint8Array(arrayBuffer);
        let binary = '';
        const chunkSize = 8192;
        for (let i = 0; i < bytes.length; i += chunkSize) {
            binary += String.fromCharCode.apply(null, bytes.subarray(i, i + chunkSize));
        }
        const base64Image = btoa(binary);
        const mimeType = imageFile.type || 'image/jpeg';
        const dataUrl = `data:${mimeType};base64,${base64Image}`;

        // AI Call
        const client = new OpenAI({
            baseURL: 'https://openrouter.ai/api/v1',
            apiKey: this.env.OPENROUTER_API_KEY,
            defaultHeaders: {
                'HTTP-Referer': 'https://cuuush.com',
                'X-Title': 'Calorie Tracker'
            }
        });

        const completion = await client.chat.completions.create({
            model: 'google/gemini-3-flash-preview', // Using stronger model for reasoning if available, or stick to user's choice
            messages: [
                {
                    role: 'user',
                    content: [
                        {
                            type: 'text',
                            text: 'Analyze this food image. Create a simple and straightforward "meal_title" that incorporates the elements of the dish. Estimate calories, protein(g), carbs(g) for each item. Return JSON: {"meal_title": "...", "items": [{"name": "...", "calories": 0, "protein": 0, "carbs": 0}]}'
                        },
                        { type: 'image_url', image_url: { url: dataUrl } }
                    ]
                }
            ],
            reasoning: { enabled: true }
        });

        const message = completion.choices[0].message;
        const content = message.content;

        // Parse JSON
        let calorieData = { items: [], total_calories: 0, total_protein: 0, total_carbs: 0 };
        try {
            const jsonMatch = content.match(/```json\s*([\s\S]*?)\s*```/) || content.match(/\{[\s\S]*\}/);
            if (jsonMatch) {
                const parsed = JSON.parse(jsonMatch[1] || jsonMatch[0]);
                if (parsed.items) calorieData.items = parsed.items;
                if (parsed.meal_title) calorieData.meal_title = parsed.meal_title;
            }
        } catch (e) {
            console.warn('Failed to parse JSON', e);
        }

        // Calculate totals if not present or just verify
        if (calorieData.items.length > 0) {
            calorieData.total_calories = calorieData.items.reduce((sum, item) => sum + (item.calories || 0), 0);
            calorieData.total_protein = calorieData.items.reduce((sum, item) => sum + (item.protein || 0), 0);
            calorieData.total_carbs = calorieData.items.reduce((sum, item) => sum + (item.carbs || 0), 0);
        }

        calorieData.raw_response = content;

        // Extract reasoning from content (text after the json block)
        const jsonMatch = content.match(/```json\n([\s\S]*?)\n```/);
        if (jsonMatch) {
            // Remove the JSON block from the content to get the reasoning
            calorieData.reasoning = content.replace(jsonMatch[0], '').trim();
        } else {
            calorieData.reasoning = content;
        }
        calorieData.user_message = userMessage;

        // Initial Conversation
        calorieData.messages = [
            { role: 'user', content: [{ type: 'text', text: 'Analyze this... (image hidden)' }] }, // Don't store huge base64 in conversation history if possible? Or maybe we have to.
            { role: 'assistant', content: content }
        ];

        // Persist
        const doc = await this.storage.saveEntry(calorieData);

        return new Response(JSON.stringify(doc), {
            headers: { 'Content-Type': 'application/json' }
        });
    }

    async handleGetHistory() {
        const history = await this.storage.getHistory();
        return new Response(JSON.stringify(history), {
            headers: { 'Content-Type': 'application/json' }
        });
    }

    async handleGetEntry(id) {
        const entry = await this.storage.getEntryDetails(id);
        if (!entry) return new Response('Entry not found', { status: 404 });
        return new Response(JSON.stringify(entry), {
            headers: { 'Content-Type': 'application/json' }
        });
    }

    async handleDeleteEntry(id) {
        await this.storage.deleteEntry(id);
        return new Response(JSON.stringify({ success: true }), {
            headers: { 'Content-Type': 'application/json' }
        });
    }

    async handleFollowup(request) {
        const body = await request.json();
        const { entryId, message } = body;

        const entry = await this.storage.getEntryDetails(entryId);
        if (!entry) throw new Error('Entry not found');

        const conversation = entry.conversation_messages || [];
        conversation.push({ role: 'user', content: message });

        const client = new OpenAI({
            baseURL: 'https://openrouter.ai/api/v1',
            apiKey: this.env.OPENROUTER_API_KEY,
            defaultHeaders: { 'HTTP-Referer': 'https://cuuush.com', 'X-Title': 'Calorie Tracker' }
        });

        const completion = await client.chat.completions.create({
            model: 'google/gemini-3-flash-preview',
            messages: conversation
        });

        const responseMsg = completion.choices[0].message;
        conversation.push(responseMsg);

        // Save updated conversation
        await this.storage.updateConversation(entryId, conversation, null, null);

        return new Response(JSON.stringify({
            role: 'assistant',
            content: responseMsg.content
        }), {
            headers: { 'Content-Type': 'application/json' }
        });
    }

    async handleDebug(request) {
        const debugData = {
            "items": [
                {
                    "name": "double smash cheeseburger with pickles",
                    "calories": 780,
                    "protein": 42,
                    "carbs": 38
                }
            ],
            "total_calories": 780,
            "total_protein": 42,
            "total_carbs": 38,
            "raw_response": "```json\n{\n  \"items\": [\n    {\n      \"name\": \"double smash cheeseburger with pickles\",\n      \"calories\": 780,\n      \"protein\": 42,\n      \"carbs\": 38\n    }\n  ]\n}\n```\n\n**Reasoning:**\nThe image shows a classic double smash burger. The estimate includes two thin, well-seared beef patties (approx. 4-5oz total cooked weight), two slices of melted American cheese, a standard white bun, pickles, and visible mayonnaise-based sauce. Smash burgers tend to be higher in calories due to the high surface area for fat absorption during searing and the inclusion of multiple cheese slices.",
            "reasoning": "**Reasoning:**\nThe image shows a classic double smash burger. The estimate includes two thin, well-seared beef patties (approx. 4-5oz total cooked weight), two slices of melted American cheese, a standard white bun, pickles, and visible mayonnaise-based sauce. Smash burgers tend to be higher in calories due to the high surface area for fat absorption during searing and the inclusion of multiple cheese slices.",
            "user_message": "DEBUG MODE",
            "messages": [
                {
                    "role": "user",
                    "content": [{ "type": "text", "text": "Analyze this... (image hidden)" }]
                },
                {
                    "role": "assistant",
                    "content": "```json\n{\n  \"items\": [\n    {\n      \"name\": \"double smash cheeseburger with pickles\",\n      \"calories\": 780,\n      \"protein\": 42,\n      \"carbs\": 38\n    }\n  ]\n}\n```\n\n**Reasoning:**\nThe image shows a classic double smash burger. The estimate includes two thin, well-seared beef patties (approx. 4-5oz total cooked weight), two slices of melted American cheese, a standard white bun, pickles, and visible mayonnaise-based sauce. Smash burgers tend to be higher in calories due to the high surface area for fat absorption during searing and the inclusion of multiple cheese slices."
                }
            ]
        };

        const doc = await this.storage.saveEntry(debugData);
        return new Response(JSON.stringify(doc), {
            headers: { 'Content-Type': 'application/json' }
        });
    }

    async handleGetSettings() {
        const settings = await this.storage.getUserSettings();
        return new Response(JSON.stringify(settings || {}), {
            headers: { 'Content-Type': 'application/json' }
        });
    }

    async handleSaveSettings(request) {
        const settings = await request.json();
        const updated = await this.storage.saveUserSettings(settings);
        return new Response(JSON.stringify(updated), {
            headers: { 'Content-Type': 'application/json' }
        });
    }
}
