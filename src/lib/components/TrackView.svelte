<script>
	import { Camera, Mic, Square, Send } from 'lucide-svelte';
	import DailyStats from './DailyStats.svelte';

	let {
		userMessage = $bindable(),
		selectedFile = $bindable(),
		selectedAudio = $bindable(),
		isRecording = $bindable(),
		isAiLoading,
		placeholder,
		audioLevels,
		statsData,
		statsLoading,
		dailyBudget,
		proteinGoal,
		proteinFocused,
		onAnalyze,
		onToggleMic,
		onFileSelect
	} = $props();

	let fileInput = $state(null);
</script>

<div id="trackView">
	<input
		type="file"
		bind:this={fileInput}
		hidden
		accept="image/*"
		onchange={(e) => onFileSelect(e.target.files[0])}
	/>
	<div class="chat-bar">
		<div class="input-wrapper">
			<input
				type="text"
				bind:value={userMessage}
				class="chat-input"
				placeholder={isRecording ? '' : placeholder}
				disabled={isAiLoading}
				onkeypress={(e) => e.key === 'Enter' && onAnalyze()}
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
		<button class="send-btn" onclick={onAnalyze} disabled={isAiLoading}>
			{#if isAiLoading}
				<div class="btn-spinner"></div>
			{:else}
				<Send size={18} />
			{/if}
		</button>
	</div>
	{#if selectedFile}
		<div class="attachment-badge">
			<Camera size={14} strokeWidth={2.5} />
			<span>IMAGE ATTACHED</span>
			<button class="clear-btn" onclick={() => (selectedFile = null)} title="Remove image"
				>&times;</button
			>
		</div>
	{/if}
	{#if selectedAudio}
		<div class="attachment-badge">
			<Mic size={14} strokeWidth={2.5} />
			<span>AUDIO ATTACHED</span>
			<button class="clear-btn" onclick={() => (selectedAudio = null)} title="Remove audio"
				>&times;</button
			>
		</div>
	{/if}

	<!-- STATS -->
	<DailyStats {statsData} {statsLoading} {dailyBudget} {proteinGoal} {proteinFocused} />
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

	.attachment-badge {
		display: inline-flex;
		align-items: center;
		gap: 8px;
		background: #1a1a1a;
		border: 1px solid #333;
		padding: 6px 12px;
		border-radius: 20px;
		margin-top: 15px;
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
