<script>
	let { data, total, title, unit, colors } = $props();

	// Helper function to create pie chart slice path
	function createPieSlice(startAngle, endAngle) {
		if (endAngle - startAngle >= 360) {
			return 'M 50 50 m -45 0 a 45 45 0 1 0 90 0 a 45 45 0 1 0 -90 0';
		}

		const start = (startAngle - 90) * Math.PI / 180;
		const end = (endAngle - 90) * Math.PI / 180;

		const x1 = 50 + 45 * Math.cos(start);
		const y1 = 50 + 45 * Math.sin(start);
		const x2 = 50 + 45 * Math.cos(end);
		const y2 = 50 + 45 * Math.sin(end);

		const largeArc = endAngle - startAngle > 180 ? 1 : 0;

		return `M 50 50 L ${x1} ${y1} A 45 45 0 ${largeArc} 1 ${x2} ${y2} Z`;
	}

	// Calculate slices
	let slices = $derived.by(() => {
		let currentAngle = 0;
		return Object.entries(data).map(([key, value]) => {
			const angle = (value / total) * 360;
			const path = createPieSlice(currentAngle, currentAngle + angle);
			const slice = { key, value, angle, path, color: colors[key] };
			currentAngle += angle;
			return slice;
		}).filter(slice => slice.value > 0);
	});
</script>

<div class="pie-chart-wrapper">
	<h3 class="chart-title">{title}</h3>
	<svg viewBox="0 0 100 100" class="pie-chart">
		{#each slices as slice}
			<path d={slice.path} fill={slice.color} stroke="#000" stroke-width="0.5"/>
		{/each}
	</svg>
	<div class="chart-center-label">
		<div class="chart-total">{Math.round(total)}</div>
		<div class="chart-label">{unit}</div>
	</div>
</div>

<style>
	.pie-chart-wrapper {
		position: relative;
		display: flex;
		flex-direction: column;
		align-items: center;
		gap: 0.75rem;
	}

	.chart-title {
		font-size: 0.75rem;
		font-weight: 600;
		color: #888;
		text-transform: uppercase;
		letter-spacing: 0.05em;
		margin: 0;
	}

	.pie-chart {
		width: 100%;
		max-width: 150px;
		height: auto;
		position: relative;
	}

	.chart-center-label {
		position: absolute;
		top: 50%;
		left: 50%;
		transform: translate(-50%, -50%);
		text-align: center;
		pointer-events: none;
		margin-top: 1.5rem;
	}

	.chart-total {
		font-size: 1.25rem;
		font-weight: 700;
		color: white;
		line-height: 1;
	}

	.chart-label {
		font-size: 0.65rem;
		color: #666;
		text-transform: uppercase;
		letter-spacing: 0.05em;
		margin-top: 0.125rem;
	}
</style>
