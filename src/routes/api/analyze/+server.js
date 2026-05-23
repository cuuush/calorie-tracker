import { json } from '@sveltejs/kit';
import { Base64 } from 'js-base64';
import { callOpenRouter } from '$lib/server/ai';

const imagePrompt = `Task: From the image (plus any typed text or voice narration the user added), produce a structured meal log with per-item macros, by calling the log_meal tool.

Identify items:
- One entry per distinct food on the plate (protein, starch, vegetable, sauce, drink, etc.). Group obvious sub-components — e.g. lettuce + dressing as one "side salad" — unless the user calls them out separately.
- Don't over-split: cooking oil, salt, common spices, and trace garnishes don't get their own entry.
- Use plate size, utensils, hands, and surrounding objects for portion scale. Restaurant plates ≈ 10–12", home plates ≈ 9".
- If part of the dish is obscured or off-frame, infer from what's visible and what the dish typically contains.
- If the user added text or audio alongside the photo, treat it as authoritative — it overrides what the image alone would suggest (brands, modifications, hidden ingredients, "no cheese", portion sizes, etc.). The photo shows what's on the plate; the narration explains what you can't see.

Macros:
- Estimate calories, protein (g), and carbs (g) per item using typical nutrient values. ±15% is fine — don't agonize over precision.
- Round calories to the nearest 5; round protein and carbs to whole grams.

meal_title:
- A short, natural name for the whole meal as one phrase (e.g. "Chicken caesar wrap", "Steak and roasted veg"). Not a list, not the user's raw caption verbatim.

When NOT to log:
- If the image clearly contains no consumable food — a screenshot, a person, a landscape, a pet, packaging with no visible food — call reject_input with a one-sentence reason.
- Borderline-but-plausibly-food: just estimate. Default to logging.

When to ask a clarifying question:
- If a single ambiguity would materially change macros (whole vs skim milk, regular vs diet soda, fried vs grilled, brand vs generic), call ask_clarification with 2–5 short options. Default to logging — only ask when the macro spread is meaningful (>50 cal or >5g protein difference). Never chain multiple clarifications — ask at most once.`;

const textPrompt = `Task: From the user's description of a meal (typed or spoken), produce a structured meal log with per-item macros, by calling the log_meal tool.

Parse the meal:
- One entry per distinct food. "Chicken burrito with rice and beans" → tortilla, chicken, rice, beans, salsa as separate items.
- Don't over-split: skip oil, salt, herbs, and trace ingredients unless prominent in the description.
- Brand and restaurant names are authoritative — use the actual known item when specified ("Chipotle chicken bowl", "Big Mac", "Quest bar"). Otherwise assume a standard home or restaurant version of the dish.
- If the user gives explicit quantities ("2 slices", "200g", "a venti"), use them. Otherwise assume one standard serving.

Macros:
- Estimate calories, protein (g), and carbs (g) per item using typical nutrient values. ±15% is fine.
- Round calories to the nearest 5; round protein and carbs to whole grams.

meal_title:
- A short, natural phrase for the whole meal. Not the user's raw input verbatim, not a list.

When NOT to log:
- If the input isn't about food — a greeting ("hi", "yo"), an unrelated question, a request to do something else, gibberish — call reject_input with a one-sentence reason.
- Vague but plausibly a meal ("had some pasta", "the usual"): just estimate. Default to logging.

When to ask a clarifying question:
- If a single ambiguity would materially change macros (whole vs skim milk, regular vs diet soda, fried vs grilled, brand vs generic), call ask_clarification with 2–5 short options. Default to logging — only ask when the macro spread is meaningful (>50 cal or >5g protein difference). Never chain multiple clarifications — ask at most once.`;

const tools = [
    {
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
    },
    {
        type: 'function',
        function: {
            name: 'reject_input',
            description: 'Use when the input is not about food and cannot be logged as a meal (e.g. a greeting, an unrelated question, a non-food image, gibberish).',
            parameters: {
                type: 'object',
                properties: {
                    reason: {
                        type: 'string',
                        description: 'A short, friendly explanation of why this input cannot be logged as a meal.'
                    }
                },
                required: ['reason']
            }
        }
    },
    {
        type: 'function',
        function: {
            name: 'ask_clarification',
            description: "Use SPARINGLY — only when a missing detail materially changes macros (whole vs skim milk, regular vs diet soda, fried vs grilled, brand vs generic). Don't ask about unimportant details. Don't ask if the user already specified.",
            parameters: {
                type: 'object',
                properties: {
                    question: { type: 'string', description: 'Short, friendly question. One sentence.' },
                    options: {
                        type: 'array',
                        description: '2–5 likely answers. Do NOT include "Other" — the UI adds it automatically.',
                        items: {
                            type: 'object',
                            properties: {
                                label: { type: 'string', description: 'What the user sees (e.g. "Whole milk")' },
                                value: { type: 'string', description: 'What you receive back (e.g. "whole milk")' }
                            },
                            required: ['label', 'value']
                        }
                    }
                },
                required: ['question', 'options']
            }
        }
    }
];

function stripBinariesFromConversation(conversation, userMessageText) {
    // For storage in `/api/followup` later: drop image/audio base64 from the user
    // message to keep follow-up payloads small. Replace with a text summary.
    return conversation.map((m) => {
        if (m.role === 'user' && Array.isArray(m.content)) {
            return { role: 'user', content: [{ type: 'text', text: userMessageText || 'Analyze this image' }] };
        }
        return m;
    });
}

function dispatchToolCall(toolCall, conversation, userMessageText) {
    if (!toolCall) {
        return { status: 502, body: { error: 'AI did not return a valid response.' } };
    }

    if (toolCall.function.name === 'reject_input') {
        let reason;
        try { reason = JSON.parse(toolCall.function.arguments).reason; } catch { reason = null; }
        return {
            status: 200,
            body: {
                rejection: { message: reason || "That doesn't look like food." }
            }
        };
    }

    if (toolCall.function.name === 'ask_clarification') {
        let args;
        try { args = JSON.parse(toolCall.function.arguments); } catch { args = {}; }
        // Keep full conversation (including image) so the next LLM call still has
        // visual context after the user picks.
        return {
            status: 200,
            body: {
                clarification: {
                    question: args.question || 'Could you clarify?',
                    options: Array.isArray(args.options) ? args.options : [],
                    tool_call_id: toolCall.id
                },
                messages: conversation
            }
        };
    }

    if (toolCall.function.name === 'log_meal') {
        let args;
        try { args = JSON.parse(toolCall.function.arguments); } catch { args = {}; }
        const items = args.items || [];
        const total_calories = items.reduce((sum, item) => sum + (item.calories || 0), 0);
        const total_protein = Math.round(items.reduce((sum, item) => sum + (item.protein || 0), 0));
        const total_carbs = items.reduce((sum, item) => sum + (item.carbs || 0), 0);

        return {
            status: 200,
            body: {
                ...args,
                items,
                total_calories,
                total_protein,
                total_carbs,
                // Strip binaries — this conversation will be saved with the entry and
                // round-tripped through /api/followup, where image bytes aren't needed.
                messages: stripBinariesFromConversation(conversation, userMessageText)
            }
        };
    }

    return { status: 502, body: { error: `Unexpected tool call: ${toolCall.function.name}` } };
}

/** @type {import('./$types').RequestHandler} */
export async function POST({ request, locals, platform }) {
    if (!locals.user) {
        return json({ error: 'Unauthorized' }, { status: 401 });
    }

    const contentType = request.headers.get('content-type') || '';
    let messages;
    let model;
    let reasoning = null;
    let userMessage = '';

    if (contentType.includes('application/json')) {
        // Continuation: user answered a clarification question
        const body = await request.json();
        const { messages: priorMessages, tool_call_id, choice } = body;
        if (!Array.isArray(priorMessages) || !tool_call_id || typeof choice !== 'string') {
            return json({ error: 'Bad request' }, { status: 400 });
        }
        messages = [
            ...priorMessages,
            { role: 'tool', tool_call_id, content: choice }
        ];
        // Recover the original user text (for the eventual stripped message store).
        const firstUser = priorMessages.find((m) => m.role === 'user');
        if (firstUser) {
            if (typeof firstUser.content === 'string') userMessage = firstUser.content;
            else if (Array.isArray(firstUser.content)) {
                const textPart = firstUser.content.find((p) => p.type === 'text');
                if (textPart) userMessage = textPart.text || '';
            }
        }
        // Pick model based on whether the conversation still carries an image.
        const hasImage = priorMessages.some((m) =>
            Array.isArray(m.content) && m.content.some((p) => p.type === 'image_url')
        );
        model = hasImage ? 'google/gemini-3.1-pro-preview' : 'google/gemini-3-flash-preview';
    } else {
        // Initial: multipart form data with image/text/audio
        const formData = await request.formData();
        const imageFile = formData.get('image');
        const audioFile = formData.get('audio');
        userMessage = formData.get('message') || '';

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
                input_audio: { data: base64Audio, format: 'wav' }
            });
        }

        const systemPrompt = imageFile ? imagePrompt : textPrompt;
        messages = [
            { role: 'system', content: systemPrompt },
            { role: 'user', content }
        ];
        model = imageFile ? 'google/gemini-3.1-pro-preview' : 'google/gemini-3-flash-preview';
    }

    const responseData = await callOpenRouter(platform.env, messages, tools, 'required', model);
    const choice = responseData.choices[0];
    const responseMsg = choice.message;
    const toolCall = responseMsg.tool_calls?.[0];
    reasoning = responseMsg.reasoning || responseMsg.thought || null;

    const updatedConversation = [...messages, responseMsg];
    const result = dispatchToolCall(toolCall, updatedConversation, userMessage);

    // Attach reasoning + raw_response on the success path; harmless on rejection/clarification
    if (result.status === 200 && result.body && !result.body.rejection && !result.body.clarification) {
        result.body.reasoning = reasoning;
        result.body.user_message = userMessage;
        result.body.raw_response = JSON.stringify(responseData);
    }

    return json(result.body, { status: result.status });
}
