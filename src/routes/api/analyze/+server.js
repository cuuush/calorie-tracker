import { json } from '@sveltejs/kit';
import { Base64 } from 'js-base64';
import { callOpenRouter } from '$lib/server/ai';

/** @type {import('./$types').RequestHandler} */
export async function POST({ request, locals, platform }) {
    if (!locals.user) {
        return json({ error: 'Unauthorized' }, { status: 401 });
    }

    const formData = await request.formData();
    const imageFile = formData.get('image');
    const audioFile = formData.get('audio');
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

    if (audioFile) {
        const arrayBuffer = await audioFile.arrayBuffer();
        const base64Audio = Base64.fromUint8Array(new Uint8Array(arrayBuffer));
        content.push({
            type: 'input_audio',
            input_audio: {
                data: base64Audio,
                format: 'wav'
            }
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

    const systemPrompt = (imageFile) ? imagePrompt : textPrompt;
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
                    meal_title: { type: 'string', description: 'A concise title for the meal' },
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
    const responseData = await callOpenRouter(platform.env, messages, tools, { type: 'function', function: { name: 'log_meal' } });

    const choice = responseData.choices[0];
    const toolCall = choice.message.tool_calls?.[0];

    if (!toolCall) {
        throw new Error('AI did not return a valid food log.');
    }

    const args = JSON.parse(toolCall.function.arguments);

    // Calculate totals from items
    const items = args.items || [];
    const total_calories = items.reduce((sum, item) => sum + (item.calories || 0), 0);
    const total_protein = Math.round(items.reduce((sum, item) => sum + (item.protein || 0), 0));
    const total_carbs = items.reduce((sum, item) => sum + (item.carbs || 0), 0);

    let reasoning = choice.message.reasoning || choice.message.thought || null;

    // Construct Entry - return but don't save yet
    const entryData = {
        ...args,
        total_calories,
        total_protein,
        total_carbs,
        reasoning,
        user_message: userMessage,
        raw_response: JSON.stringify(responseData),
        messages: [
            { role: 'system', content: systemPrompt },
            { role: 'user', content: [{ type: 'text', text: userMessage || 'Analyze this image' }] },
            choice.message
        ]
    };

    return json(entryData);
}
