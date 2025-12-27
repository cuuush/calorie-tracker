<script>
	import PieChart from './PieChart.svelte';

	let { statsData, dailyBudget, proteinGoal, proteinFocused } = $props();

	const mealColors = {
		BREAKFAST: '#B5EAD7',
		LUNCH: '#FFD3B6',
		DINNER: '#C7CEEA',
		SNACK: '#FDE2E4'
	};
</script>

<div id="statsView" style="margin-top: 30px;">
	{#if !proteinFocused}
		<div class="stats-card" style="margin: 0; padding: 0; background: transparent; border: none;">
			<div style="display: flex; justify-content: space-between; align-items: baseline;">
				<span class="day-title">DAILY INTAKE</span>
				<span class="day-summary"
					>{Math.round(statsData.todayTotal)} / {dailyBudget} CAL</span
				>
			</div>
			<div class="progress-container">
				<div
					class="progress-bar"
					style="width: {Math.min((statsData.todayTotal / dailyBudget) * 100, 100)}%; background: #60a5fa;"
				></div>
			</div>
			<div style="display: flex; justify-content: flex-end; margin-bottom: 20px;">
				<span class="stat-label"
					>{Math.round(Math.max(dailyBudget - statsData.todayTotal, 0))} REMAINING</span
				>
			</div>
		</div>

		<!-- Pie Charts -->
		{#if statsData.todayTotal > 0}
			<div class="pie-charts-container">
				<PieChart
					data={statsData.groups}
					total={statsData.todayTotal}
					title="Calories by Meal"
					unit="CAL"
					colors={mealColors}
				/>
				<PieChart
					data={statsData.proteinGroups}
					total={statsData.todayProtein}
					title="Protein by Meal"
					unit="g"
					colors={mealColors}
				/>
			</div>

			<!-- Color Key -->
			<div class="color-key">
				<span style="color: #B5EAD7;">Breakfast</span>
				<span style="color: #FFD3B6;">Lunch</span>
				<span style="color: #C7CEEA;">Dinner</span>
				<span style="color: #FDE2E4;">Snack</span>
			</div>
		{/if}
	{/if}

	<div
		class="stats-card"
		style="margin: 0; padding: 0; background: transparent; border: none; margin-top: {proteinFocused
			? '0'
			: '30px'};"
	>
		<div style="display: flex; justify-content: space-between; align-items: baseline;">
			<span class="day-title">PROTEIN GOAL</span>
			<span class="day-summary"
				>{Math.round(statsData.todayProtein)}g / {proteinGoal}g</span
			>
		</div>
		<div class="progress-container">
			<div
				class="progress-bar protein"
				style="width: {Math.min((statsData.todayProtein / proteinGoal) * 100, 100)}%;"
			></div>
		</div>
		<div style="display: flex; justify-content: flex-end; margin-bottom: 20px;">
			<span class="stat-label"
				>{Math.round(Math.max(proteinGoal - statsData.todayProtein, 0))}g REMAINING</span
			>
		</div>
	</div>

	<div class="stats-grid">
			{#if statsData.weeklyData.filter((x) => x > 0).length > 0}
				{@const daysTracked = statsData.weeklyData.filter((x) => x > 0).length}
				{@const avgCals = Math.round(
					statsData.weeklyData.reduce((a, b) => a + b, 0) / daysTracked
				)}
				{@const avgProt = Math.round(
					statsData.weeklyProteinData.reduce((a, b) => a + b, 0) / daysTracked
				)}
				{#if !proteinFocused}
					<div class="stat-box">
						<span class="stat-label">DAILY AVG</span>
						<span class="stat-value">{avgCals} / {dailyBudget}</span>
						<span
							class="stat-label"
							style="font-size: 0.5rem; margin-top: 4px; color: {avgCals <=
							dailyBudget
								? '#4ade80'
								: '#f87171'}"
						>
							{avgCals <= dailyBudget ? '✓' : '!'} {avgCals - dailyBudget > 0 ? '+' : ''}{avgCals -
								dailyBudget} CAL
						</span>
					</div>
				{/if}
				<div class="stat-box" style="text-align: {proteinFocused ? 'left' : 'right'};">
					<span class="stat-label">PROTEIN AVG</span>
					<span class="stat-value">{avgProt}g / {proteinGoal}g</span>
					<span
						class="stat-label"
						style="font-size: 0.5rem; margin-top: 4px; color: {avgProt >= proteinGoal
							? '#4ade80'
							: '#f87171'}"
					>
						{avgProt >= proteinGoal ? '✓' : '!'} {avgProt - proteinGoal > 0 ? '+' : ''}{avgProt -
							proteinGoal}g
					</span>
				</div>
			{:else}
				<div class="stat-box">
					<span class="stat-label">NO DATA YET</span><span class="stat-value">-</span>
				</div>
			{/if}
	</div>

	<div class="weekly-chart" style="padding-top:20px;">
			{#each ['S', 'M', 'T', 'W', 'T', 'F', 'S'] as day, i}
				{@const maxValue = proteinFocused
					? Math.max(proteinGoal * 1.2, ...statsData.weeklyProteinData)
					: Math.max(dailyBudget * 1.2, ...statsData.weeklyData)}
				{@const value = proteinFocused
					? statsData.weeklyProteinData[i]
					: statsData.weeklyData[i]}
				{@const target = proteinFocused ? proteinGoal : dailyBudget}
				<div class="day-column">
					<div class="day-bar-wrap">
						<div
							class="day-bar {i === new Date().getDay() ? 'today' : ''} {value > target
								? 'over'
								: ''}"
							style="height: {(value / maxValue) * 100}%"
						></div>
					</div>
					<span class="day-name">{day}</span>
				</div>
			{/each}
	</div>
</div>

<style>
	.pie-charts-container {
		display: grid;
		grid-template-columns: 1fr 1fr;
		gap: 1.5rem;
		margin-top: 2rem;
		margin-bottom: 1rem;
	}

	.color-key {
		display: flex;
		justify-content: center;
		gap: 1.5rem;
		margin-top: 1rem;
		padding: 0.75rem;
	}

	.color-key span {
		font-size: 0.7rem;
		font-weight: 600;
		text-transform: uppercase;
		letter-spacing: 0.05em;
	}
</style>
