<script>
	import LoadingSkeleton from './LoadingSkeleton.svelte';
	import { Trash2, MessageSquare, Clock, Send } from 'lucide-svelte';
	import { toast } from '$lib/toast.svelte.js';
	import { fetchWithRetry } from '$lib/net.js';

	let { historyGroups, historyLoading, proteinFocused, onDeleteEntry, onEntryUpdated } = $props();

	let expandedId = $state(null);
	let editingChatId = $state(null);
	let editingTimeId = $state(null);

	let chatInput = $state('');
	let chatMessages = $state([]);
	let chatLoading = $state(false);
	let chatItemsSnapshot = $state(null);
	let chatTitleSnapshot = $state(null);

	function formatTime(ts) {
		const d = new Date(ts);
		const h = d.getHours();
		const m = String(d.getMinutes()).padStart(2, '0');
		const period = h >= 12 ? 'pm' : 'am';
		return `${h % 12 || 12}:${m}${period}`;
	}

	function shortDay(name) {
		return name.slice(0, 3).toUpperCase();
	}

	function parseItems(items) {
		if (!items) return [];
		return typeof items === 'string' ? JSON.parse(items) : items;
	}

	async function deleteMeal(id, e) {
		e?.stopPropagation();
		if (confirm('DELETE THIS ENTRY?')) {
			await onDeleteEntry(id);
			if (expandedId === id) expandedId = null;
		}
	}

	function toggleExpand(id) {
		const next = expandedId === id ? null : id;
		expandedId = next;
		// Close any open sub-panels when collapsing
		if (next !== editingChatId) closeChat();
		if (next !== editingTimeId) editingTimeId = null;
	}

	function openChat(entry) {
		editingChatId = entry.id;
		editingTimeId = null;
		chatInput = '';
		chatMessages = [];
		chatItemsSnapshot = parseItems(entry.items);
		chatTitleSnapshot = entry.meal_title;
	}

	function closeChat() {
		editingChatId = null;
		chatInput = '';
		chatMessages = [];
		chatItemsSnapshot = null;
		chatTitleSnapshot = null;
	}

	function openTime(entry) {
		editingTimeId = entry.id;
		editingChatId = null;
		closeChat();
	}

	async function sendChat(entryId) {
		const message = chatInput.trim();
		if (!message || chatLoading) return;
		chatInput = '';
		chatMessages = [...chatMessages, { role: 'user', content: message }];
		chatLoading = true;

		try {
			const res = await fetchWithRetry('/api/followup', {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({
					entryId,
					message,
					currentItems: chatItemsSnapshot,
					currentMealTitle: chatTitleSnapshot
				})
			});
			const data = await res.json();

			if (data.updatedEntry) {
				chatItemsSnapshot = data.updatedEntry.items || chatItemsSnapshot;
				chatTitleSnapshot = data.updatedEntry.meal_title || chatTitleSnapshot;
			}
			if (data.content) {
				chatMessages = [...chatMessages, { role: 'assistant', content: data.content }];
			}

			if (data.updatedEntry) {
				await onEntryUpdated?.();
			}
		} catch (e) {
			console.error(e);
			chatMessages = [...chatMessages, { role: 'assistant', content: 'Something went wrong.' }];
		} finally {
			chatLoading = false;
		}
	}

	function setMealPeriod(entry, period) {
		// Keep the same date, swap the hour
		const periodHours = { breakfast: 8, lunch: 13, dinner: 19, snack: 22 };
		const targetHour = periodHours[period];
		if (targetHour === undefined) return;

		const datePart = entry.timestamp.split('T')[0];
		const newTs = `${datePart}T${String(targetHour).padStart(2, '0')}:00:00`;
		updateTimestamp(entry.id, newTs);
	}

	function setCustomTime(entry, value) {
		if (!value) return;
		// value is "YYYY-MM-DDTHH:mm" — append seconds
		const newTs = value.length === 16 ? `${value}:00` : value;
		updateTimestamp(entry.id, newTs);
	}

	async function updateTimestamp(entryId, newTimestamp) {
		try {
			const res = await fetchWithRetry(`/api/entry/${entryId}`, {
				method: 'PATCH',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ timestamp: newTimestamp })
			});
			if (!res.ok) throw new Error('Failed');
			editingTimeId = null;
			expandedId = null;
			await onEntryUpdated?.();
		} catch (e) {
			console.error(e);
			toast('Could not update time.', { kind: 'error' });
		}
	}

	function getCurrentPeriod(entry) {
		const h = new Date(entry.timestamp).getHours();
		if (h >= 5 && h < 11) return 'breakfast';
		if (h >= 11 && h < 16) return 'lunch';
		if (h >= 16 && h < 22) return 'dinner';
		return 'snack';
	}

	function datetimeLocalValue(ts) {
		// Convert "YYYY-MM-DDTHH:MM:SS" → "YYYY-MM-DDTHH:MM"
		return ts ? ts.slice(0, 16) : '';
	}
</script>

<div id="historyView">
	{#if historyLoading}
		<div class="loading-state">
			<LoadingSkeleton width="100%" height="40px" />
			<LoadingSkeleton width="100%" height="200px" />
			<LoadingSkeleton width="100%" height="200px" />
		</div>
	{:else if historyGroups.length === 0}
		<div class="empty-state">
			<p>NO HISTORY YET</p>
			<span>START TRACKING MEALS</span>
		</div>
	{:else}
		<div class="history-list">
			{#each historyGroups as group (group.date)}
				<section class="day">
					<header class="day-header">
						<div class="day-label">
							<span class="day-name">{shortDay(group.dayName)}</span>
							<span class="day-date">{group.monthDay}</span>
						</div>
						<div class="day-totals">
							{#if !proteinFocused}
								<div class="day-stat">
									<span class="day-stat-value">{Math.round(group.totalCalories)}</span>
									<span class="day-stat-unit">cal</span>
								</div>
							{/if}
							<div class="day-stat protein">
								<span class="day-stat-value">{Math.round(group.totalProtein)}g</span>
								<span class="day-stat-unit">prot</span>
							</div>
						</div>
					</header>

					<div class="rail">
						{#each group.entries as entry (entry.id)}
							<button
								class="meal-row"
								class:expanded={expandedId === entry.id}
								onclick={() => toggleExpand(entry.id)}
							>
								<span class="dot"></span>
								<span class="time">{formatTime(entry.timestamp)}</span>
								<span class="title">{entry.meal_title || 'Meal'}</span>
								<span class="macros">
									{#if !proteinFocused}
										<span class="cal">{Math.round(entry.total_calories)}</span>
									{/if}
									<span class="prot">{Math.round(entry.total_protein)}g</span>
								</span>
							</button>

							{#if expandedId === entry.id}
								{@const items = chatItemsSnapshot && editingChatId === entry.id
									? chatItemsSnapshot
									: parseItems(entry.items)}
								<div class="meal-detail">
									<div class="items">
										{#each items as item}
											<div class="item">
												<span class="item-name">{item.name}</span>
												<span class="item-macros">
													{#if !proteinFocused}
														<span>{Math.round(item.calories)}</span>
													{/if}
													<span class="prot">{Math.round(item.protein)}g</span>
												</span>
											</div>
										{/each}
									</div>

									<div class="action-row">
										<button
											class="mini-btn"
											class:active={editingChatId === entry.id}
											onclick={(e) => {
												e.stopPropagation();
												if (editingChatId === entry.id) {
													closeChat();
												} else {
													openChat(entry);
												}
											}}
										>
											<MessageSquare size={13} />
											EDIT
										</button>
										<button
											class="mini-btn"
											class:active={editingTimeId === entry.id}
											onclick={(e) => {
												e.stopPropagation();
												if (editingTimeId === entry.id) {
													editingTimeId = null;
												} else {
													openTime(entry);
												}
											}}
										>
											<Clock size={13} />
											CHANGE TIME
										</button>
										<button class="mini-btn danger" onclick={(e) => deleteMeal(entry.id, e)}>
											<Trash2 size={13} />
											DELETE
										</button>
									</div>

									{#if editingTimeId === entry.id}
										{@const currentPeriod = getCurrentPeriod(entry)}
										<div class="time-panel" onclick={(e) => e.stopPropagation()}>
											<div class="period-chips">
												<button
													class="chip"
													class:active={currentPeriod === 'breakfast'}
													onclick={() => setMealPeriod(entry, 'breakfast')}
												>
													Breakfast<span class="chip-time">8:00am</span>
												</button>
												<button
													class="chip"
													class:active={currentPeriod === 'lunch'}
													onclick={() => setMealPeriod(entry, 'lunch')}
												>
													Lunch<span class="chip-time">1:00pm</span>
												</button>
												<button
													class="chip"
													class:active={currentPeriod === 'dinner'}
													onclick={() => setMealPeriod(entry, 'dinner')}
												>
													Dinner<span class="chip-time">7:00pm</span>
												</button>
												<button
													class="chip"
													class:active={currentPeriod === 'snack'}
													onclick={() => setMealPeriod(entry, 'snack')}
												>
													Snack<span class="chip-time">10:00pm</span>
												</button>
											</div>
											<label class="custom-time">
												<span>Custom</span>
												<input
													type="datetime-local"
													value={datetimeLocalValue(entry.timestamp)}
													onchange={(e) => setCustomTime(entry, e.currentTarget.value)}
												/>
											</label>
										</div>
									{/if}

									{#if editingChatId === entry.id}
										<div class="chat-panel" onclick={(e) => e.stopPropagation()}>
											{#if chatMessages.length > 0}
												<div class="chat-thread">
													{#each chatMessages as msg}
														<div class="chat-msg {msg.role}">
															<div class="chat-bubble">{msg.content}</div>
														</div>
													{/each}
													{#if chatLoading}
														<div class="chat-msg assistant">
															<div class="chat-bubble typing">
																<span></span><span></span><span></span>
															</div>
														</div>
													{/if}
												</div>
											{/if}
											<div class="chat-input-row">
												<input
													type="text"
													class="chat-input"
													placeholder="e.g. add a side of rice, swap chicken for tofu..."
													bind:value={chatInput}
													disabled={chatLoading}
													onkeydown={(e) => {
														if (e.key === 'Enter') {
															e.preventDefault();
															sendChat(entry.id);
														}
													}}
													onclick={(e) => e.stopPropagation()}
												/>
												<button
													class="chat-send"
													disabled={chatLoading || !chatInput.trim()}
													onclick={() => sendChat(entry.id)}
												>
													<Send size={14} />
												</button>
											</div>
										</div>
									{/if}
								</div>
							{/if}
						{/each}
					</div>
				</section>
			{/each}
		</div>
	{/if}
</div>

<style>
	.loading-state {
		display: flex;
		flex-direction: column;
		gap: 1.5rem;
	}

	.empty-state {
		display: flex;
		flex-direction: column;
		align-items: center;
		justify-content: center;
		padding: 6rem 2rem;
		gap: 0.75rem;
	}

	.empty-state p {
		font-size: 1.5rem;
		font-weight: 700;
		letter-spacing: 0.1em;
		color: #fff;
		margin: 0;
	}

	.empty-state span {
		font-size: 0.75rem;
		font-weight: 600;
		letter-spacing: 0.15em;
		color: #666;
	}

	.history-list {
		display: flex;
		flex-direction: column;
		gap: 2.5rem;
	}

	.day-header {
		display: flex;
		justify-content: space-between;
		align-items: baseline;
		padding-bottom: 0.5rem;
		border-bottom: 1px solid #1c1c1c;
		margin-bottom: 0.25rem;
	}

	.day-label {
		display: flex;
		align-items: baseline;
		gap: 0.6rem;
	}

	.day-name {
		font-size: 1.05rem;
		font-weight: 700;
		color: #fff;
		letter-spacing: 0.12em;
	}

	.day-date {
		font-size: 0.7rem;
		color: #666;
		letter-spacing: 0.1em;
		text-transform: uppercase;
		font-weight: 600;
	}

	.day-totals {
		display: flex;
		gap: 1rem;
		align-items: baseline;
	}

	.day-stat {
		display: inline-flex;
		align-items: baseline;
		gap: 0.25rem;
	}

	.day-stat-value {
		font-size: 0.95rem;
		font-weight: 700;
		color: #fff;
	}

	.day-stat.protein .day-stat-value {
		color: #4ade80;
	}

	.day-stat-unit {
		font-size: 0.6rem;
		font-weight: 700;
		color: #555;
		letter-spacing: 0.1em;
		text-transform: uppercase;
	}

	.rail {
		position: relative;
		padding: 0.5rem 0 0.25rem 0;
	}

	.rail::before {
		content: '';
		position: absolute;
		left: 7px;
		top: 1.2rem;
		bottom: 1.2rem;
		width: 1px;
		background: #1f1f1f;
	}

	.meal-row {
		position: relative;
		width: 100%;
		display: grid;
		grid-template-columns: 16px auto 1fr auto;
		gap: 0.6rem;
		align-items: start;
		padding: 0.65rem 0.5rem 0.65rem 0;
		background: transparent;
		border: none;
		color: #fff;
		text-align: left;
		cursor: pointer;
		border-radius: 4px;
		transition: background 0.15s ease;
		font-family: inherit;
	}

	.meal-row:hover,
	.meal-row.expanded {
		background: #0d0d0d;
	}

	.dot {
		width: 9px;
		height: 9px;
		border-radius: 50%;
		background: #fff;
		box-shadow: 0 0 0 3px #000;
		justify-self: start;
		margin-left: 3px;
		margin-top: 0.45rem;
		transition: background 0.15s;
	}

	.meal-row:hover .dot,
	.meal-row.expanded .dot {
		background: #4ade80;
	}

	.time {
		font-size: 0.7rem;
		color: #666;
		font-weight: 600;
		letter-spacing: 0.05em;
		font-variant-numeric: tabular-nums;
		min-width: 3.5rem;
		padding-top: 0.2rem;
	}

	.title {
		font-size: 0.95rem;
		color: #eee;
		font-weight: 500;
		min-width: 0;
		line-height: 1.3;
		word-break: break-word;
	}

	.macros {
		display: inline-flex;
		gap: 0.6rem;
		align-items: baseline;
		font-variant-numeric: tabular-nums;
	}

	.cal {
		font-size: 0.85rem;
		font-weight: 600;
		color: #aaa;
	}

	.prot {
		font-size: 0.85rem;
		font-weight: 600;
		color: #4ade80;
	}

	.meal-detail {
		margin: 0 0 0.5rem 24px;
		padding: 0.75rem 0.9rem;
		background: #060606;
		border-left: 1px solid #1f1f1f;
		display: flex;
		flex-direction: column;
		gap: 0.5rem;
		animation: slideDown 0.18s ease-out;
	}

	@keyframes slideDown {
		from {
			opacity: 0;
			transform: translateY(-4px);
		}
		to {
			opacity: 1;
			transform: translateY(0);
		}
	}

	.items {
		display: flex;
		flex-direction: column;
	}

	.item {
		display: flex;
		justify-content: space-between;
		align-items: baseline;
		gap: 1rem;
		padding: 0.25rem 0;
	}

	.item-name {
		font-size: 0.8rem;
		color: #bbb;
		flex: 1;
		min-width: 0;
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}

	.item-macros {
		display: inline-flex;
		gap: 0.6rem;
		font-size: 0.75rem;
		color: #777;
		font-weight: 600;
		font-variant-numeric: tabular-nums;
	}

	.item-macros .prot {
		font-size: 0.75rem;
	}

	.action-row {
		display: flex;
		gap: 0.4rem;
		margin-top: 0.6rem;
		flex-wrap: wrap;
	}

	.mini-btn {
		display: inline-flex;
		align-items: center;
		gap: 0.3rem;
		background: transparent;
		border: 1px solid #2a2a2a;
		color: #aaa;
		padding: 0.35rem 0.65rem;
		border-radius: 4px;
		font-size: 0.62rem;
		font-weight: 700;
		letter-spacing: 0.08em;
		cursor: pointer;
		transition: all 0.15s;
	}

	.mini-btn:hover {
		background: #111;
		color: #fff;
		border-color: #3a3a3a;
	}

	.mini-btn.active {
		background: #111;
		color: #4ade80;
		border-color: #4ade80;
	}

	.mini-btn.danger {
		border-color: #2a1414;
		color: #ff5252;
	}

	.mini-btn.danger:hover {
		background: #ff4444;
		color: #000;
		border-color: #ff4444;
	}

	.time-panel {
		margin-top: 0.4rem;
		padding: 0.6rem;
		background: #0a0a0a;
		border: 1px solid #1c1c1c;
		border-radius: 6px;
		display: flex;
		flex-direction: column;
		gap: 0.6rem;
	}

	.period-chips {
		display: grid;
		grid-template-columns: 1fr 1fr;
		gap: 0.4rem;
	}

	.chip {
		display: flex;
		flex-direction: column;
		align-items: flex-start;
		gap: 0.15rem;
		background: transparent;
		border: 1px solid #222;
		color: #ddd;
		padding: 0.5rem 0.7rem;
		border-radius: 4px;
		font-size: 0.8rem;
		font-weight: 500;
		cursor: pointer;
		transition: all 0.15s;
		text-align: left;
	}

	.chip:hover {
		background: #111;
		border-color: #333;
	}

	.chip.active {
		border-color: #4ade80;
		color: #4ade80;
	}

	.chip-time {
		font-size: 0.65rem;
		color: #666;
		font-weight: 600;
		letter-spacing: 0.05em;
	}

	.chip.active .chip-time {
		color: #4ade80;
		opacity: 0.7;
	}

	.custom-time {
		display: flex;
		align-items: center;
		gap: 0.6rem;
		font-size: 0.7rem;
		color: #888;
		letter-spacing: 0.1em;
		text-transform: uppercase;
		font-weight: 600;
	}

	.custom-time input {
		flex: 1;
		background: #0a0a0a;
		border: 1px solid #222;
		color: #eee;
		padding: 0.4rem 0.5rem;
		border-radius: 4px;
		font-size: 0.8rem;
		font-family: inherit;
	}

	.custom-time input:focus {
		outline: none;
		border-color: #4ade80;
	}

	.chat-panel {
		margin-top: 0.4rem;
		padding: 0.6rem;
		background: #0a0a0a;
		border: 1px solid #1c1c1c;
		border-radius: 6px;
		display: flex;
		flex-direction: column;
		gap: 0.5rem;
	}

	.chat-thread {
		display: flex;
		flex-direction: column;
		gap: 0.4rem;
		max-height: 220px;
		overflow-y: auto;
		padding-right: 2px;
	}

	.chat-msg {
		display: flex;
		animation: slideDown 0.15s ease-out;
	}

	.chat-msg.user {
		justify-content: flex-end;
	}

	.chat-msg.assistant {
		justify-content: flex-start;
	}

	.chat-bubble {
		max-width: 85%;
		padding: 0.5rem 0.7rem;
		border-radius: 10px;
		font-size: 0.8rem;
		line-height: 1.35;
		white-space: pre-wrap;
		word-wrap: break-word;
	}

	.chat-msg.user .chat-bubble {
		background: #fff;
		color: #000;
		border-bottom-right-radius: 3px;
	}

	.chat-msg.assistant .chat-bubble {
		background: #161616;
		color: #eee;
		border: 1px solid #232323;
		border-bottom-left-radius: 3px;
	}

	.chat-bubble.typing {
		display: inline-flex;
		gap: 4px;
		align-items: center;
		padding: 0.6rem 0.7rem;
	}

	.chat-bubble.typing span {
		width: 5px;
		height: 5px;
		background: #888;
		border-radius: 50%;
		animation: typing 1.2s infinite ease-in-out;
	}

	.chat-bubble.typing span:nth-child(2) {
		animation-delay: 0.15s;
	}

	.chat-bubble.typing span:nth-child(3) {
		animation-delay: 0.3s;
	}

	@keyframes typing {
		0%,
		60%,
		100% {
			opacity: 0.3;
			transform: translateY(0);
		}
		30% {
			opacity: 1;
			transform: translateY(-3px);
		}
	}

	.chat-input-row {
		display: flex;
		gap: 0.4rem;
		align-items: center;
	}

	.chat-input {
		flex: 1;
		background: #050505;
		border: 1px solid #222;
		color: #fff;
		padding: 0.5rem 0.7rem;
		border-radius: 4px;
		font-size: 0.8rem;
		font-family: inherit;
		min-width: 0;
	}

	.chat-input:focus {
		outline: none;
		border-color: #444;
	}

	.chat-input:disabled {
		opacity: 0.5;
	}

	.chat-send {
		background: #fff;
		color: #000;
		border: none;
		padding: 0.5rem 0.65rem;
		border-radius: 4px;
		cursor: pointer;
		display: inline-flex;
		align-items: center;
		justify-content: center;
		transition: opacity 0.15s;
	}

	.chat-send:disabled {
		opacity: 0.4;
		cursor: not-allowed;
	}
</style>
