<script>
	import LoadingSkeleton from './LoadingSkeleton.svelte';
	import EntryCard from './EntryCard.svelte';

	let { historyGroups, historyLoading, proteinFocused, onDeleteEntry } = $props();

	// Animation timing (in seconds) - tune these to adjust cascade speed
	const GROUP_DELAY = 0.06;      // Delay between date groups
	const DATE_ELEMENT_DELAY = 0.06; // Delay between elements in date header
	const MEAL_DELAY = 0.12;       // Delay between meal sections
	const ENTRY_DELAY = 0.06;      // Delay between entry cards
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
		{@const allEntries = historyGroups.flatMap(g =>
			Object.values(g.mealTimes).flat()
		)}
		<div class="history-list">
			{#each historyGroups as group, groupIndex (group.date)}
				{@const groupDelay = groupIndex * GROUP_DELAY}
				<div class="date-group">
					<div class="date-header">
						<div class="date-info">
							<h2 class="fade-in-element" style="animation-delay: {groupDelay}s;">{group.dayName.toUpperCase()}</h2>
							<span class="date fade-in-element" style="animation-delay: {groupDelay + DATE_ELEMENT_DELAY}s;">{group.monthDay.toUpperCase()}</span>
						</div>

						<div class="date-totals">
						{#if !proteinFocused}
							<div class="total-item">
								<div class="total-value fade-in-element" style="animation-delay: {groupDelay + DATE_ELEMENT_DELAY * 2}s;">{Math.round(group.totalCalories)}</div>
								<div class="total-label fade-in-element" style="animation-delay: {groupDelay + DATE_ELEMENT_DELAY * 3}s;">CAL</div>
							</div>
						{/if}
						<div class="total-item protein">
							<div class="total-value fade-in-element" style="animation-delay: {groupDelay + DATE_ELEMENT_DELAY * (proteinFocused ? 2 : 4)}s;">{Math.round(group.totalProtein)}g</div>
							<div class="total-label fade-in-element" style="animation-delay: {groupDelay + DATE_ELEMENT_DELAY * (proteinFocused ? 3 : 5)}s;">PROTEIN</div>
						</div>
					</div>
					</div>


					<div class="meals-container">
						{#each Object.entries(group.mealTimes) as [mealType, entries], mealIndex}
							{#if entries.length > 0}
								{@const mealCals = entries.reduce((sum, e) => sum + (e.total_calories || 0), 0)}
								{@const mealProt = entries.reduce((sum, e) => sum + (e.total_protein || 0), 0)}
								{@const mealDelay = (mealIndex * MEAL_DELAY)}
								<div class="meal-section fade-in-element" style="animation-delay: {mealDelay}s;">
									<div class="meal-header">
										<span class="meal-type">{mealType.toUpperCase()}</span>
									</div>
									<div class="entries">
										{#each entries as entry, entryIndex (entry.id)}
											{@const entryDelay = mealDelay + (entryIndex * ENTRY_DELAY)}
											<EntryCard
												{entry}
												onDelete={onDeleteEntry}
												{proteinFocused}
												animationDelay={entryDelay}
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
	#historyView {
		animation: fadeIn 0.4s cubic-bezier(0.4, 0, 0.2, 1);
	}

	@keyframes fadeIn {
		from {
			opacity: 0;
			transform: translateY(8px);
		}
		to {
			opacity: 1;
			transform: translateY(0);
		}
	}

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

	.fade-in-element {
		animation: fadeInUp 0.4s cubic-bezier(0.4, 0, 0.2, 1) both;
	}

	@keyframes fadeInUp {
		from {
			opacity: 0;
			transform: translateY(12px);
		}
		to {
			opacity: 1;
			transform: translateY(0);
		}
	}
</style>
