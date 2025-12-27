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
			<p>NO HISTORY YET</p>
			<span>START TRACKING MEALS</span>
		</div>
	{:else}
		<div class="history-list">
			{#each historyGroups as group (group.date)}
				<div class="date-group">
					<div class="date-header">
						<div class="date-info">
							<h2>{group.dayName.toUpperCase()}</h2>
							<span class="date">{group.monthDay.toUpperCase()}</span>
						</div>

						<div class="date-totals">
						{#if !proteinFocused}
							<div class="total-item">
								<div class="total-value">{Math.round(group.totalCalories)}</div>
								<div class="total-label">CAL</div>
							</div>
						{/if}
						<div class="total-item protein">
							<div class="total-value">{Math.round(group.totalProtein)}g</div>
							<div class="total-label">PROTEIN</div>
						</div>
					</div>
					</div>

					<div class="meals-container">
						{#each Object.entries(group.mealTimes) as [mealType, entries]}
							{#if entries.length > 0}
								{@const mealCals = entries.reduce((sum, e) => sum + (e.total_calories || 0), 0)}
								{@const mealProt = entries.reduce((sum, e) => sum + (e.total_protein || 0), 0)}
								<div class="meal-section">
									<div class="meal-header">
										<span class="meal-type">{mealType.toUpperCase()}</span>
									</div>
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
				</div>
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
		gap: 3rem;
	}

	.date-group {
		display: flex;
		flex-direction: column;
		gap: 0;
	}

	.date-header {
		display: flex;
		justify-content: space-between;
		align-items: flex-start;
		padding: 1.5rem 0;
		border-bottom: 2px solid #222;
		margin-bottom: 1.5rem;
	}

	.date-info {
		display: flex;
		flex-direction: column;
		gap: 0.5rem;
	}

	.date-info h2 {
		font-size: 1.75rem;
		font-weight: 700;
		margin: 0;
		color: #fff;
		letter-spacing: 0.05em;
	}

	.date-info .date {
		font-size: 0.7rem;
		color: #666;
		text-transform: uppercase;
		letter-spacing: 0.15em;
		font-weight: 600;
	}

	.date-totals {
		display: flex;
		gap: 2rem;
		align-items: flex-end;
		margin-top: 0.5em;
		margin-bottom: 1em;
	}

	.total-item {
		display: flex;
		flex-direction: column;
		align-items: flex-end;
		gap: 0.25rem;
	}

	.total-value {
		font-size: 1.5rem;
		font-weight: 700;
		color: #fff;
		line-height: 1;
		letter-spacing: -0.02em;
	}

	.total-item.protein .total-value {
		color: #4ade80;
	}

	.total-label {
		font-size: 0.6rem;
		font-weight: 700;
		color: #666;
		text-transform: uppercase;
		letter-spacing: 0.15em;
	}

	.meals-container {
		display: flex;
		flex-direction: column;
		gap: 2rem;
	}

	.meal-section {
		display: flex;
		flex-direction: column;
		gap: 0.75rem;
	}

	.meal-header {
		display: flex;
		justify-content: space-between;
		align-items: baseline;
		padding-bottom: 0.5rem;
		border-bottom: 1px solid #1a1a1a;
	}

	.meal-type {
		font-size: 0.7rem;
		font-weight: 700;
		color: #888;
		text-transform: uppercase;
		letter-spacing: 0.15em;
	}


	.entries {
		display: flex;
		flex-direction: column;
		gap: 0.75rem;
	}
</style>
