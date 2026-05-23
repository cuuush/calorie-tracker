<script>
	import { onMount, tick } from 'svelte';
	import { Send, Sparkles, ChevronRight, Search, Check, ArrowDown, Clock, Plus, Trash2 } from 'lucide-svelte';
	import { marked } from 'marked';
	import { toast } from '$lib/toast.svelte.js';
	import { abortableSleep } from '$lib/net.js';

	marked.setOptions({ gfm: true, breaks: false });

	function renderMd(text) {
		try {
			return marked.parse((text || '').trimEnd());
		} catch {
			return text || '';
		}
	}

	let { messages = $bindable([]), conversationId = $bindable(null) } = $props();
	let input = $state('');
	let streaming = $state(false);
	let textarea = $state(null);
	let scrollEl = $state(null);
	let isAtBottom = $state(true);
	let showHistory = $state(false);
	let conversationList = $state([]);
	let loadingList = $state(false);
	let nowMs = $state(Date.now());
	let tickInterval = null;
	let pendingDeleteId = $state(null);

	function makeClientNow() {
		const n = new Date();
		const p = (x) => String(x).padStart(2, '0');
		return `${n.getFullYear()}-${p(n.getMonth() + 1)}-${p(n.getDate())}T${p(n.getHours())}:${p(n.getMinutes())}:${p(n.getSeconds())}`;
	}

	const TOOL_LABELS = {
		get_meals_last_7_days: 'Looking at last 7 days'
	};

	function parseSSE(buffer) {
		const parsed = [];
		const blocks = buffer.split('\n\n');
		const remainder = blocks.pop() || '';
		for (const block of blocks) {
			let event = 'message';
			let data = '';
			for (const line of block.split('\n')) {
				if (line.startsWith('event:')) event = line.slice(6).trim();
				else if (line.startsWith('data:')) data += line.slice(5).trim();
			}
			if (!data) continue;
			try {
				parsed.push({ event, data: JSON.parse(data) });
			} catch {
				// ignore
			}
		}
		return { parsed, remainder };
	}

	async function autoScroll() {
		await tick();
		if (scrollEl && isAtBottom) scrollEl.scrollTop = scrollEl.scrollHeight;
	}

	async function jumpToBottom() {
		await tick();
		if (scrollEl) {
			scrollEl.scrollTop = scrollEl.scrollHeight;
			isAtBottom = true;
		}
	}

	function onScroll() {
		if (!scrollEl) return;
		const distance = scrollEl.scrollHeight - scrollEl.scrollTop - scrollEl.clientHeight;
		isAtBottom = distance < 60;
	}

	function autosize() {
		if (!textarea) return;
		textarea.style.height = 'auto';
		textarea.style.height = Math.min(textarea.scrollHeight, 140) + 'px';
	}

	async function send() {
		const trimmed = input.trim();
		if (!trimmed || streaming) return;

		const history = messages
			.filter((m) => m.role === 'user' || (m.role === 'assistant' && m.content))
			.map((m) => ({ role: m.role, content: m.content }));

		messages = [
			...messages,
			{ role: 'user', content: trimmed },
			{
				role: 'assistant',
				content: '',
				reasoning: '',
				toolEvents: [],
				reasoningOpen: false,
				thinkingStartMs: null,
				thinkingEndMs: null
			}
		];
		const lastIdx = messages.length - 1;
		input = '';
		autosize();
		streaming = true;
		// Force scroll to bottom when user sends a message — they expect to see their own message.
		isAtBottom = true;
		await autoScroll();

		// Tick once per 100ms so the live thinking timer updates while the model is reasoning.
		if (tickInterval) clearInterval(tickInterval);
		tickInterval = setInterval(() => { nowMs = Date.now(); }, 100);

		// Retry loop: re-fire the request if the stream is interrupted mid-flight (no `done` event).
		// The conversation is persisted server-side per-turn, so retries are safe and idempotent
		// from the DB's perspective (the user message is saved at the start of each attempt).
		const RETRY_BUDGET_MS = 5 * 60 * 1000;
		const deadline = Date.now() + RETRY_BUDGET_MS;
		let attempt = 0;
		let reconnectToastShown = false;
		let receivedDone = false;
		let nonRetriableError = null;

		const showReconnectToast = () => {
			if (reconnectToastShown) return;
			toast('Reconnecting…');
			reconnectToastShown = true;
		};

		const waitForOnline = () => {
			if (typeof navigator === 'undefined' || navigator.onLine !== false) {
				return Promise.resolve();
			}
			showReconnectToast();
			return new Promise((resolve) => {
				const onOnline = () => {
					window.removeEventListener('online', onOnline);
					resolve();
				};
				window.addEventListener('online', onOnline);
			});
		};

		try {
			while (!receivedDone) {
				// Wipe any partial assistant content from a previous failed attempt before the retry.
				if (attempt > 0) {
					const m = messages[lastIdx];
					if (m) {
						m.content = '';
						m.reasoning = '';
						m.toolEvents = [];
						m.thinkingStartMs = null;
						m.thinkingEndMs = null;
					}
				}

				// If the browser thinks we're offline, wait for online before trying.
				await waitForOnline();

				try {
					const res = await fetch('/api/chat', {
						method: 'POST',
						headers: { 'Content-Type': 'application/json' },
						body: JSON.stringify({
							messages: [...history, { role: 'user', content: trimmed }],
							clientNow: makeClientNow(),
							timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
							conversation_id: conversationId
						})
					});

					if (!res.ok) {
						// 4xx — don't retry, surface error and stop.
						if (res.status >= 400 && res.status < 500) {
							const err = await res.json().catch(() => ({}));
							nonRetriableError = err.error || `Chat request failed (${res.status})`;
							break;
						}
						// 5xx — fall through to retry path.
						throw new Error(`HTTP ${res.status}`);
					}

					const reader = res.body.getReader();
					const decoder = new TextDecoder();
					let buffer = '';
					while (true) {
						const { done, value } = await reader.read();
						if (done) break;
						buffer += decoder.decode(value, { stream: true });
						const { parsed, remainder } = parseSSE(buffer);
						buffer = remainder;
						for (const ev of parsed) {
							if (ev.event === 'done') receivedDone = true;
							handleEvent(lastIdx, ev);
						}
						await autoScroll();
					}
					if (receivedDone) break;
					// Stream ended without `done` → connection was cut mid-flight; retry.
					console.warn('Chat stream ended without done event — retrying');
				} catch (err) {
					// Any thrown error here (network failure, 5xx, etc.) is retriable.
					console.error('Chat stream failed, retrying…', err);
				}

				showReconnectToast();
				const wait = Math.min(500 * Math.pow(2, attempt), 4000);
				if (Date.now() + wait > deadline) {
					nonRetriableError = 'Lost connection. Try again when you have signal.';
					break;
				}
				await abortableSleep(wait);
				attempt++;
			}

			if (nonRetriableError) {
				toast(nonRetriableError, { kind: 'error' });
				if (attempt === 0) messages.splice(lastIdx, 1);
			}
		} finally {
			streaming = false;
			if (tickInterval) { clearInterval(tickInterval); tickInterval = null; }
			const m = messages[lastIdx];
			if (m && m.reasoning && !m.thinkingEndMs) m.thinkingEndMs = Date.now();
			if (m && !m.content && !(m.toolEvents && m.toolEvents.length > 0)) {
				m.content = '_(no response — try again)_';
				toast('Got an empty reply from the model', { kind: 'error' });
			}
			await autoScroll();
		}
	}

	function handleEvent(idx, ev) {
		const m = messages[idx];
		if (!m) return;

		if (ev.event === 'conversation') {
			if (ev.data?.id) conversationId = ev.data.id;
			return;
		}
		if (ev.event === 'reasoning') {
			if (!m.thinkingStartMs) m.thinkingStartMs = Date.now();
			m.reasoning = (m.reasoning || '') + (ev.data.delta || '');
		} else if (ev.event === 'text') {
			if (m.reasoning && !m.thinkingEndMs) {
				m.thinkingEndMs = Date.now();
			}
			m.content = (m.content || '') + (ev.data.delta || '');
		} else if (ev.event === 'tool_start') {
			m.toolEvents = [...(m.toolEvents || []), { name: ev.data.name, state: 'running' }];
		} else if (ev.event === 'tool_end') {
			const i = m.toolEvents.findIndex((t) => t.name === ev.data.name && t.state === 'running');
			if (i >= 0) m.toolEvents[i].state = 'done';
		} else if (ev.event === 'error') {
			toast(ev.data.error || 'Error during reply', { kind: 'error' });
		}
	}

	function onKey(e) {
		if (e.key === 'Enter' && !e.shiftKey) {
			e.preventDefault();
			send();
		}
	}

	function thinkingLabel(m) {
		if (!m.thinkingStartMs) return 'Thinking…';
		if (!m.thinkingEndMs) {
			// Live count while still reasoning. nowMs ticks every 100ms during stream.
			const secs = ((nowMs - m.thinkingStartMs) / 1000).toFixed(1);
			return `Thinking for ${secs}s…`;
		}
		const secs = ((m.thinkingEndMs - m.thinkingStartMs) / 1000).toFixed(1);
		return `Thought for ${secs}s`;
	}

	function newChat() {
		if (streaming) return;
		messages = [];
		conversationId = null;
		showHistory = false;
		input = '';
		autosize();
		isAtBottom = true;
	}

	async function openHistory() {
		showHistory = true;
		loadingList = true;
		try {
			const res = await fetch('/api/chat/conversations');
			if (res.ok) conversationList = await res.json();
		} catch (e) {
			toast('Failed to load history', { kind: 'error' });
		} finally {
			loadingList = false;
		}
	}

	async function loadConversation(id) {
		if (streaming) return;
		try {
			const res = await fetch(`/api/chat/conversations/${id}`);
			if (!res.ok) {
				toast('Failed to load conversation', { kind: 'error' });
				return;
			}
			const convo = await res.json();
			messages = (convo.messages || []).map((m) => ({
				...m,
				reasoningOpen: false
			}));
			conversationId = convo.id;
			showHistory = false;
			isAtBottom = true;
			await tick();
			if (scrollEl) scrollEl.scrollTop = scrollEl.scrollHeight;
		} catch (e) {
			toast('Failed to load conversation', { kind: 'error' });
		}
	}

	function requestDelete(id, e) {
		e.stopPropagation();
		pendingDeleteId = id;
	}

	function cancelDelete(e) {
		e?.stopPropagation();
		pendingDeleteId = null;
	}

	async function confirmDelete(id, e) {
		e.stopPropagation();
		pendingDeleteId = null;
		try {
			const res = await fetch(`/api/chat/conversations/${id}`, { method: 'DELETE' });
			if (res.ok) {
				conversationList = conversationList.filter((c) => c.id !== id);
				if (conversationId === id) newChat();
			} else {
				toast('Failed to delete', { kind: 'error' });
			}
		} catch (err) {
			toast('Failed to delete', { kind: 'error' });
		}
	}

	function fmtTimestamp(s) {
		if (!s) return '';
		// D1 returns 'YYYY-MM-DD HH:MM:SS' UTC. Format to local.
		const d = new Date(s.replace(' ', 'T') + 'Z');
		const now = new Date();
		const sameDay = d.toDateString() === now.toDateString();
		const yesterday = new Date(now);
		yesterday.setDate(yesterday.getDate() - 1);
		const isYesterday = d.toDateString() === yesterday.toDateString();
		if (sameDay) return d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
		if (isYesterday) return 'Yesterday';
		return d.toLocaleDateString([], { month: 'short', day: 'numeric' });
	}

	onMount(() => {
		autosize();
	});
</script>

<div class="chat-view">
	<div class="chat-header">
		<button class="header-btn" onclick={openHistory} aria-label="Chat history" title="Past conversations">
			<Clock size={16} />
		</button>
		<button class="header-btn" onclick={newChat} disabled={streaming} aria-label="New chat" title="New chat">
			<Plus size={18} />
		</button>
	</div>

	{#if showHistory}
		<div class="history-overlay" onclick={() => { showHistory = false; pendingDeleteId = null; }} role="presentation">
			<div class="history-panel" onclick={(e) => e.stopPropagation()} role="presentation">
				<div class="history-head">
					<h3>Past conversations</h3>
					<button class="header-btn" onclick={() => { showHistory = false; pendingDeleteId = null; }} aria-label="Close">×</button>
				</div>
				{#if loadingList}
					<div class="history-empty">Loading…</div>
				{:else if conversationList.length === 0}
					<div class="history-empty">No past conversations yet.</div>
				{:else}
					<div class="history-list">
						{#each conversationList as c}
							<div
								class="history-item {conversationId === c.id ? 'active' : ''} {pendingDeleteId === c.id ? 'deleting' : ''}"
								role="button"
								tabindex="0"
								onclick={() => pendingDeleteId !== c.id && loadConversation(c.id)}
								onkeydown={(e) => (e.key === 'Enter' || e.key === ' ') && pendingDeleteId !== c.id && loadConversation(c.id)}
							>
								<div class="history-item-text">
									<div class="history-title">{c.title || 'Untitled'}</div>
									<div class="history-time">{fmtTimestamp(c.updated_at)}</div>
								</div>
								{#if pendingDeleteId === c.id}
									<div class="history-confirm">
										<button class="confirm-yes" onclick={(e) => confirmDelete(c.id, e)} aria-label="Confirm delete">
											Delete
										</button>
										<button class="confirm-no" onclick={cancelDelete} aria-label="Cancel">
											Cancel
										</button>
									</div>
								{:else}
									<button class="history-delete" onclick={(e) => requestDelete(c.id, e)} aria-label="Delete">
										<Trash2 size={14} />
									</button>
								{/if}
							</div>
						{/each}
					</div>
				{/if}
			</div>
		</div>
	{/if}

	<div class="chat-scroll" bind:this={scrollEl} onscroll={onScroll}>
		{#if messages.length === 0}
			<div class="intro">
				<Sparkles size={20} />
				<h2>Ask about your meals</h2>
				<p>Get nutrition feedback, trends, and ideas grounded in what you actually ate today.</p>
				<div class="intro-examples">
					<span>"What should I eat for lunch?"</span>
					<span>"Am I eating too much junk this week?"</span>
					<span>"Why do I feel sluggish at 3pm?"</span>
				</div>
			</div>
		{/if}

		{#each messages as m, i (i)}
			{#if m.role === 'user'}
				<div class="bubble-row user">
					<div class="bubble user-bubble">{m.content}</div>
				</div>
			{:else}
				<div class="bubble-row assistant">
					<div class="assistant-col">
						{#if m.reasoning}
							<button
								class="thinking-header"
								onclick={() => (m.reasoningOpen = !m.reasoningOpen)}
							>
								<ChevronRight size={14} class={m.reasoningOpen ? 'chev open' : 'chev'} />
								<span>{thinkingLabel(m)}</span>
							</button>
							<div class="thinking-body" class:open={m.reasoningOpen}>
								<div class="thinking-text markdown">{@html renderMd(m.reasoning)}</div>
							</div>
						{/if}

						{#if m.toolEvents && m.toolEvents.length > 0}
							<div class="tool-pills">
								{#each m.toolEvents as te}
									<div class="tool-pill {te.state}">
										{#if te.state === 'running'}
											<div class="dots"><span></span><span></span><span></span></div>
											<Search size={12} />
											<span>{TOOL_LABELS[te.name] || te.name}…</span>
										{:else}
											<Check size={12} />
											<span>{TOOL_LABELS[te.name] || te.name}</span>
										{/if}
									</div>
								{/each}
							</div>
						{/if}

						{#if m.content}
							<div class="bubble assistant-bubble markdown">{@html renderMd(m.content)}</div>
						{:else if streaming && i === messages.length - 1}
							<div class="bubble assistant-bubble typing">
								<span class="dot"></span><span class="dot"></span><span class="dot"></span>
							</div>
						{/if}
					</div>
				</div>
			{/if}
		{/each}
	</div>

	{#if !isAtBottom}
		<button class="jump-bottom" onclick={jumpToBottom} aria-label="Jump to latest">
			<ArrowDown size={14} />
			<span>{streaming ? 'New messages' : 'Latest'}</span>
		</button>
	{/if}

	<div class="chat-input-bar">
		<textarea
			bind:this={textarea}
			bind:value={input}
			onkeydown={onKey}
			oninput={autosize}
			placeholder="Ask about your meals…"
			rows="1"
			disabled={streaming}
		></textarea>
		<button class="send-btn" onclick={send} disabled={streaming || !input.trim()} aria-label="Send">
			<Send size={18} />
		</button>
	</div>
</div>

<style>
	/* The absolute minimum: a flex column anchored to the visible viewport.
	   No JS positioning, no body scroll lock, no position:fixed. */
	.chat-view {
		display: flex;
		flex-direction: column;
		height: calc(100dvh - 200px); /* leaves room for header + tab-bar above */
		min-height: 320px;
		position: relative;
	}

	.chat-header {
		display: flex;
		justify-content: flex-end;
		gap: 2px;
		padding: 0;
		margin: -12px 0 0;
	}

	.header-btn {
		background: transparent;
		border: 1px solid transparent;
		color: #888;
		width: 28px;
		height: 28px;
		display: inline-flex;
		align-items: center;
		justify-content: center;
		border-radius: 6px;
		cursor: pointer;
		transition: all 0.15s;
		font-size: 1.1rem;
		line-height: 1;
	}
	.header-btn:hover:not(:disabled) {
		background: #1a1a1a;
		color: #ddd;
	}
	.header-btn:disabled {
		opacity: 0.4;
		cursor: not-allowed;
	}

	.history-overlay {
		position: absolute;
		inset: 0;
		background: rgba(0, 0, 0, 0.6);
		z-index: 50;
		display: flex;
		align-items: flex-start;
		justify-content: center;
		padding-top: 30px;
		animation: fadeIn 0.15s ease-out;
	}

	.history-panel {
		width: 92%;
		max-width: 480px;
		max-height: calc(100% - 60px);
		background: #0f0f0f;
		border: 1px solid #2a2a2a;
		border-radius: 12px;
		overflow: hidden;
		display: flex;
		flex-direction: column;
		box-shadow: 0 16px 40px rgba(0, 0, 0, 0.6);
	}

	.history-head {
		display: flex;
		justify-content: space-between;
		align-items: center;
		padding: 12px 16px;
		border-bottom: 1px solid #1f1f1f;
	}
	.history-head h3 {
		font-size: 0.9rem;
		font-weight: 600;
		color: #eee;
		margin: 0;
		letter-spacing: 0.3px;
	}

	.history-empty {
		padding: 32px 16px;
		text-align: center;
		color: #666;
		font-size: 0.85rem;
	}

	.history-list {
		overflow-y: auto;
		flex: 1;
	}

	.history-item {
		width: 100%;
		display: flex;
		align-items: center;
		gap: 8px;
		padding: 10px 14px;
		background: transparent;
		border: none;
		border-bottom: 1px solid #181818;
		color: #ddd;
		text-align: left;
		cursor: pointer;
		transition: background 0.15s;
	}
	.history-item:hover { background: #161616; }
	.history-item.active { background: #1a1a1a; }
	.history-item-text {
		flex: 1;
		min-width: 0;
	}
	.history-title {
		font-size: 0.88rem;
		color: #eee;
		font-weight: 500;
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}
	.history-time {
		font-size: 0.7rem;
		color: #666;
		margin-top: 2px;
	}
	.history-delete {
		background: transparent;
		border: none;
		color: #555;
		padding: 6px;
		border-radius: 4px;
		cursor: pointer;
		display: flex;
		align-items: center;
		transition: color 0.15s;
	}
	.history-delete:hover { color: #ff5555; }

	.history-item.deleting { background: #2a1414; }

	.history-confirm {
		display: flex;
		gap: 6px;
		align-items: center;
	}
	.history-confirm button {
		font-size: 0.7rem;
		font-weight: 600;
		padding: 4px 10px;
		border-radius: 6px;
		cursor: pointer;
		letter-spacing: 0.3px;
		border: 1px solid;
	}
	.confirm-yes {
		background: #ef4444;
		border-color: #ef4444;
		color: #fff;
	}
	.confirm-yes:hover { background: #dc2626; }
	.confirm-no {
		background: transparent;
		border-color: #444;
		color: #aaa;
	}
	.confirm-no:hover { background: #1a1a1a; color: #eee; }

	@keyframes fadeIn {
		from { opacity: 0; }
		to { opacity: 1; }
	}

	.jump-bottom {
		position: absolute;
		bottom: 78px;
		left: 50%;
		transform: translateX(-50%);
		display: inline-flex;
		align-items: center;
		gap: 6px;
		background: #1f1f1f;
		border: 1px solid #333;
		color: #ddd;
		padding: 6px 12px;
		border-radius: 999px;
		font-size: 0.75rem;
		font-weight: 500;
		cursor: pointer;
		box-shadow: 0 4px 12px rgba(0, 0, 0, 0.4);
		animation: fadeUp 0.15s ease-out;
		z-index: 5;
	}
	.jump-bottom:hover {
		background: #2a2a2a;
		border-color: #444;
	}
	@keyframes fadeUp {
		from { opacity: 0; transform: translate(-50%, 6px); }
		to { opacity: 1; transform: translate(-50%, 0); }
	}

	.chat-scroll {
		flex: 1;
		min-height: 0; /* critical for flex children with overflow */
		overflow-y: auto;
		padding: 16px 4px 8px;
		-webkit-overflow-scrolling: touch;
	}

	.chat-input-bar {
		display: flex;
		gap: 8px;
		align-items: flex-end;
		padding: 10px 4px max(10px, env(safe-area-inset-bottom));
		border-top: 1px solid #1a1a1a;
		background: #000;
		flex-shrink: 0;
	}

	textarea {
		flex: 1;
		background: #0e0e0e;
		border: 1px solid #232323;
		border-radius: 18px;
		padding: 12px 16px;
		color: #eee;
		font-size: 0.92rem;
		font-family: inherit;
		resize: none;
		line-height: 1.4;
		max-height: 140px;
		outline: none;
		transition: border-color 0.2s;
	}
	textarea:focus {
		border-color: #3a3a3a;
	}
	textarea:disabled {
		opacity: 0.6;
	}

	.send-btn {
		background: #fff;
		color: #000;
		border: none;
		border-radius: 50%;
		width: 44px;
		height: 44px;
		display: flex;
		align-items: center;
		justify-content: center;
		cursor: pointer;
		transition: opacity 0.2s, transform 0.1s;
		flex-shrink: 0;
	}
	.send-btn:hover {
		opacity: 0.85;
	}
	.send-btn:active {
		transform: scale(0.95);
	}
	.send-btn:disabled {
		background: #2a2a2a;
		color: #555;
		cursor: not-allowed;
	}

	.intro {
		text-align: center;
		padding: 60px 20px;
		color: #888;
	}
	.intro :global(svg) {
		color: #4ade80;
		margin-bottom: 12px;
	}
	.intro h2 {
		font-size: 1.1rem;
		font-weight: 600;
		letter-spacing: 0.5px;
		color: #eee;
		margin: 0 0 8px;
	}
	.intro p {
		font-size: 0.85rem;
		margin: 0 0 24px;
		line-height: 1.5;
	}
	.intro-examples {
		display: flex;
		flex-direction: column;
		gap: 8px;
		align-items: center;
	}
	.intro-examples span {
		font-size: 0.78rem;
		color: #666;
		font-style: italic;
		padding: 6px 12px;
		background: #131313;
		border: 1px solid #1f1f1f;
		border-radius: 16px;
	}

	.bubble-row {
		display: flex;
		margin: 10px 0;
		width: 100%;
	}
	.bubble-row.user {
		justify-content: flex-end;
	}
	.bubble-row.assistant {
		justify-content: flex-start;
	}
	.assistant-col {
		display: flex;
		flex-direction: column;
		gap: 6px;
		max-width: 88%;
	}
	.bubble {
		padding: 10px 14px;
		border-radius: 18px;
		font-size: 0.92rem;
		line-height: 1.45;
		white-space: pre-wrap;
		word-wrap: break-word;
	}
	.user-bubble {
		background: #2a2a2a;
		color: #fff;
		border-bottom-right-radius: 4px;
		max-width: 88%;
	}
	.assistant-bubble {
		background: #131313;
		border: 1px solid #1f1f1f;
		color: #eaeaea;
		border-bottom-left-radius: 4px;
	}
	.assistant-bubble.markdown {
		white-space: normal;
	}

	.markdown :global(p) { margin: 0 0 0.4em; }
	.markdown :global(p:last-child) { margin-bottom: 0; }
	.markdown :global(ul), .markdown :global(ol) { margin: 0.3em 0; padding-left: 1.4em; }
	.markdown :global(ul:last-child), .markdown :global(ol:last-child) { margin-bottom: 0; }
	.markdown :global(li) { margin: 0.1em 0; line-height: 1.5; }
	.markdown :global(li > p) { margin: 0; }
	.markdown :global(strong) { font-weight: 700; color: #fff; }
	.markdown :global(em) { font-style: italic; color: #ddd; }
	.markdown :global(h1), .markdown :global(h2), .markdown :global(h3) {
		font-size: 1rem; font-weight: 700; margin: 0.6em 0 0.3em; color: #fff;
	}
	.markdown :global(code) {
		background: #0a0a0a; border: 1px solid #222; padding: 1px 5px;
		border-radius: 4px; font-size: 0.85em;
		font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
	}
	.markdown :global(pre) {
		background: #0a0a0a; border: 1px solid #222; padding: 10px 12px;
		border-radius: 8px; overflow-x: auto; margin: 0.5em 0;
	}
	.markdown :global(pre code) { background: transparent; border: none; padding: 0; }
	.markdown :global(blockquote) {
		border-left: 3px solid #2a2a2a; padding-left: 12px; margin: 0.5em 0;
		color: #aaa; font-style: italic;
	}
	.markdown :global(a) { color: #7dd3fc; text-decoration: underline; }
	.markdown :global(hr) { border: none; border-top: 1px solid #2a2a2a; margin: 0.8em 0; }
	.markdown :global(table) { border-collapse: collapse; margin: 0.5em 0; font-size: 0.85em; }
	.markdown :global(th), .markdown :global(td) {
		border: 1px solid #2a2a2a; padding: 6px 10px; text-align: left;
	}
	.markdown :global(th) { background: #181818; font-weight: 600; }

	.assistant-bubble.typing {
		display: inline-flex;
		gap: 4px;
		align-items: center;
		padding: 14px 18px;
	}
	.typing .dot {
		width: 6px; height: 6px; border-radius: 50%; background: #555;
		animation: blink 1.2s infinite;
	}
	.typing .dot:nth-child(2) { animation-delay: 0.15s; }
	.typing .dot:nth-child(3) { animation-delay: 0.3s; }
	@keyframes blink {
		0%, 80%, 100% { opacity: 0.3; }
		40% { opacity: 1; }
	}

	.thinking-header {
		display: inline-flex; align-items: center; gap: 6px;
		background: transparent; border: none; color: #777;
		font-size: 0.72rem; letter-spacing: 0.5px; cursor: pointer;
		padding: 2px 0; text-transform: uppercase; font-weight: 600; text-align: left;
	}
	.thinking-header :global(.chev) { transition: transform 0.18s ease; }
	.thinking-header :global(.chev.open) { transform: rotate(90deg); }
	.thinking-header:hover { color: #aaa; }
	.thinking-body {
		max-height: 0; overflow: hidden; opacity: 0;
		transition: max-height 0.22s ease, opacity 0.22s ease;
	}
	.thinking-body.open { max-height: 320px; opacity: 1; overflow-y: auto; }
	.thinking-text {
		font-size: 0.78rem; color: #888; line-height: 1.55;
		padding: 8px 12px; border-left: 2px solid #2a2a2a; background: #0c0c0c;
		border-radius: 0 6px 6px 0;
	}
	.thinking-text :global(p) { margin: 0 0 0.4em; }
	.thinking-text :global(p:last-child) { margin-bottom: 0; }
	.thinking-text :global(strong) { color: #ccc; font-weight: 600; }
	.thinking-text :global(em) { font-style: italic; color: #999; }
	.thinking-text :global(ul), .thinking-text :global(ol) { margin: 0.3em 0; padding-left: 1.2em; }
	.thinking-text :global(li) { margin: 0.1em 0; }

	.tool-pills { display: flex; flex-wrap: wrap; gap: 6px; }
	.tool-pill {
		display: inline-flex; align-items: center; gap: 6px;
		font-size: 0.72rem; font-weight: 500; padding: 5px 10px;
		border-radius: 14px; background: #131313; border: 1px solid #222; color: #aaa;
	}
	.tool-pill.running {
		border-color: #2a3a4a; color: #b8d0e8; background: #0e151c;
	}
	.tool-pill.done {
		color: #6f8a72; border-color: #1c2a1f; background: #0d130f;
	}
	.dots { display: inline-flex; gap: 2px; }
	.dots span {
		width: 4px; height: 4px; border-radius: 50%; background: currentColor;
		animation: blink 1s infinite;
	}
	.dots span:nth-child(2) { animation-delay: 0.15s; }
	.dots span:nth-child(3) { animation-delay: 0.3s; }
</style>
