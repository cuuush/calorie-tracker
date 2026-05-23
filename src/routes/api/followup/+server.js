import { json } from '@sveltejs/kit';
import { callOpenRouter } from '$lib/server/ai';

/** @type {import('./$types').RequestHandler} */
export async function POST({ request, locals, platform }) {
    if (!locals.user) {
        return json({ error: 'Unauthorized' }, { status: 401 });
    }

    const body = await request.json();
    const { entryId, message, messages: providedMessages } = body;

    let conversation = [];
    let entry = null;

    if (entryId) {
        entry = await locals.storage.getEntryDetails(entryId, locals.user.id);
        if (!entry) return json({ error: 'Entry not found' }, { status: 404 });
        conversation = entry.conversation_messages || [];
    } else if (providedMessages) {
        conversation = providedMessages;
    } else {
        return json({ error: 'Either entryId or messages must be provided' }, { status: 400 });
    }

    const editSystemPrompt = `The user previously described a meal (via text, photo, and/or voice) and you analyzed it into a structured log via the log_meal tool — the prior conversation contains it. The user is now editing that result: adding/removing items, fixing portions, renaming, or correcting macro estimates. You are revising an existing analysis, not analyzing new food.

How to respond:
- Default to action: when the user's change is reasonably clear, call update_log with the COMPLETE updated list of items (not a diff). Include meal_title if the name should change.
- update_log has an optional 'message' field — use it ONLY when you made a non-obvious assumption the user should know about (e.g. "Assumed 2 tbsp of peanut butter."). Omit it otherwise. Never use it for closing pleasantries like "let me know if you want anything else" — those are forbidden.
- Reply with text only when the request is genuinely ambiguous and you need a clarifying question. Keep it short and specific.
- Apply standard nutritionist judgement for portions — don't pester the user for details a reasonable estimate can cover.
- Be terse.`;

    if (conversation.length > 0 && conversation[0].role === 'system') {
        conversation[0] = { role: 'system', content: editSystemPrompt };
    } else {
        conversation.unshift({ role: 'system', content: editSystemPrompt });
    }

    conversation.push({ role: 'user', content: message });

    const tools = [
        {
            type: 'function',
            function: {
                name: 'update_log',
                description: 'Replace the meal log with an updated list of items. Use when you can apply the requested change.',
                parameters: {
                    type: 'object',
                    properties: {
                        meal_title: {
                            type: 'string',
                            description: 'Updated meal title. Only include if the name should change.'
                        },
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
                        },
                        message: {
                            type: 'string',
                            description: 'Optional SHORT note about a non-obvious assumption you made (e.g. "Assumed 2 tbsp of peanut butter"). Omit unless truly informative. Never use for pleasantries or closing remarks.'
                        }
                    },
                    required: ['items']
                }
            }
        }
    ];

    const responseData = await callOpenRouter(platform.env, conversation, tools, 'auto');
    const choice = responseData.choices[0];
    const responseMsg = choice.message;
    conversation.push(responseMsg);

    let updatedEntry = null;
    let toolMessage = null;
    const reasoning = responseMsg.reasoning || responseMsg.thought || null;

    if (responseMsg.tool_calls) {
        for (const toolCall of responseMsg.tool_calls) {
            if (toolCall.function.name !== 'update_log') continue;

            const args = JSON.parse(toolCall.function.arguments);
            const items = args.items || [];
            const total_calories = items.reduce((sum, item) => sum + (item.calories || 0), 0);
            const total_protein = Math.round(items.reduce((sum, item) => sum + (item.protein || 0), 0));
            const total_carbs = items.reduce((sum, item) => sum + (item.carbs || 0), 0);

            if (args.message) toolMessage = args.message;

            if (entry) {
                const newEntry = { ...entry, items, total_calories, total_protein, total_carbs };
                if (args.meal_title) newEntry.meal_title = args.meal_title;
                await locals.storage.saveEntry(newEntry, locals.user.id);
                updatedEntry = newEntry;
            } else {
                updatedEntry = { items, total_calories, total_protein, total_carbs };
                if (args.meal_title) updatedEntry.meal_title = args.meal_title;
            }
        }

        // If the model attached an optional message, keep it in conversation so
        // the transcript reflects what the user saw.
        if (toolMessage) {
            conversation.push({ role: 'assistant', content: toolMessage });
        }
    }

    if (entryId) {
        await locals.storage.updateConversation(entryId, conversation, null, null);
    }

    return json({
        role: 'assistant',
        content: toolMessage || responseMsg.content || null,
        reasoning,
        updatedEntry,
        messages: conversation
    });
}
