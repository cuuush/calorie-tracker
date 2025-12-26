<script>
	import LoadingSkeleton from './LoadingSkeleton.svelte';
	import EntryCard from './EntryCard.svelte';

	let { historyGroups, historyLoading, proteinFocused, onDeleteEntry } = $props();
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
			<p style="color: #666; margin: 4rem 0;">No history yet. Start tracking meals!</p>
		</div>
	{:else}
		<div class="history-list">
			{#each historyGroups as group (group.date)}
				<div class="date-group">
					<div class="date-header">
						<div class="date-info">
							<h2>{group.dayName}</h2>
							<span class="date">{group.monthDay}</span>
						</div>
						<div class="date-totals">
							{#if !proteinFocused}
								<span class="total calories">{Math.round(group.totalCalories)} cal</span>
							{/if}
							<span class="total protein">{Math.round(group.totalProtein)}g protein</span>
						</div>
					</div>

					{#each Object.entries(group.mealTimes) as [mealType, entries]}
						{#if entries.length > 0}
							<div class="meal-section">
								<h3 class="meal-header">{mealType.charAt(0).toUpperCase() + mealType.slice(1)}</h3>
								<div class="entries">
									{#each entries as entry (entry.id)}
										<EntryCard
											{entry}
											onDelete={onDeleteEntry}
											{proteinFocused}
										/>
									{/each}
								</div>
							</div>
						{/if}
					{/each}
				</div>
			{/each}
		</div>
	{/if}
</div>

<style>
	#historyView {
		animation: fadeIn 0.3s ease-out;
	}

	@keyframes fadeIn {
		from {
			opacity: 0;
		}
		to {
			opacity: 1;
		}
	}

	.loading-state {
		display: flex;
		flex-direction: column;
		gap: 1.5rem;
	}

	.empty-state {
		text-align: center;
	}

	.history-list {
		display: flex;
		flex-direction: column;
		gap: 2rem;
	}

	.date-group {
		display: flex;
		flex-direction: column;
		gap: 1rem;
	}

	.date-header {
		display: flex;
		justify-content: space-between;
		align-items: center;
		padding-bottom: 0.75rem;
		border-bottom: 1px solid var(--border);
	}

	.date-info {
		display: flex;
		flex-direction: column;
		gap: 0.25rem;
	}

	.date-info h2 {
		font-size: 1.125rem;
		font-weight: 600;
		margin: 0;
		color: var(--text);
	}

	.date-info .date {
		font-size: 0.75rem;
		color: #666;
		text-transform: uppercase;
		letter-spacing: 0.05em;
	}

	.date-totals {
		display: flex;
		gap: 1rem;
		flex-wrap: wrap;
	}

	.total {
		font-size: 0.875rem;
		font-weight: 500;
		padding: 0.25rem 0.75rem;
		border-radius: 6px;
		background: var(--surface);
		border: 1px solid var(--border);
	}

	.total.protein {
		color: #4ade80;
	}

	.total.calories {
		color: #60a5fa;
	}

	.meal-section {
		margin-top: 1rem;
	}

	.meal-header {
		font-size: 0.875rem;
		font-weight: 600;
		color: #888;
		text-transform: uppercase;
		letter-spacing: 0.05em;
		margin: 0 0 0.75rem 0;
		padding: 0.5rem 0;
		border-bottom: 1px solid #1a1a1a;
	}

	.entries {
		display: flex;
		flex-direction: column;
		gap: 1rem;
	}
</style>
