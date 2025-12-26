<script>
	let { entry, onDelete, proteinFocused = false } = $props();
	let expanded = $state(false);

	function formatTime(timestamp) {
		const date = new Date(timestamp);
		const hours = date.getHours();
		const minutes = date.getMinutes().toString().padStart(2, '0');
		const period = hours >= 12 ? 'PM' : 'AM';
		const displayHours = hours % 12 || 12;

		let label = '';
		if (hours >= 5 && hours < 12) label = 'Breakfast';
		else if (hours >= 12 && hours < 17) label = 'Lunch';
		else if (hours >= 17 && hours < 22) label = 'Dinner';
		else label = 'Late Night';

		return { time: `${displayHours}:${minutes} ${period}`, label };
	}

	const { time, label } = formatTime(entry.timestamp);

	async function handleDelete() {
		if (confirm('Delete this entry?')) {
			await onDelete(entry.id);
		}
	}
</script>

<div class="entry-card">
	<div class="entry-header">
		<div class="entry-time">
			<span class="time">{time}</span>
			<span class="label">{label}</span>
		</div>
		<button class="delete-btn" onclick={handleDelete}>Delete</button>
	</div>

	<h4>{entry.meal_title || 'Meal'}</h4>

	<div class="macros">
		{#if !proteinFocused}
			<span class="macro calories">{Math.round(entry.total_calories)} cal</span>
		{/if}
		<span class="macro protein">{Math.round(entry.total_protein)}g protein</span>
		{#if !proteinFocused && entry.total_carbs}
			<span class="macro carbs">{Math.round(entry.total_carbs)}g carbs</span>
		{/if}
	</div>

	{#if entry.items}
		<button class="details-btn" onclick={() => (expanded = !expanded)}>
			{expanded ? 'Hide' : 'Show'} Details
		</button>

		{#if expanded}
			<div class="items-list">
				{#each JSON.parse(entry.items) as item}
					<div class="item">
						<span class="item-name">{item.name}</span>
						<span class="item-macros">
							{#if !proteinFocused}
								{Math.round(item.calories)} cal •
							{/if}
							{Math.round(item.protein)}g protein
						</span>
					</div>
				{/each}
			</div>

			{#if entry.reasoning}
				<details class="reasoning">
					<summary>AI Reasoning</summary>
					<p>{entry.reasoning}</p>
				</details>
			{/if}
		{/if}
	{/if}
</div>

<style>
	.entry-card {
		background: var(--surface);
		border: 1px solid var(--border);
		border-radius: 12px;
		padding: 1.25rem;
		animation: slideIn 0.3s ease-out;
	}

	@keyframes slideIn {
		from {
			opacity: 0;
			transform: translateY(10px);
		}
		to {
			opacity: 1;
			transform: translateY(0);
		}
	}

	.entry-header {
		display: flex;
		justify-content: space-between;
		align-items: flex-start;
		margin-bottom: 0.75rem;
	}

	.entry-time {
		display: flex;
		flex-direction: column;
		gap: 0.25rem;
	}

	.time {
		font-size: 0.875rem;
		color: #888;
	}

	.label {
		font-size: 0.75rem;
		color: #666;
		text-transform: uppercase;
		letter-spacing: 0.05em;
	}

	.delete-btn {
		background: transparent;
		border: 1px solid #ff4444;
		color: #ff4444;
		padding: 0.375rem 0.75rem;
		border-radius: 6px;
		font-size: 0.75rem;
		cursor: pointer;
		transition: all 0.2s;
	}

	.delete-btn:hover {
		background: #ff4444;
		color: white;
	}

	h4 {
		font-size: 1.125rem;
		font-weight: 600;
		margin: 0 0 0.75rem 0;
		color: var(--text);
	}

	.macros {
		display: flex;
		gap: 1rem;
		flex-wrap: wrap;
		margin-bottom: 0.75rem;
	}

	.macro {
		font-size: 0.875rem;
		font-weight: 500;
		padding: 0.25rem 0.75rem;
		border-radius: 6px;
		background: #1a1a1a;
	}

	.macro.protein {
		color: #4ade80;
	}

	.macro.calories {
		color: #60a5fa;
	}

	.macro.carbs {
		color: #fbbf24;
	}

	.details-btn {
		background: transparent;
		border: 1px solid var(--border);
		color: var(--text);
		padding: 0.5rem 1rem;
		border-radius: 8px;
		font-size: 0.875rem;
		cursor: pointer;
		transition: all 0.2s;
		width: 100%;
	}

	.details-btn:hover {
		background: #1a1a1a;
		border-color: #333;
	}

	.items-list {
		margin-top: 1rem;
		display: flex;
		flex-direction: column;
		gap: 0.75rem;
		padding: 1rem;
		background: #0a0a0a;
		border-radius: 8px;
	}

	.item {
		display: flex;
		justify-content: space-between;
		align-items: center;
		gap: 1rem;
	}

	.item-name {
		font-size: 0.875rem;
		color: var(--text);
		flex: 1;
	}

	.item-macros {
		font-size: 0.75rem;
		color: #888;
		white-space: nowrap;
	}

	.reasoning {
		margin-top: 1rem;
		padding: 1rem;
		background: #0a0a0a;
		border-radius: 8px;
	}

	.reasoning summary {
		font-size: 0.875rem;
		color: #888;
		cursor: pointer;
		user-select: none;
	}

	.reasoning p {
		margin-top: 0.75rem;
		font-size: 0.875rem;
		color: #aaa;
		line-height: 1.5;
	}
</style>
