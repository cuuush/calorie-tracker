<script>
	import '../app.css';
	import { onMount } from 'svelte';
	import Toast from '$lib/components/Toast.svelte';
	let { children } = $props();

	onMount(() => {
		const tz = Intl.DateTimeFormat().resolvedOptions().timeZone;
		if (tz && !document.cookie.split('; ').some((c) => c.startsWith('tz='))) {
			document.cookie = `tz=${encodeURIComponent(tz)}; path=/; max-age=31536000; SameSite=Lax`;
		}
	});
</script>

{@render children()}
<Toast />
