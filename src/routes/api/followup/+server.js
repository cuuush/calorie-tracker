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

    const responseData = await callOpenRouter(platform.env, conversation, tools, 'auto');
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

                    await locals.storage.saveEntry(newEntry, locals.user.id);
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
        await locals.storage.updateConversation(entryId, conversation, null, null);
    }

    // If we had tool calls, we should call the model one more time to get a final response
    let finalResponseMsg = responseMsg;
    let finalReasoning = responseMsg.reasoning || null;

    if (responseMsg.tool_calls) {
        const finalResponseData = await callOpenRouter(platform.env, conversation, tools, 'auto');
        finalResponseMsg = finalResponseData.choices[0].message;
        finalReasoning = finalResponseMsg.reasoning || null;
        conversation.push(finalResponseMsg);

        if (entryId) {
            await locals.storage.updateConversation(entryId, conversation, null, null);
        }
    }

    return json({
        role: 'assistant',
        content: finalResponseMsg.content,
        reasoning: finalReasoning,
        updatedEntry: updatedEntry,
        messages: conversation
    });
}
