function sse(event, data) {
    return `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
}

function formatDateInZone(date, timezone) {
    return new Intl.DateTimeFormat('en-US', {
        timeZone: timezone,
        weekday: 'short',
        year: 'numeric',
        month: 'long',
        day: 'numeric',
        hour: 'numeric',
        minute: '2-digit',
        timeZoneName: 'short'
    }).format(date);
}

function formatTimeInZone(isoTimestamp, timezone) {
    const d = new Date(isoTimestamp.includes('T') && !isoTimestamp.endsWith('Z') ? isoTimestamp : isoTimestamp);
    return new Intl.DateTimeFormat('en-US', {
        timeZone: timezone,
        hour: 'numeric',
        minute: '2-digit'
    }).format(d);
}

function formatEntry(e, timezone, proteinFocused = false) {
    const time = formatTimeInZone(e.timestamp, timezone);
    const parts = [`${time} — ${e.meal_title || 'Meal'}`];
    const macros = [];
    if (proteinFocused) {
        if (e.total_protein) macros.push(`${Math.round(e.total_protein)}g P`);
        else macros.push('0g P');
    } else {
        macros.push(`${Math.round(e.total_calories || 0)} cal`);
        if (e.total_protein) macros.push(`${Math.round(e.total_protein)}g P`);
        if (e.total_carbs) macros.push(`${Math.round(e.total_carbs)}g C`);
    }
    parts.push(`(${macros.join(', ')})`);
    if (Array.isArray(e.items) && e.items.length > 0) {
        const itemList = e.items.map(i => i.name).filter(Boolean).join(', ');
        if (itemList) parts.push(`— items: ${itemList}`);
    }
    return `- ${parts.join(' ')}`;
}

function todayBoundsLocal(clientNow) {
    // clientNow is e.g. "2026-05-19T11:32:00" (already in user's local time)
    const datePart = clientNow.split('T')[0];
    return {
        startISO: `${datePart}T00:00:00`,
        endISO: `${datePart}T23:59:59`
    };
}

function fmtDate(date) {
    const yr = date.getFullYear();
    const mo = String(date.getMonth() + 1).padStart(2, '0');
    const dy = String(date.getDate()).padStart(2, '0');
    return `${yr}-${mo}-${dy}`;
}

function yesterdayBoundsLocal(clientNow) {
    const datePart = clientNow.split('T')[0];
    const [y, m, d] = datePart.split('-').map(Number);
    const yesterday = new Date(y, m - 1, d);
    yesterday.setDate(yesterday.getDate() - 1);
    const ymd = fmtDate(yesterday);
    return {
        startISO: `${ymd}T00:00:00`,
        endISO: `${ymd}T23:59:59`
    };
}

function priorWeekBoundsLocal(clientNow) {
    // Returns the 7 days before YESTERDAY (days -2 through -8 from today).
    // Today and yesterday are already included in the system prompt.
    const datePart = clientNow.split('T')[0];
    const [y, m, d] = datePart.split('-').map(Number);
    const today = new Date(y, m - 1, d);
    const twoAgo = new Date(today);
    twoAgo.setDate(twoAgo.getDate() - 2);
    const eightAgo = new Date(today);
    eightAgo.setDate(eightAgo.getDate() - 8);
    return {
        startISO: `${fmtDate(eightAgo)}T00:00:00`,
        endISO: `${fmtDate(twoAgo)}T23:59:59`
    };
}

// Meal split for weight loss + muscle gain: protein evenly distributed across
// main meals for MPS, calories slightly back-loaded toward lunch/dinner.
const MEAL_SPLIT = {
    BREAKFAST: { cal: 0.25, protein: 0.30, label: 'Breakfast', range: '4–11 AM' },
    LUNCH:     { cal: 0.30, protein: 0.30, label: 'Lunch',     range: '11 AM–4 PM' },
    DINNER:    { cal: 0.30, protein: 0.30, label: 'Dinner',    range: '4–10 PM' },
    SNACK:     { cal: 0.15, protein: 0.10, label: 'Snack',     range: 'other times' }
};

function bucketByHour(h) {
    if (h >= 4 && h < 11) return 'BREAKFAST';
    if (h >= 11 && h < 16) return 'LUNCH';
    if (h >= 16 && h < 22) return 'DINNER';
    return 'SNACK';
}

function bucketEntries(entries) {
    const buckets = { BREAKFAST: [], LUNCH: [], DINNER: [], SNACK: [] };
    for (const e of entries) {
        const timePart = e.timestamp.split('T')[1] || '00:00:00';
        const hour = parseInt(timePart.split(':')[0], 10);
        buckets[bucketByHour(hour)].push(e);
    }
    return buckets;
}

function buildBudgetBlock(settings, buckets, todayTotal, todayProtein, clientNow) {
    const proteinFocused = settings.protein_focused_mode === 1;
    const dailyCal = settings.maintenance_calories;
    const dailyProt = settings.protein_goal;
    if (!dailyCal && !dailyProt) return null;

    const protBudget = dailyProt || 150;
    const remProt = Math.max(0, protBudget - todayProtein);

    const hourNow = parseInt((clientNow.split('T')[1] || '00:00').split(':')[0], 10);
    const currentBucket = bucketByHour(hourNow);

    const lines = [];

    if (proteinFocused) {
        // Protein-only mode: don't mention calories anywhere.
        lines.push(`Daily protein target: ${protBudget}g.`);
        lines.push(`Consumed today: ${Math.round(todayProtein)}g.`);
        lines.push(`Remaining today: ${Math.round(remProt)}g.`);
        lines.push('');
        lines.push('Protein distribution by meal slot:');
        for (const key of ['BREAKFAST', 'LUNCH', 'DINNER', 'SNACK']) {
            const split = MEAL_SPLIT[key];
            const tgtProt = Math.round(protBudget * split.protein);
            const consumedProt = buckets[key].reduce((s, e) => s + (e.total_protein || 0), 0);
            const status = buckets[key].length === 0
                ? 'not logged'
                : `${Math.round(consumedProt)}/${tgtProt}g`;
            const flag = key === currentBucket ? '  ← current meal slot' : '';
            lines.push(`- ${split.label} (${split.range}): target ${tgtProt}g — ${status}${flag}`);
        }
        return lines.join('\n');
    }

    const calBudget = dailyCal || 2000;
    const remCal = Math.max(0, calBudget - todayTotal);
    lines.push(`Daily targets: ${calBudget} cal · ${protBudget}g protein.`);
    lines.push(`Consumed today: ${Math.round(todayTotal)} cal · ${Math.round(todayProtein)}g protein.`);
    lines.push(`Remaining today: ${Math.round(remCal)} cal · ${Math.round(remProt)}g protein.`);
    lines.push('');
    lines.push('Meal plan (suggested distribution):');
    for (const key of ['BREAKFAST', 'LUNCH', 'DINNER', 'SNACK']) {
        const split = MEAL_SPLIT[key];
        const tgtCal = Math.round(calBudget * split.cal);
        const tgtProt = Math.round(protBudget * split.protein);
        const consumedCal = buckets[key].reduce((s, e) => s + (e.total_calories || 0), 0);
        const consumedProt = buckets[key].reduce((s, e) => s + (e.total_protein || 0), 0);
        const status = buckets[key].length === 0
            ? 'not logged'
            : `${Math.round(consumedCal)}/${tgtCal} cal, ${Math.round(consumedProt)}/${tgtProt}g P`;
        const flag = key === currentBucket ? '  ← current meal slot' : '';
        lines.push(`- ${split.label} (${split.range}): target ${tgtCal} cal / ${tgtProt}g P — ${status}${flag}`);
    }
    return lines.join('\n');
}

async function buildSystemPrompt({ storage, userId, clientNow, timezone }) {
    const settings = (await storage.getUserSettings(userId)) || {};
    const proteinFocused = settings.protein_focused_mode === 1;
    const { startISO: todayStart, endISO: todayEnd } = todayBoundsLocal(clientNow);
    const { startISO: yStart, endISO: yEnd } = yesterdayBoundsLocal(clientNow);
    const [todayEntries, yesterdayEntries] = await Promise.all([
        storage.getEntriesBetween(userId, todayStart, todayEnd),
        storage.getEntriesBetween(userId, yStart, yEnd)
    ]);

    const nowDate = new Date();
    const nowStr = formatDateInZone(nowDate, timezone);

    const todayTotal = todayEntries.reduce((s, e) => s + (e.total_calories || 0), 0);
    const todayProtein = todayEntries.reduce((s, e) => s + (e.total_protein || 0), 0);
    const todayCarbs = todayEntries.reduce((s, e) => s + (e.total_carbs || 0), 0);
    const yTotal = yesterdayEntries.reduce((s, e) => s + (e.total_calories || 0), 0);
    const yProtein = yesterdayEntries.reduce((s, e) => s + (e.total_protein || 0), 0);
    const yCarbs = yesterdayEntries.reduce((s, e) => s + (e.total_carbs || 0), 0);

    const profileLines = [];
    if (settings.gender || settings.age) {
        profileLines.push(`- Sex/Age: ${settings.gender || 'unspecified'}, ${settings.age || 'unspecified'}`);
    }
    if (settings.weight) {
        profileLines.push(`- Weight: ${settings.weight}${settings.weight_unit || 'lbs'}`);
    }
    if (settings.height) {
        profileLines.push(`- Height: ${settings.height}${settings.height_unit || 'in'}`);
    }
    if (!proteinFocused && settings.maintenance_calories) {
        profileLines.push(`- Daily calorie target: ${settings.maintenance_calories}`);
    }
    if (settings.protein_goal) {
        profileLines.push(`- Protein goal: ${settings.protein_goal}g`);
    }
    if (settings.activity_level) {
        profileLines.push(`- Activity: ${settings.activity_level}`);
    }
    if (proteinFocused) {
        profileLines.push('- MODE: protein-focused. The user only cares about hitting their daily protein target. DO NOT mention calories, do not suggest "light" or "low-cal" framings, do not reason about caloric deficits.');
    }
    const goalsText = (settings.goals || '').trim();
    if (goalsText) {
        profileLines.push(`- Goals: ${goalsText}`);
    } else {
        profileLines.push('- Goals: (not set — give general balanced advice or ask the user what they\'re working toward)');
    }
    const profileBlock = profileLines.length > 0
        ? profileLines.join('\n')
        : '- (no profile saved yet)';

    const todayTotalsLine = proteinFocused
        ? `Totals so far: ${Math.round(todayProtein)}g protein.`
        : `Totals so far: ${Math.round(todayTotal)} cal · ${Math.round(todayProtein)}g protein · ${Math.round(todayCarbs)}g carbs.`;
    const todayBlock = todayEntries.length > 0
        ? todayEntries.map(e => formatEntry(e, timezone, proteinFocused)).join('\n') +
          `\n${todayTotalsLine}`
        : '- (nothing logged yet today)';

    const yesterdayTotalsLine = proteinFocused
        ? `Yesterday totals: ${Math.round(yProtein)}g protein.`
        : `Yesterday totals: ${Math.round(yTotal)} cal · ${Math.round(yProtein)}g protein · ${Math.round(yCarbs)}g carbs.`;
    const yesterdayBlock = yesterdayEntries.length > 0
        ? yesterdayEntries.map(e => formatEntry(e, timezone, proteinFocused)).join('\n') +
          `\n${yesterdayTotalsLine}`
        : null;

    const yesterdaySection = yesterdayBlock
        ? `\nYesterday:\n${yesterdayBlock}\n`
        : '';

    const buckets = bucketEntries(todayEntries);
    const budgetBlock = buildBudgetBlock(settings, buckets, todayTotal, todayProtein, clientNow);
    const budgetSection = budgetBlock
        ? `\nBudget tracker:\n${budgetBlock}\n`
        : '';

    const responseGuidance = proteinFocused
        ? `How to respond:
- Focus ENTIRELY on protein. The user is in protein-focused mode — they don't care about calories, carbs, fat, or "lightness."
- Use the user's goals (above) to interpret how to frame protein recommendations. Their goal tells you what "good" looks like for them.
- When suggesting meals, target the protein gap for the current meal slot. Categories are fine when brainstorming — pair them with one or two concrete examples ("a high-protein snack like Greek yogurt or a Quest bar gets you ~25g"). If the user wants a single answer, give a specific recommendation.
- Never use language like "low-calorie", "light", "lean", "low-fat" framings as selling points. Don't apologize for calorie content; ignore it.
- If the user asks about calories explicitly, give a number but don't editorialize.
- Reference yesterday's protein totals naturally when relevant.
- If the user asks about trends spanning more than two days, call get_meals_last_7_days. Today and yesterday are already included above — don't fetch the tool for questions answerable from those.
- Don't restate the data dump in your reply — reference specific entries naturally ("the chicken at 1 PM").
- Times shown above are in the user's local timezone.
- Keep replies short and conversational. Use markdown (bullets, **bold**) when it actually helps readability — don't over-format short answers.`
        : `How to respond:
- Give concrete, actionable suggestions tied to the user's actual data and goals.
- The calorie + protein targets above already reflect the user's stated goals. Don't second-guess them by suggesting "lighter" alternatives unless the user explicitly asks for one — if the meal-slot target is 700 cal, then 700 cal is on-plan. Use the user's goals (above) to interpret what an appropriate recommendation looks like: a bulk lets you lean into calorie-dense satisfying meals; a cut means hitting the target without going over; maintenance means filling the budget. When the goal is unclear or unset, ask the user briefly.
- Categories are fine when brainstorming, but always pair them with one or two concrete examples ("a high-protein lean meal — like grilled chicken with rice, or a tuna wrap"). If the user wants a single answer, name a specific dish.
- Reason about fat, fiber, and sugar from item names when relevant — we don't track them explicitly but they matter for satiety and adherence.
- Don't recommend "consult a doctor" for routine nutrition questions — just answer.
- Reference yesterday's meals naturally when relevant ("you did better on protein yesterday").
- If the user asks about trends spanning more than two days, call get_meals_last_7_days. Today and yesterday are already included above — don't fetch the tool for questions answerable from those.
- Don't restate the data dump in your reply — reference specific entries naturally ("the toast at 8 AM").
- Times shown above are in the user's local timezone.
- Keep replies short and conversational. Use markdown (bullets, **bold**) when it actually helps readability — don't over-format short answers.`;

    return `You are a friendly, concrete nutrition assistant for the user. Be brief and warm — don't lecture.

Right now it is ${nowStr}. Timezone: ${timezone}.

User profile:
${profileBlock}
${budgetSection}${yesterdaySection}
Today so far:
${todayBlock}

${responseGuidance}`;
}

const TOOLS = [
    {
        type: 'function',
        function: {
            name: 'get_meals_last_7_days',
            description: "Fetch the user's meals from days -2 through -8 (the week BEFORE yesterday). Today and yesterday are already in the system prompt; do not call this for those. Use only for weekly trend analysis or older comparisons.",
            parameters: { type: 'object', properties: {}, required: [] }
        }
    }
];

async function executeTool(name, storage, userId, clientNow, timezone) {
    if (name === 'get_meals_last_7_days') {
        const { startISO, endISO } = priorWeekBoundsLocal(clientNow);
        const entries = await storage.getEntriesBetween(userId, startISO, endISO);
        const formatted = entries.map(e => {
            const dateStr = e.timestamp.split('T')[0];
            return {
                date: dateStr,
                time: formatTimeInZone(e.timestamp, timezone),
                meal_title: e.meal_title,
                calories: Math.round(e.total_calories || 0),
                protein_g: Math.round(e.total_protein || 0),
                carbs_g: Math.round(e.total_carbs || 0),
                items: (e.items || []).map(i => i.name).filter(Boolean)
            };
        });
        return { entries: formatted, count: formatted.length };
    }
    return { error: `Unknown tool: ${name}` };
}

async function* streamOpenRouterChunks(env, messages, tools) {
    const body = {
        model: 'openai/gpt-5.5',
        messages,
        stream: true,
        reasoning: { effort: 'medium' },
        tools,
        tool_choice: 'auto'
    };

    const res = await fetch('https://openrouter.ai/api/v1/chat/completions', {
        method: 'POST',
        headers: {
            Authorization: `Bearer ${env.OPENROUTER_API_KEY}`,
            'Content-Type': 'application/json',
            'HTTP-Referer': 'https://cuuush.com',
            'X-Title': 'Calorie Tracker — Chat'
        },
        body: JSON.stringify(body)
    });

    if (!res.ok) {
        const errText = await res.text();
        throw new Error(`OpenRouter ${res.status}: ${errText}`);
    }

    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split('\n');
        buffer = lines.pop() || '';
        for (const line of lines) {
            const trimmed = line.trim();
            if (!trimmed.startsWith('data:')) continue;
            const data = trimmed.slice(5).trim();
            if (data === '[DONE]') return;
            try {
                yield JSON.parse(data);
            } catch {
                // ignore non-JSON
            }
        }
    }
}

/** @type {import('./$types').RequestHandler} */
export async function POST({ request, locals, platform }) {
    if (!locals.user) {
        return new Response(JSON.stringify({ error: 'Unauthorized' }), {
            status: 401,
            headers: { 'Content-Type': 'application/json' }
        });
    }

    const body = await request.json();
    const { messages: userMessages, clientNow, timezone, conversation_id } = body;

    if (!Array.isArray(userMessages) || !clientNow || !timezone) {
        return new Response(JSON.stringify({ error: 'Bad request' }), {
            status: 400,
            headers: { 'Content-Type': 'application/json' }
        });
    }

    if (!platform?.env?.OPENROUTER_API_KEY) {
        return new Response(JSON.stringify({ error: 'Server missing OpenRouter key' }), {
            status: 500,
            headers: { 'Content-Type': 'application/json' }
        });
    }

    const storage = locals.storage;
    const userId = locals.user.id;
    const systemPrompt = await buildSystemPrompt({ storage, userId, clientNow, timezone });

    // Create or use existing conversation id. We persist on user send + on stream end.
    let convoId = conversation_id;
    const firstUserMessage = userMessages.find(m => m.role === 'user');
    const title = firstUserMessage
        ? firstUserMessage.content.slice(0, 60)
        : 'New chat';
    if (!convoId) {
        convoId = await storage.createChatConversation(userId, title);
    }
    // Persist user-visible messages now so they survive if the stream dies.
    await storage.saveChatConversation(convoId, userId, userMessages, title);

    const conversation = [
        { role: 'system', content: systemPrompt },
        ...userMessages.map(m => ({ role: m.role, content: m.content }))
    ];

    const encoder = new TextEncoder();
    const stream = new ReadableStream({
        async start(controller) {
            const send = (event, data) => controller.enqueue(encoder.encode(sse(event, data)));
            // Emit conversation id immediately so client can store it.
            send('conversation', { id: convoId });

            // Track the visible (UI-facing) assistant message we're building so we can
            // persist it server-side when the stream completes.
            const finalAssistant = {
                role: 'assistant',
                content: '',
                reasoning: '',
                toolEvents: [],
                thinkingStartMs: null,
                thinkingEndMs: null
            };

            try {
                let turn = 0;
                const MAX_TURNS = 4; // initial + up to 3 tool rounds
                while (turn < MAX_TURNS) {
                    turn++;
                    let assistantContent = '';
                    let assistantReasoning = '';
                    const toolCalls = []; // [{ id, name, args (accumulating string) }]
                    let finishReason = null;

                    for await (const chunk of streamOpenRouterChunks(platform.env, conversation, TOOLS)) {
                        const choice = chunk.choices?.[0];
                        if (!choice) continue;
                        const delta = choice.delta || {};

                        if (delta.reasoning) {
                            if (!finalAssistant.thinkingStartMs) finalAssistant.thinkingStartMs = Date.now();
                            assistantReasoning += delta.reasoning;
                            finalAssistant.reasoning += delta.reasoning;
                            send('reasoning', { delta: delta.reasoning });
                        }
                        if (delta.content) {
                            if (finalAssistant.reasoning && !finalAssistant.thinkingEndMs) {
                                finalAssistant.thinkingEndMs = Date.now();
                            }
                            assistantContent += delta.content;
                            finalAssistant.content += delta.content;
                            send('text', { delta: delta.content });
                        }
                        if (Array.isArray(delta.tool_calls)) {
                            for (const tc of delta.tool_calls) {
                                const idx = tc.index ?? 0;
                                if (!toolCalls[idx]) {
                                    toolCalls[idx] = { id: tc.id || '', name: '', args: '' };
                                    if (tc.function?.name) {
                                        toolCalls[idx].name = tc.function.name;
                                        finalAssistant.toolEvents.push({ name: tc.function.name, state: 'running' });
                                        send('tool_start', { name: tc.function.name });
                                    }
                                }
                                if (tc.id) toolCalls[idx].id = tc.id;
                                if (tc.function?.name && !toolCalls[idx].name) {
                                    toolCalls[idx].name = tc.function.name;
                                    finalAssistant.toolEvents.push({ name: tc.function.name, state: 'running' });
                                    send('tool_start', { name: tc.function.name });
                                }
                                if (tc.function?.arguments) {
                                    toolCalls[idx].args += tc.function.arguments;
                                }
                            }
                        }
                        if (choice.finish_reason) finishReason = choice.finish_reason;
                    }

                    if (finishReason === 'tool_calls' && toolCalls.length > 0) {
                        // Add assistant tool-call message
                        conversation.push({
                            role: 'assistant',
                            content: assistantContent || null,
                            tool_calls: toolCalls.map(t => ({
                                id: t.id,
                                type: 'function',
                                function: { name: t.name, arguments: t.args || '{}' }
                            }))
                        });
                        // Execute each tool and append tool responses
                        for (const tc of toolCalls) {
                            const result = await executeTool(tc.name, storage, userId, clientNow, timezone);
                            const ev = finalAssistant.toolEvents.find(t => t.name === tc.name && t.state === 'running');
                            if (ev) ev.state = 'done';
                            send('tool_end', { name: tc.name });
                            conversation.push({
                                role: 'tool',
                                tool_call_id: tc.id,
                                content: JSON.stringify(result)
                            });
                        }
                        continue; // loop and call OpenRouter again
                    }

                    // Normal stop
                    break;
                }

                if (finalAssistant.reasoning && !finalAssistant.thinkingEndMs) {
                    finalAssistant.thinkingEndMs = Date.now();
                }

                send('done', {});

                // Persist the full conversation with the final assistant turn.
                if (finalAssistant.content || finalAssistant.toolEvents.length > 0) {
                    try {
                        await storage.saveChatConversation(
                            convoId,
                            userId,
                            [...userMessages, finalAssistant],
                            title
                        );
                    } catch (e) {
                        console.error('Failed to persist chat conversation:', e);
                    }
                }
            } catch (err) {
                send('error', { error: err?.message || String(err) });
                // Persist partial state on error too — better than losing the user's message.
                if (finalAssistant.content || finalAssistant.reasoning) {
                    try {
                        await storage.saveChatConversation(
                            convoId,
                            userId,
                            [...userMessages, finalAssistant],
                            title
                        );
                    } catch {}
                }
            } finally {
                controller.close();
            }
        }
    });

    return new Response(stream, {
        headers: {
            'Content-Type': 'text/event-stream',
            'Cache-Control': 'no-cache, no-transform',
            'X-Accel-Buffering': 'no'
        }
    });
}
