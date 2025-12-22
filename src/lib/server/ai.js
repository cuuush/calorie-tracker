export async function callOpenRouter(env, messages, tools = null, toolChoice = 'auto') {
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
            'Authorization': `Bearer ${env.OPENROUTER_API_KEY}`,
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
