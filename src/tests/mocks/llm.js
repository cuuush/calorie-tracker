export function createToolCallResponse(toolName, args, id = 'call_1') {
    return {
        choices: [{
            message: {
                role: 'assistant',
                content: null,
                tool_calls: [{
                    id,
                    type: 'function',
                    function: {
                        name: toolName,
                        arguments: typeof args === 'string' ? args : JSON.stringify(args)
                    }
                }]
            },
            finish_reason: 'tool_calls'
        }]
    };
}

export function createTextResponse(content) {
    return {
        choices: [{
            message: {
                role: 'assistant',
                content
            },
            finish_reason: 'stop'
        }]
    };
}

export function createStreamChunks(events) {
    return events.map(e => `data: ${JSON.stringify(e)}\n\n`).join('') + 'data: [DONE]\n\n';
}

export function createToolCallStreamChunks(toolName, args, id = 'call_1') {
    const argsStr = typeof args === 'string' ? args : JSON.stringify(args);
    return [
        { choices: [{ delta: { tool_calls: [{ index: 0, id, function: { name: toolName, arguments: '' } }] }, finish_reason: null }] },
        { choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: argsStr } }] }, finish_reason: null }] },
        { choices: [{ delta: {}, finish_reason: 'tool_calls' }] }
    ];
}

export function createTextStreamChunks(content) {
    return [
        { choices: [{ delta: { content }, finish_reason: null }] },
        { choices: [{ delta: {}, finish_reason: 'stop' }] }
    ];
}

export function mockFetchSSE(chunkSequences) {
    let callIndex = 0;
    return async (url, opts) => {
        if (typeof url === 'string' && url.includes('openrouter.ai')) {
            const chunks = chunkSequences[callIndex] || chunkSequences[chunkSequences.length - 1];
            callIndex++;
            const body = createStreamChunks(chunks);
            return new Response(body, {
                status: 200,
                headers: { 'Content-Type': 'text/event-stream' }
            });
        }
        throw new Error(`Unexpected fetch to: ${url}`);
    };
}
