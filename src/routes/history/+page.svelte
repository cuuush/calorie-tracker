<script>
	import { onMount } from 'svelte';
	import { goto } from '$app/navigation';
	import EntryCard from '$lib/components/EntryCard.svelte';
	import LoadingSkeleton from '$lib/components/LoadingSkeleton.svelte';

	let loading = $state(true);
	let history = $state([]);
	let settings = $state({});

	onMount(async () => {
		await Promise.all([loadHistory(), loadSettings()]);
		loading = false;
	});

	async function loadHistory() {
		try {
			const response = await fetch('/api/history');
			if (response.ok) {
				history = await response.json();
			}
		} catch (error) {
			console.error('Failed to load history:', error);
		}
	}

	async function loadSettings() {
		try {
			const response = await fetch('/api/settings');
			if (response.ok) {
				settings = await response.json();
			}
		} catch (error) {
			console.error('Failed to load settings:', error);
		}
	}

	async function deleteEntry(id) {
		try {
			const response = await fetch(`/api/entry/${id}`, { method: 'DELETE' });
			if (response.ok) {
				history = history.filter(entry => entry.id !== id);
			}
		} catch (error) {
			console.error('Failed to delete entry:', error);
			alert('Failed to delete entry');
		}
	}

	function getMealType(timestamp) {
		const hours = new Date(timestamp).getHours();
		if (hours >= 5 && hours < 12) return 'breakfast';
		else if (hours >= 12 && hours < 17) return 'lunch';
		else if (hours >= 17 && hours < 22) return 'dinner';
		else return 'snack';
	}

	function groupHistory(entries) {
		const grouped = {};

		for (const entry of entries) {
			const date = new Date(entry.timestamp);
			const dateKey = date.toDateString();

			if (!grouped[dateKey]) {
				grouped[dateKey] = {
					date: dateKey,
					dayName: date.toLocaleDateString('en-US', { weekday: 'long' }),
					monthDay: date.toLocaleDateString('en-US', { month: 'short', day: 'numeric' }),
					mealTimes: {
						breakfast: [],
						lunch: [],
						dinner: [],
						snack: []
					},
					totalCalories: 0,
					totalProtein: 0
				};
			}

			const mealType = getMealType(entry.timestamp);
			grouped[dateKey].mealTimes[mealType].push(entry);
			grouped[dateKey].totalCalories += entry.total_calories || 0;
			grouped[dateKey].totalProtein += entry.total_protein || 0;
		}

		return Object.values(grouped);
	}

	let groups = $derived(groupHistory(history));
</script>

<div class="history-page">
	<div class="header">
		<button class="back-btn" onclick={() => goto('/')}>
			<svg width="20" height="20" viewBox="0 0 20 20" fill="none">
				<path d="M12.5 15L7.5 10L12.5 5" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>
			</svg>
			Back
		</button>
		<h1>History</h1>
	</div>

	{#if loading}
		<div class="loading-state">
			<LoadingSkeleton width="100%" height="40px" />
			<LoadingSkeleton width="100%" height="200px" />
			<LoadingSkeleton width="100%" height="200px" />
		</div>
	{:else if groups.length === 0}
		<div class="empty-state">
			<svg width="64" height="64" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
				<path d="M3 3h18v18H3z"/>
				<path d="M3 9h18"/>
				<path d="M9 21V9"/>
			</svg>
			<h3>No history yet</h3>
			<p>Start tracking your meals to see your history here</p>
			<button class="cta-btn" onclick={() => goto('/')}>Start Tracking</button>
		</div>
	{:else}
		<div class="history-list">
			{#each groups as group (group.date)}
				<div class="date-group">
					<div class="date-header">
						<div class="date-info">
							<h2>{group.dayName}</h2>
							<span class="date">{group.monthDay}</span>
						</div>
						<div class="date-totals">
							{#if !settings.protein_focused_mode}
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
											onDelete={deleteEntry}
											proteinFocused={settings.protein_focused_mode === 1}
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
	.history-page {
		max-width: 600px;
		margin: 0 auto;
		padding: 1rem;
		min-height: 100vh;
	}

	.header {
		display: flex;
		align-items: center;
		gap: 1rem;
		margin-bottom: 2rem;
		position: sticky;
		top: 0;
		background: var(--bg);
		padding: 1rem 0;
		z-index: 10;
	}

	.back-btn {
		display: flex;
		align-items: center;
		gap: 0.5rem;
		background: transparent;
		border: 1px solid var(--border);
		color: var(--text);
		padding: 0.5rem 1rem;
		border-radius: 8px;
		cursor: pointer;
		transition: all 0.2s;
		font-size: 0.875rem;
	}

	.back-btn:hover {
		background: var(--surface);
		border-color: #333;
	}

	h1 {
		font-size: 1.5rem;
		font-weight: 700;
		margin: 0;
		color: var(--text);
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
		padding: 4rem 2rem;
		text-align: center;
		gap: 1rem;
	}

	.empty-state svg {
		color: #333;
		margin-bottom: 1rem;
	}

	.empty-state h3 {
		font-size: 1.25rem;
		font-weight: 600;
		margin: 0;
		color: var(--text);
	}

	.empty-state p {
		font-size: 0.875rem;
		color: #888;
		margin: 0;
	}

	.cta-btn {
		background: var(--text);
		color: var(--bg);
		border: none;
		padding: 0.75rem 2rem;
		border-radius: 8px;
		font-size: 0.875rem;
		font-weight: 600;
		cursor: pointer;
		transition: all 0.2s;
		margin-top: 1rem;
	}

	.cta-btn:hover {
		opacity: 0.9;
		transform: translateY(-1px);
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
