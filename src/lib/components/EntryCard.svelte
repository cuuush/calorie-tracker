<script>
	let { entry, onDelete, proteinFocused = false } = $props();
	let expanded = $state(false);


	function formatTime(timestamp) {
		const date = new Date(timestamp);
		const hours = date.getHours();
		const minutes = date.getMinutes().toString().padStart(2, '0');
		const period = hours >= 12 ? 'PM' : 'AM';
		const displayHours = hours % 12 || 12;

		return `${displayHours}:${minutes} ${period}`;
	}

	const time = formatTime(entry.timestamp);

	async function handleDelete() {
		if (confirm('DELETE THIS ENTRY?')) {
			await onDelete(entry.id);
		}
	}
</script>

<div class="entry-card">
	<div class="entry-main">
		<div class="entry-left">
			<div class="entry-time">{time}</div>
			<h4>{entry.meal_title || 'MEAL'}</h4>
		</div>
		<div class="entry-right">
			<div class="macros">
				{#if !proteinFocused}
					<div class="macro-item">
						<div class="macro-value">{Math.round(entry.total_calories)}</div>
					</div>
				{/if}
				<div class="macro-item protein">
					<div class="macro-value">{Math.round(entry.total_protein)}g</div>
				</div>
			</div>
		</div>
	</div>

	{#if entry.items}
		<div class="entry-actions">
			<button class="action-btn" onclick={() => (expanded = !expanded)}>
				{expanded ? 'HIDE' : 'DETAILS'}
			</button>
		</div>

		{#if expanded}
			{@const items = typeof entry.items === 'string' ? JSON.parse(entry.items) : entry.items}
			<div class="items-breakdown card-element" style="animation-delay: 0s;">
				{#each items as item}
					<div class="breakdown-item">
						<span class="item-name">{item.name}</span>
						<div class="item-stats">
							{#if !proteinFocused}
								<span class="stat">{Math.round(item.calories)}</span>
							{/if}
							<span class="stat protein">{Math.round(item.protein)}g</span>
						</div>
					</div>
				{/each}
			</div>

			{#if entry.reasoning}
				<details class="reasoning card-element" style="animation-delay: 0.05s;">
					<summary>ANALYSIS</summary>
					<p>{entry.reasoning}</p>
				</details>
			{/if}

			<div class="delete-section card-element" style="animation-delay: 0.1s;">
				<button class="action-btn delete" onclick={handleDelete}>
					DELETE
				</button>
			</div>
		{/if}
	{:else}
		<div class="delete-section">
			<button class="action-btn delete" onclick={handleDelete}>
				DELETE
			</button>
		</div>
	{/if}
</div>

<style>
	.entry-card {
		padding: 1.25rem;
		background: #0a0a0a;
		border: 1px solid #222;
		border-radius: 8px;
		transition: all 0.2s ease;
	}

	.entry-card:hover {
		background: #0d0d0d;
		border-color: #333;
	}

	.card-element {
		animation: elementFadeInUp 0.2s cubic-bezier(0.4, 0, 0.2, 1) both;
	}

	@keyframes elementFadeInUp {
		from {
			opacity: 0;
			transform: translateY(8px);
		}
		to {
			opacity: 1;
			transform: translateY(0);
		}
	}

	.entry-main {
		display: flex;
		justify-content: space-between;
		align-items: flex-start;
		gap: 1rem;
		margin-bottom: 1rem;
	}

	.entry-left {
		flex: 1;
		display: flex;
		flex-direction: column;
		gap: 0.5rem;
	}

	.entry-time {
		font-size: 0.7rem;
		font-weight: 700;
		color: #666;
		text-transform: uppercase;
		letter-spacing: 0.15em;
	}

	h4 {
		font-size: 1.125rem;
		font-weight: 600;
		margin: 0;
		color: #fff;
		letter-spacing: 0.02em;
		line-height: 1.3;
	}

	.entry-right {
		flex-shrink: 0;
	}

	.macros {
		display: flex;
		gap: 1.5rem;
		align-items: flex-end;
	}

	.macro-item {
		display: flex;
		flex-direction: column;
		align-items: flex-end;
		gap: 0.25rem;
	}

	.macro-value {
		font-size: 1.5rem;
		font-weight: 700;
		color: #fff;
		line-height: 1;
		letter-spacing: -0.02em;
	}

	.macro-item.protein .macro-value {
		color: #4ade80;
	}


	.entry-actions {
		display: flex;
		gap: 0.75rem;
		padding-top: 0.75rem;
		border-top: 1px solid #1a1a1a;
	}

	.delete-section {
		display: flex;
		gap: 0.75rem;
		padding-top: 0.75rem;
		border-top: 1px solid #1a1a1a;
		margin-top: 0.75rem;
	}

	.action-btn {
		background: transparent;
		border: 1px solid #333;
		color: #888;
		padding: 0.5rem 1rem;
		border-radius: 2px;
		font-size: 0.65rem;
		font-weight: 700;
		letter-spacing: 0.1em;
		cursor: pointer;
		transition: all 0.2s;
		text-transform: uppercase;
	}

	.action-btn:hover {
		background: #1a1a1a;
		color: #fff;
		border-color: #444;
	}

	.action-btn.delete {
		border-color: #ff4444;
		color: #ff4444;
	}

	.action-btn.delete:hover {
		background: #ff4444;
		color: #000;
	}

	.items-breakdown {
		margin-top: 1rem;
		padding: 1rem;
		background: #050505;
		border-left: 2px solid #1a1a1a;
		display: flex;
		flex-direction: column;
		gap: 0.75rem;
	}

	.breakdown-item {
		display: flex;
		justify-content: space-between;
		align-items: center;
		gap: 1rem;
		padding: 0.5rem 0;
		border-bottom: 1px solid #0a0a0a;
	}

	.breakdown-item:last-child {
		border-bottom: none;
	}

	.item-name {
		font-size: 0.875rem;
		color: #ccc;
		flex: 1;
		font-weight: 500;
	}

	.item-stats {
		display: flex;
		gap: 1rem;
		align-items: baseline;
	}

	.stat {
		font-size: 0.875rem;
		font-weight: 600;
		color: #666;
		letter-spacing: 0.02em;
	}

	.stat.protein {
		color: #4ade80;
	}

	.reasoning {
		margin-top: 1rem;
		padding: 1rem;
		background: #050505;
		border-left: 2px solid #1a1a1a;
	}

	.reasoning summary {
		font-size: 0.65rem;
		font-weight: 700;
		color: #888;
		cursor: pointer;
		user-select: none;
		text-transform: uppercase;
		letter-spacing: 0.1em;
	}

	.reasoning summary:hover {
		color: #fff;
	}

	.reasoning p {
		margin-top: 0.75rem;
		font-size: 0.875rem;
		color: #999;
		line-height: 1.6;
		font-weight: 400;
	}
</style>
