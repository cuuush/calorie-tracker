export function buildChatHistory(messages) {
    return messages
        .filter((m) => {
            if (m.role === 'user') return true;
            if (m.role === 'assistant') return true;
            if (m.role === 'tool') return true;
            return false;
        })
        .map((m) => {
            const entry = { role: m.role, content: m.content };
            if (m.tool_calls) entry.tool_calls = m.tool_calls;
            if (m.tool_call_id) entry.tool_call_id = m.tool_call_id;
            return entry;
        });
}
