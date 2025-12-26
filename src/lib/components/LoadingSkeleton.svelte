<script>
	let { width = '100%', height = '20px', borderRadius = '8px' } = $props();
</script>

<div class="skeleton" style="width: {width}; height: {height}; border-radius: {borderRadius};"></div>

<style>
	.skeleton {
		background: linear-gradient(90deg, #1a1a1a 25%, #2a2a2a 50%, #1a1a1a 75%);
		background-size: 200% 100%;
		animation: loading 1.5s ease-in-out infinite;
	}

	@keyframes loading {
		0% {
			background-position: 200% 0;
		}
		100% {
			background-position: -200% 0;
		}
	}
</style>
