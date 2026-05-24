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
- If multiple images are provided, treat them as views of the SAME meal (different plates, angles, or close-ups) and merge into one consolidated log.

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

function genEntryId() {
    return `${Date.now()}-${Math.random().toString(36).substring(7)}`;
}

function localTimestamp() {
    const now = new Date();
    const pad = (n) => String(n).padStart(2, '0');
    return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}T${pad(now.getHours())}:${pad(now.getMinutes())}:${pad(now.getSeconds())}`;
}

async function fetchAsDataUrl(env, key) {
    const obj = await env.IMAGES.get(key);
    if (!obj) return null;
    const buf = await obj.arrayBuffer();
    const mime = obj.httpMetadata?.contentType || 'application/octet-stream';
    return { dataUrl: `data:${mime};base64,${Base64.fromUint8Array(new Uint8Array(buf))}`, mime };
}

async function buildContentFromKeys(env, message, imageKeys, audioKey) {
    const content = [];
    content.push({ type: 'text', text: message || (imageKeys?.length ? 'Analyze this food.' : '') });

    if (Array.isArray(imageKeys)) {
        for (const k of imageKeys) {
            const fetched = await fetchAsDataUrl(env, k);
            if (fetched) {
                content.push({ type: 'image_url', image_url: { url: fetched.dataUrl } });
            }
        }
    }

    if (audioKey) {
        const obj = await env.IMAGES.get(audioKey);
        if (obj) {
            const buf = await obj.arrayBuffer();
            const mime = obj.httpMetadata?.contentType || 'audio/wav';
            const fmt = mime.includes('mp3') ? 'mp3' : 'wav';
            content.push({
                type: 'input_audio',
                input_audio: { data: Base64.fromUint8Array(new Uint8Array(buf)), format: fmt }
            });
        }
    }

    return content;
}

function stripBinariesFromConversation(conversation, userMessageText) {
    return conversation.map((m) => {
        if (m.role === 'user' && Array.isArray(m.content)) {
            return { role: 'user', content: [{ type: 'text', text: userMessageText || 'Analyze this image' }] };
        }
        return m;
    });
}

function totalsFromItems(items) {
    const total_calories = items.reduce((sum, item) => sum + (item.calories || 0), 0);
    const total_protein = Math.round(items.reduce((sum, item) => sum + (item.protein || 0), 0));
    const total_carbs = items.reduce((sum, item) => sum + (item.carbs || 0), 0);
    return { total_calories, total_protein, total_carbs };
}

function pickModel(hasImage) {
    return hasImage ? 'google/gemini-3.1-pro-preview' : 'google/gemini-3-flash-preview';
}

/** @type {import('./$types').RequestHandler} */
export async function POST({ request, locals, platform }) {
    if (!locals.user) {
        return json({ error: 'Unauthorized' }, { status: 401 });
    }

    const body = await request.json();
    const userId = locals.user.id;
    const storage = locals.storage;
    const env = platform.env;
    const waitUntil = (p) => platform?.context?.waitUntil?.(p);

    const isContinuation = typeof body.tool_call_id === 'string' && typeof body.choice === 'string';

    let entryId;
    let messages;
    let model;
    let userMessage = '';
    let imageKeys = [];
    let audioKey = null;
    let timestamp;

    if (isContinuation) {
        // User answered a clarification — could be live (messages passed) or from history (entryId only).
        entryId = body.entryId;
        if (!entryId) return json({ error: 'entryId required for continuation' }, { status: 400 });

        const entry = await storage.getEntryDetails(entryId, userId);
        if (!entry) return json({ error: 'Entry not found' }, { status: 404 });

        userMessage = entry.user_message || '';
        imageKeys = entry.image_keys || [];
        audioKey = entry.audio_key || null;
        timestamp = entry.timestamp;

        if (Array.isArray(body.messages) && body.messages.length > 0) {
            messages = body.messages;
        } else {
            // Rebuild conversation from storage, re-inlining images from R2 if needed.
            const stored = entry.conversation_messages || [];
            if (stored.length === 0) {
                return json({ error: 'Stored conversation missing' }, { status: 500 });
            }
            const hasImageInline = stored.some((m) =>
                Array.isArray(m.content) && m.content.some((p) => p.type === 'image_url')
            );
            if (hasImageInline || (imageKeys.length === 0 && !audioKey)) {
                messages = stored;
            } else {
                // Rebuild the first user message with fresh image bytes.
                const sys = imagePrompt;
                const userContent = await buildContentFromKeys(env, userMessage, imageKeys, audioKey);
                const rest = stored.slice(stored[0]?.role === 'system' ? 2 : 1);
                messages = [
                    { role: 'system', content: sys },
                    { role: 'user', content: userContent },
                    ...rest
                ];
            }
        }

        messages = [...messages, { role: 'tool', tool_call_id: body.tool_call_id, content: body.choice }];

        const hasImage = messages.some((m) =>
            Array.isArray(m.content) && m.content.some((p) => p.type === 'image_url')
        );
        model = pickModel(hasImage);
    } else {
        // Initial request: { message, imageKeys, audioKey, timestamp? }
        userMessage = body.message || '';
        imageKeys = Array.isArray(body.imageKeys) ? body.imageKeys : [];
        audioKey = body.audioKey || null;
        timestamp = body.timestamp || localTimestamp();
        entryId = body.entryId || genEntryId();

        // Persist a placeholder row first so a disconnect mid-LLM still leaves an entry.
        await storage.saveEntry(
            {
                id: entryId,
                status: 'analyzing',
                timestamp,
                user_message: userMessage,
                items: [],
                image_keys: imageKeys,
                audio_key: audioKey,
                messages: []
            },
            userId
        );

        const content = await buildContentFromKeys(env, userMessage, imageKeys, audioKey);
        const hasImage = imageKeys.length > 0;
        const systemPrompt = hasImage ? imagePrompt : textPrompt;
        messages = [
            { role: 'system', content: systemPrompt },
            { role: 'user', content }
        ];
        model = pickModel(hasImage);
    }

    let responseData;
    try {
        responseData = await callOpenRouter(env, messages, tools, 'required', model);
    } catch (err) {
        // LLM call failed — mark the entry so the user isn't left with a stuck 'analyzing' row.
        if (entryId) await storage.setEntryStatus(entryId, userId, 'awaiting_user').catch(() => {});
        return json({ entryId, error: String(err.message || err) }, { status: 502 });
    }

    const choice = responseData.choices[0];
    const responseMsg = choice.message;
    const toolCall = responseMsg.tool_calls?.[0];
    const reasoning = responseMsg.reasoning || responseMsg.thought || null;
    const updatedConversation = [...messages, responseMsg];

    if (!toolCall) {
        return json({ entryId, error: 'AI did not return a valid response.' }, { status: 502 });
    }

    const baseEntry = {
        id: entryId,
        timestamp,
        user_message: userMessage,
        image_keys: imageKeys,
        audio_key: audioKey,
        raw_response: JSON.stringify(responseData),
        reasoning
    };

    if (toolCall.function.name === 'reject_input') {
        let reason;
        try { reason = JSON.parse(toolCall.function.arguments).reason; } catch { reason = null; }
        // Tear down the placeholder so it doesn't litter history.
        waitUntil(storage.deleteEntry(entryId, userId).catch(() => {}));
        return json({
            entryId,
            rejection: { message: reason || "That doesn't look like food." }
        });
    }

    if (toolCall.function.name === 'ask_clarification') {
        let args;
        try { args = JSON.parse(toolCall.function.arguments); } catch { args = {}; }
        const pending_question = {
            question: args.question || 'Could you clarify?',
            options: Array.isArray(args.options) ? args.options : [],
            tool_call_id: toolCall.id
        };
        // Persist progress: keep full convo (including images) so resume from history works.
        await storage.saveEntry(
            {
                ...baseEntry,
                status: 'awaiting_user',
                items: [],
                messages: updatedConversation,
                pending_question
            },
            userId
        );
        return json({
            entryId,
            clarification: pending_question,
            messages: updatedConversation
        });
    }

    if (toolCall.function.name === 'log_meal') {
        let args;
        try { args = JSON.parse(toolCall.function.arguments); } catch { args = {}; }
        const items = args.items || [];
        const totals = totalsFromItems(items);
        const stripped = stripBinariesFromConversation(updatedConversation, userMessage);

        await storage.saveEntry(
            {
                ...baseEntry,
                status: 'ready',
                meal_title: args.meal_title,
                items,
                ...totals,
                messages: stripped,
                pending_question: null
            },
            userId
        );

        // Clean up pending uploads — analysis succeeded, originals no longer needed.
        const keysToDrop = [...imageKeys, audioKey].filter(Boolean);
        if (keysToDrop.length > 0) {
            waitUntil(
                Promise.all(keysToDrop.map((k) => env.IMAGES.delete(k).catch(() => {})))
            );
        }

        return json({
            entryId,
            meal_title: args.meal_title,
            items,
            ...totals,
            reasoning,
            user_message: userMessage,
            raw_response: JSON.stringify(responseData),
            messages: stripped
        });
    }

    return json({ entryId, error: `Unexpected tool call: ${toolCall.function.name}` }, { status: 502 });
}
