<script>
	import LoadingSkeleton from './LoadingSkeleton.svelte';

	let { title, value, subtitle, loading = false, children } = $props();
</script>

<div class="stats-card">
	{#if loading}
		<LoadingSkeleton width="120px" height="24px" />
		<LoadingSkeleton width="80px" height="40px" />
		{#if subtitle}
			<LoadingSkeleton width="100px" height="16px" />
		{/if}
	{:else}
		<h3>{title}</h3>
		{#if value !== undefined}
			<div class="value">{value}</div>
		{/if}
		{#if subtitle}
			<div class="subtitle">{subtitle}</div>
		{/if}
		{#if children}
			{@render children()}
		{/if}
	{/if}
</div>

<style>
	.stats-card {
		background: var(--surface);
		border: 1px solid var(--border);
		border-radius: 12px;
		padding: 1.5rem;
		display: flex;
		flex-direction: column;
		gap: 0.5rem;
	}

	h3 {
		font-size: 0.875rem;
		font-weight: 500;
		color: #888;
		margin: 0;
		text-transform: uppercase;
		letter-spacing: 0.05em;
	}

	.value {
		font-size: 2rem;
		font-weight: 700;
		color: var(--text);
		margin: 0;
	}

	.subtitle {
		font-size: 0.875rem;
		color: #888;
	}
</style>
