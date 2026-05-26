<script>
	import { Camera, Mic, Square, Send } from 'lucide-svelte';
	import DailyStats from './DailyStats.svelte';
	import { uploadFile } from '$lib/net.js';
	import { toast } from '$lib/toast.svelte.js';

	let {
		userMessage = $bindable(),
		selectedImages = $bindable([]),
		selectedAudio = $bindable(null),
		isRecording = $bindable(),
		isAiLoading,
		placeholder,
		audioLevels,
		statsData,
		dailyBudget,
		proteinGoal,
		proteinFocused,
		onAnalyze,
		onToggleMic,
		onMealSelect
	} = $props();

	let fileInput = $state(null);
	let searchResults = $state([]);
	let searchTimeout;
	let showSearchResults = $state(false);
	let selectedIndex = $state(-1);
	let searchActive = $state(true);

	async function searchMeals(query) {
		clearTimeout(searchTimeout);

		if (query.length < 3 || !searchActive) {
			searchResults = [];
			showSearchResults = false;
			return;
		}

		searchTimeout = setTimeout(async () => {
			if (!searchActive) return;

			try {
				const response = await fetch(`/api/search-meals?q=${encodeURIComponent(query)}`);
				if (response.ok && searchActive) {
					searchResults = await response.json();
					showSearchResults = searchResults.length > 0;
					selectedIndex = -1;
				}
			} catch (error) {
				console.error('Search failed:', error);
			}
		}, 300);
	}

	function nano() {
		return Math.random().toString(36).slice(2, 10) + Date.now().toString(36);
	}

	function startImageUpload(imgState) {
		uploadFile('/api/upload', imgState.file, {
			onProgress: (frac) => {
				const idx = selectedImages.findIndex((s) => s.id === imgState.id);
				if (idx === -1) return;
				selectedImages[idx] = { ...selectedImages[idx], progress: frac };
			}
		})
			.then((res) => {
				const idx = selectedImages.findIndex((s) => s.id === imgState.id);
				if (idx === -1) return;
				selectedImages[idx] = { ...selectedImages[idx], key: res.key, mime: res.mime, progress: 1 };
			})
			.catch((err) => {
				const idx = selectedImages.findIndex((s) => s.id === imgState.id);
				if (idx === -1) return;
				selectedImages[idx] = { ...selectedImages[idx], error: err.message || 'Upload failed' };
				toast('Image upload failed', { kind: 'error' });
			});
	}

	function handleFileSelect(files) {
		const list = Array.from(files || []);
		const added = list.map((file) => ({
			id: nano(),
			file,
			progress: 0,
			thumb: URL.createObjectURL(file)
		}));
		selectedImages = [...selectedImages, ...added];
		added.forEach(startImageUpload);
	}

	function removeImage(id) {
		const found = selectedImages.find((s) => s.id === id);
		if (found?.thumb) URL.revokeObjectURL(found.thumb);
		if (found?.key) {
			fetch('/api/upload', {
				method: 'DELETE',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ key: found.key })
			}).catch(() => {});
		}
		selectedImages = selectedImages.filter((s) => s.id !== id);
	}

	function removeAudio() {
		if (selectedAudio?.key) {
			fetch('/api/upload', {
				method: 'DELETE',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ key: selectedAudio.key })
			}).catch(() => {});
		}
		selectedAudio = null;
	}

	// Upload audio as soon as the parent hands it to us (after recording stops).
	$effect(() => {
		if (selectedAudio && selectedAudio.blob && !selectedAudio.key && !selectedAudio.uploading && !selectedAudio.error) {
			selectedAudio = { ...selectedAudio, uploading: true, progress: 0 };
			uploadFile('/api/upload', selectedAudio.blob, {
				onProgress: (frac) => {
					if (selectedAudio) selectedAudio = { ...selectedAudio, progress: frac };
				}
			})
				.then((res) => {
					if (selectedAudio) {
						selectedAudio = { ...selectedAudio, key: res.key, mime: res.mime, progress: 1, uploading: false };
					}
				})
				.catch((err) => {
					if (selectedAudio) {
						selectedAudio = { ...selectedAudio, error: err.message || 'Upload failed', uploading: false };
					}
					toast('Audio upload failed', { kind: 'error' });
				});
		}
	});

	// Aggregate upload progress across all in-flight images + audio. Returns
	// a fraction 0..1 of how much of the in-flight work is done. If nothing is
	// uploading, returns null.
	let uploadProgress = $derived.by(() => {
		const inFlight = [];
		for (const img of selectedImages) {
			if (img.error) continue;
			if (!img.key) inFlight.push(img.progress || 0);
		}
		if (selectedAudio && !selectedAudio.error && !selectedAudio.key && selectedAudio.blob) {
			inFlight.push(selectedAudio.progress || 0);
		}
		if (inFlight.length === 0) return null;
		return inFlight.reduce((a, b) => a + b, 0) / inFlight.length;
	});

	function handleAnalyze() {
		clearTimeout(searchTimeout);
		searchActive = false;
		searchResults = [];
		showSearchResults = false;
		onAnalyze();
		setTimeout(() => { searchActive = true; }, 100);
	}

	$effect(() => {
		searchMeals(userMessage);
	});

	function handleKeyDown(e) {
		if (e.key === 'Enter' && !showSearchResults) {
			handleAnalyze();
			return;
		}

		if (!showSearchResults) return;

		if (e.key === 'ArrowDown') {
			e.preventDefault();
			selectedIndex = Math.min(selectedIndex + 1, searchResults.length - 1);
		} else if (e.key === 'ArrowUp') {
			e.preventDefault();
			selectedIndex = Math.max(selectedIndex - 1, -1);
		} else if (e.key === 'Enter') {
			if (selectedIndex >= 0) {
				e.preventDefault();
				selectMeal(searchResults[selectedIndex]);
			} else {
				handleAnalyze();
			}
		} else if (e.key === 'Escape') {
			showSearchResults = false;
		}
	}

	function selectMeal(meal) {
		showSearchResults = false;
		searchResults = [];
		userMessage = '';
		onMealSelect(meal);
	}

	// SVG progress ring math
	const RING_RADIUS = 22;
	const RING_CIRC = 2 * Math.PI * RING_RADIUS;
</script>

<div id="trackView">
	<input
		type="file"
		bind:this={fileInput}
		hidden
		accept="image/*"
		multiple
		onchange={(e) => handleFileSelect(e.target.files)}
	/>
	<div class="chat-bar">
		<div class="input-wrapper">
			<input
				type="text"
				bind:value={userMessage}
				class="chat-input"
				placeholder={isRecording ? '' : placeholder}
				disabled={isAiLoading}
				onkeydown={handleKeyDown}
				onblur={() => {
					setTimeout(() => {
						showSearchResults = false;
					}, 150);
				}}
				onfocus={() => {
					if (userMessage.length >= 3) {
						searchMeals(userMessage);
					}
				}}
			/>
			{#if isRecording}
				<div class="audio-visualizer">
					{#each audioLevels as level, i}
						<div
							class="audio-bar"
							style="height: {level}%; opacity: {(audioLevels.length - i) /
								audioLevels.length}"
						></div>
					{/each}
				</div>
			{/if}
			{#if showSearchResults}
				<div class="search-dropdown">
					{#each searchResults as meal, i}
						<button
							class="search-result {selectedIndex === i ? 'selected' : ''}"
							onclick={() => selectMeal(meal)}
						>
							<span class="meal-name">{meal.meal_title}</span>
							<span class="meal-count">{meal.count}x</span>
						</button>
					{/each}
				</div>
			{/if}
		</div>
		<button class="icon-btn" onclick={() => fileInput.click()} title="Add Image">
			<Camera size={20} />
		</button>
		<button class="icon-btn {isRecording ? 'active' : ''}" onclick={onToggleMic}>
			{#if isRecording}
				<Square size={20} />
			{:else}
				<Mic size={20} />
			{/if}
		</button>
		<div class="send-wrap">
			{#if uploadProgress !== null}
				<svg class="send-ring" viewBox="0 0 50 50" aria-hidden="true">
					<circle class="ring-bg" cx="25" cy="25" r={RING_RADIUS} />
					<circle
						class="ring-fg"
						cx="25"
						cy="25"
						r={RING_RADIUS}
						stroke-dasharray={RING_CIRC}
						stroke-dashoffset={RING_CIRC * (1 - uploadProgress)}
					/>
				</svg>
			{/if}
			<button class="send-btn" onclick={handleAnalyze} disabled={isAiLoading}>
				{#if isAiLoading}
					<div class="btn-spinner"></div>
				{:else}
					<Send size={18} />
				{/if}
			</button>
		</div>
	</div>
	{#if selectedImages.length > 0}
		<div class="attachment-row">
			{#each selectedImages as img (img.id)}
				<div class="thumb" class:errored={img.error}>
					<img src={img.thumb} alt="" />
					{#if !img.key && !img.error}
						<div class="thumb-progress" style="--p: {Math.round((img.progress || 0) * 100)}%"></div>
					{/if}
					{#if img.error}
						<div class="thumb-err" title={img.error}>!</div>
					{/if}
					<button class="thumb-clear" onclick={() => removeImage(img.id)} title="Remove">×</button>
				</div>
			{/each}
		</div>
	{/if}
	{#if selectedAudio}
		<div class="attachment-badge">
			<Mic size={14} strokeWidth={2.5} />
			<span>
				{#if selectedAudio.error}
					AUDIO FAILED
				{:else if selectedAudio.key}
					AUDIO READY
				{:else}
					UPLOADING {Math.round((selectedAudio.progress || 0) * 100)}%
				{/if}
			</span>
			<button class="clear-btn" onclick={removeAudio} title="Remove audio"
				>&times;</button
			>
		</div>
	{/if}

	<!-- STATS -->
	<DailyStats {statsData} {dailyBudget} {proteinGoal} {proteinFocused} />
</div>

<style>
	.input-wrapper {
		position: relative;
		flex: 1;
		padding-right: 8px;
		min-width: 0;
		overflow: visible;
	}

	.input-wrapper .chat-input {
		width: 100%;
	}

	.search-dropdown {
		position: absolute;
		margin-top: 5px;
		top: calc(100% + 8px);
		left: 0;
		right: 0;
		background: #111;
		border: 1px solid var(--border);
		border-radius: 8px;
		overflow: hidden;
		z-index: 1000;
		box-shadow: 0 8px 24px rgba(0, 0, 0, 0.4);
		animation: slideDown 0.2s ease-out;
	}

	@keyframes slideDown {
		from {
			opacity: 0;
			transform: translateY(-8px);
		}
		to {
			opacity: 1;
			transform: translateY(0);
		}
	}

	.search-result {
		width: 100%;
		padding: 12px 16px;
		background: transparent;
		border: none;
		border-bottom: 1px solid #222;
		color: #fff;
		text-align: left;
		cursor: pointer;
		display: flex;
		justify-content: space-between;
		align-items: center;
		transition: all 0.15s ease;
	}

	.search-result:last-child {
		border-bottom: none;
	}

	.search-result:hover,
	.search-result.selected {
		background: #252525;
	}

	.meal-name {
		font-size: 0.95rem;
		font-weight: 500;
	}

	.meal-count {
		font-size: 0.75rem;
		color: #666;
		font-weight: 600;
		background: #111;
		padding: 2px 8px;
		border-radius: 12px;
		letter-spacing: 0.5px;
	}

	.search-result.selected .meal-count {
		color: #4ade80;
	}

	.audio-visualizer {
		position: absolute;
		left: 0;
		right: 0;
		top: 50%;
		transform: translateY(-50%);
		height: 48px;
		padding: 0 12px;
		display: flex;
		flex-direction: row-reverse;
		justify-content: flex-start;
		gap: 3px;
		align-items: center;
		pointer-events: none;
		z-index: 1;
		overflow: hidden;
	}

	.audio-bar {
		width: 3px;
		flex-shrink: 0;
		background: white;
		border-radius: 2px;
		transition: height 0.15s ease-out;
		min-height: 1px;
		max-height: 48px;
	}

	.btn-spinner {
		width: 18px;
		height: 18px;
		border: 2px solid rgba(0, 0, 0, 0.1);
		border-radius: 50%;
		border-top-color: #000;
		animation: spin 0.6s linear infinite;
	}

	@keyframes spin {
		to {
			transform: rotate(360deg);
		}
	}

	.send-wrap {
		position: relative;
		width: 48px;
		height: 48px;
		display: inline-flex;
		align-items: center;
		justify-content: center;
		flex-shrink: 0;
	}
	.send-wrap :global(.send-btn) {
		width: 100%;
		height: 100%;
	}
	.send-ring {
		position: absolute;
		inset: 0;
		width: 100%;
		height: 100%;
		pointer-events: none;
		transform: rotate(-90deg);
	}
	.ring-bg {
		fill: none;
		stroke: rgba(255, 255, 255, 0.15);
		stroke-width: 2;
	}
	.ring-fg {
		fill: none;
		stroke: #4ade80;
		stroke-width: 2.5;
		stroke-linecap: round;
		transition: stroke-dashoffset 0.15s linear;
	}

	.attachment-row {
		display: flex;
		flex-wrap: wrap;
		gap: 8px;
		margin-top: 8px;
	}
	.thumb {
		position: relative;
		width: 64px;
		height: 64px;
		border-radius: 8px;
		overflow: hidden;
		background: #111;
		border: 1px solid #333;
		flex-shrink: 0;
	}
	.thumb.errored {
		border-color: #b04040;
	}
	.thumb img {
		width: 100%;
		height: 100%;
		object-fit: cover;
		display: block;
	}
	.thumb-progress {
		position: absolute;
		left: 0;
		bottom: 0;
		height: 3px;
		width: var(--p, 0%);
		background: #4ade80;
		transition: width 0.15s linear;
	}
	.thumb-err {
		position: absolute;
		inset: 0;
		display: flex;
		align-items: center;
		justify-content: center;
		background: rgba(0, 0, 0, 0.6);
		color: #ff8080;
		font-weight: 700;
	}
	.thumb-clear {
		position: absolute;
		top: 2px;
		right: 2px;
		width: 20px;
		height: 20px;
		display: flex;
		align-items: center;
		justify-content: center;
		border: none;
		background: rgba(0, 0, 0, 0.7);
		color: #fff;
		font-size: 1rem;
		line-height: 1;
		border-radius: 50%;
		cursor: pointer;
	}
	.thumb-clear:hover {
		background: rgba(0, 0, 0, 0.9);
	}

	.attachment-badge {
		display: inline-flex;
		align-items: center;
		gap: 8px;
		background: #1a1a1a;
		border: 1px solid #333;
		padding: 6px 12px;
		border-radius: 20px;
		margin-top: 6px;
		margin-right: 8px;
		font-size: 0.65rem;
		font-weight: 600;
		letter-spacing: 1px;
		color: #888;
		animation: fadeIn 0.3s ease-out;
	}

	.attachment-badge svg {
		color: #fff;
		opacity: 0.8;
	}

	.clear-btn {
		background: none;
		border: none;
		color: #555;
		font-size: 1.1rem;
		padding: 0 4px;
		cursor: pointer;
		line-height: 1;
		transition: color 0.2s;
		margin-left: 4px;
	}

	.clear-btn:hover {
		color: #ff5555;
	}

	@keyframes fadeIn {
		from {
			opacity: 0;
			transform: translateY(5px);
		}
		to {
			opacity: 1;
			transform: translateY(0);
		}
	}
</style>
