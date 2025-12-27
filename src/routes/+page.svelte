<script>
	import { onMount } from 'svelte';
	import { goto } from '$app/navigation';
	import { marked } from 'marked';
	import { Settings, Clock, Send, ChevronDown, ChevronUp, Square, CheckSquare } from 'lucide-svelte';
	import TrackView from '$lib/components/TrackView.svelte';
	import HistoryView from '$lib/components/HistoryView.svelte';

	let { data } = $props();

	// View State
	let currentView = $state('track');
	let currentTab = $state('track'); // 'track' or 'history'
	let isLoading = $state(false);
	let isAiLoading = $state(false);

	// Track State
	let userMessage = $state('');
	let fileInput = $state(null);
	let selectedFile = $state(null);
	let selectedAudio = $state(null);
	let isRecording = $state(false);
	let mediaRecorder;
	let audioChunks = [];
	let audioLevels = $state([]);
	let audioContext;
	let audioAnalyser;
	let audioAnimationFrame;
	let audioFrameCount = 0;

	// Result State
	let currentAnalysis = $state(null);
	let selectedItems = $state([]);
	let customMealTime = $state(null);
	let showTimeSelector = $state(false);
	let selectedMealPeriod = $state('current'); // 'breakfast', 'lunch', 'dinner', 'custom', 'current'
	let resultTotalCal = $derived(
		selectedItems.reduce((sum, idx) => sum + (currentAnalysis?.items[idx]?.calories || 0), 0)
	);
	let resultTotalProt = $derived(
		selectedItems.reduce((sum, idx) => sum + (currentAnalysis?.items[idx]?.protein || 0), 0)
	);

	// Stats State - Initialize from server-rendered data
	let settings = $state(data.settings || {});
	let dailyBudget = $derived(settings.maintenance_calories || 2000);
	let proteinGoal = $derived(settings.protein_goal || 150);
	let proteinFocused = $derived(settings.protein_focused_mode === 1);
	let statsData = $state(data.stats || {
		todayTotal: 0,
		todayProtein: 0,
		groups: { BREAKFAST: 0, LUNCH: 0, DINNER: 0, SNACK: 0 },
		proteinGroups: { BREAKFAST: 0, LUNCH: 0, DINNER: 0, SNACK: 0 },
		weeklyData: [0, 0, 0, 0, 0, 0, 0],
		weeklyProteinData: [0, 0, 0, 0, 0, 0, 0]
	});

	// History State
	let historyLoading = $state(true);
	let history = $state([]);

	onMount(() => {
		setDynamicPlaceholder();
		// Stats already loaded server-side via +page.server.js - no fetch needed!
	});

	// Load history when switching to history tab
	$effect(() => {
		if (currentTab === 'history' && history.length === 0) {
			loadHistory();
		}
	});

	async function loadHistory() {
		historyLoading = true;
		try {
			const response = await fetch('/api/history');
			if (response.ok) {
				history = await response.json();
			}
		} catch (error) {
			console.error('Failed to load history:', error);
		} finally {
			historyLoading = false;
		}
	}

	async function deleteEntry(id) {
		try {
			const response = await fetch(`/api/entry/${id}`, { method: 'DELETE' });
			if (response.ok) {
				history = history.filter(entry => entry.id !== id);
				// Reload stats to reflect the deletion
				await loadStats();
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

	let historyGroups = $derived(groupHistory(history));

	function setDynamicPlaceholder() {
		const hour = new Date().getHours();
		let meal = 'meal';
		if (hour >= 4 && hour < 11) meal = 'breakfast';
		else if (hour >= 11 && hour < 16) meal = 'lunch';
		else if (hour >= 16 && hour < 22) meal = 'dinner';
		else return 'late night snack?';
		return `What's for ${meal}?`;
	}
	let placeholder = $state(setDynamicPlaceholder());

	async function logout() {
		if (!confirm('Are you sure you want to log out?')) return;
		await fetch('/auth/logout', { method: 'POST' });
		window.location.href = '/login';
	}

	// --- AUDIO VISUALIZATION ---
	function analyzeAudio() {
		if (!audioAnalyser) return;

		const dataArray = new Uint8Array(audioAnalyser.frequencyBinCount);
		audioAnalyser.getByteFrequencyData(dataArray);

		const average = dataArray.reduce((a, b) => a + b) / dataArray.length;
		const level = Math.min(100, Math.max(10, (average / 255) * 250));

		audioFrameCount++;
		if (audioFrameCount >= 6) {
			audioLevels = [level, ...audioLevels.slice(0, 69)];
			audioFrameCount = 0;
		}

		audioAnimationFrame = requestAnimationFrame(analyzeAudio);
	}

	async function toggleMic() {
		if (!isRecording) {
			try {
				const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
				mediaRecorder = new MediaRecorder(stream);
				audioChunks = [];
				mediaRecorder.ondataavailable = (e) => audioChunks.push(e.data);
				mediaRecorder.onstop = async () => {
					const blob = new Blob(audioChunks, { type: 'audio/wav' });
					selectedAudio = blob;
				};
				mediaRecorder.start();

				audioContext = new AudioContext();
				const source = audioContext.createMediaStreamSource(stream);
				audioAnalyser = audioContext.createAnalyser();
				audioAnalyser.fftSize = 256;
				source.connect(audioAnalyser);
				audioLevels = [];
				audioFrameCount = 0;
				analyzeAudio();

				isRecording = true;
			} catch (err) {
				alert('Mic access required');
			}
		} else {
			mediaRecorder.stop();
			isRecording = false;
			placeholder = setDynamicPlaceholder();

			if (audioAnimationFrame) {
				cancelAnimationFrame(audioAnimationFrame);
				audioAnimationFrame = null;
			}
			if (audioContext) {
				audioContext.close();
				audioContext = null;
			}
			audioAnalyser = null;
			audioLevels = [];
			audioFrameCount = 0;
		}
	}

	async function analyze() {
		if (isRecording && mediaRecorder && mediaRecorder.state === 'recording') {
			await new Promise((resolve) => {
				const originalOnStop = mediaRecorder.onstop;
				mediaRecorder.onstop = async () => {
					const blob = new Blob(audioChunks, { type: 'audio/wav' });
					selectedAudio = blob;
					if (originalOnStop) await originalOnStop();
					resolve();
				};
				mediaRecorder.stop();
			});

			isRecording = false;
			placeholder = setDynamicPlaceholder();
			if (audioAnimationFrame) {
				cancelAnimationFrame(audioAnimationFrame);
				audioAnimationFrame = null;
			}
			if (audioContext) {
				audioContext.close();
				audioContext = null;
			}
			audioAnalyser = null;
			audioLevels = [];
			audioFrameCount = 0;
		}

		if (!selectedFile && !userMessage && !selectedAudio)
			return alert('Provide image, text, or audio');
		isAiLoading = true;
		const formData = new FormData();
		if (selectedFile) formData.append('image', selectedFile);
		if (selectedAudio) formData.append('audio', selectedAudio);
		formData.append('message', userMessage);

		try {
			const res = await fetch('/api/analyze', { method: 'POST', body: formData });
			const data = await res.json();
			currentAnalysis = data;
			selectedItems = data.items.map((_, i) => i);
			userMessage = '';
			selectedFile = null;
			selectedAudio = null;
			currentView = 'result';
		} finally {
			isAiLoading = false;
		}
	}

	// --- RESULT ---
	function toggleItem(index) {
		if (selectedItems.includes(index)) {
			selectedItems = selectedItems.filter((i) => i !== index);
		} else {
			selectedItems = [...selectedItems, index];
		}
	}

	function getMealTime() {
		if (selectedMealPeriod === 'custom' && customMealTime) {
			// Convert datetime-local string to ISO string
			return new Date(customMealTime).toISOString();
		} else if (selectedMealPeriod === 'current') {
			return new Date().toISOString();
		} else {
			// Set time based on meal period (breakfast, lunch, dinner)
			const now = new Date();
			const mealTimes = {
				breakfast: 8,
				lunch: 13,
				dinner: 19
			};
			now.setHours(mealTimes[selectedMealPeriod] || now.getHours(), 0, 0, 0);
			return now.toISOString();
		}
	}

	async function commitAnalysis() {
		isLoading = true;
		const finalItems = selectedItems.map((idx) => currentAnalysis.items[idx]);
		const timestamp = getMealTime();
		const entry = {
			...currentAnalysis,
			items: finalItems,
			timestamp,
			total_calories: finalItems.reduce((s, i) => s + i.calories, 0),
			total_protein: Math.round(finalItems.reduce((s, i) => s + i.protein, 0)),
			total_carbs: finalItems.reduce((s, i) => s + i.carbs, 0)
		};

		try {
			await fetch('/api/entry', {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify(entry)
			});
			// Reset meal time selection
			selectedMealPeriod = 'current';
			customMealTime = null;
			// Reload data
			await loadStats();
			history = []; // Reset history so it reloads when switching to history tab
			// Switch back to track view
			currentView = 'track';
			currentTab = 'track';
		} catch (e) {
			alert('Save failed');
		} finally {
			isLoading = false;
		}
	}

	async function handleFollowup(message) {
		if (!message) return;
		isAiLoading = true;
		try {
			const res = await fetch('/api/followup', {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({
					messages: currentAnalysis.messages,
					message
				})
			});
			const data = await res.json();
			if (data.updatedEntry) {
				currentAnalysis = {
					...currentAnalysis,
					...data.updatedEntry,
					reasoning: data.reasoning || currentAnalysis.reasoning,
					messages: data.messages
				};
				selectedItems = currentAnalysis.items.map((_, i) => i);
			} else {
				currentAnalysis.messages = data.messages;
			}
		} catch (e) {
			console.error(e);
		} finally {
			isAiLoading = false;
		}
	}

	function handleMealSelect(meal) {
		// Parse items from JSON string
		const items = JSON.parse(meal.items);

		// Create analysis object from the selected meal
		currentAnalysis = {
			meal_title: meal.meal_title,
			user_message: meal.user_message || '',
			items: items,
			messages: [],
			reasoning: 'Previously logged meal'
		};

		// Select all items by default
		selectedItems = items.map((_, i) => i);

		// Navigate to result view
		currentView = 'result';
	}

	// --- STATS ---
	// Refresh stats from API (used after adding/deleting meals, not on initial load)
	async function loadStats() {
		try {
			const statsRes = await fetch('/api/stats');
			statsData = await statsRes.json();
		} catch (error) {
			console.error('Failed to load stats:', error);
		}
	}
</script>

{#if isLoading}
	<div id="loadingOverlay" style="display: flex;">
		<div class="spinner"></div>
	</div>
{/if}

<div class="container">
	<header>
		<div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 1rem;">
			<h1>TRACKER</h1>
			<div class="header-actions">
				<button class="settings-btn" onclick={() => goto('/settings')} title="Settings">
					<Settings size={20} />
				</button>
				<button class="logout-btn" onclick={logout}>LOGOUT</button>
			</div>
		</div>
		<div class="tab-bar">
			<button class="tab {currentTab === 'track' ? 'active' : ''}" onclick={() => currentTab = 'track'}>
				TRACK
			</button>
			<button class="tab {currentTab === 'history' ? 'active' : ''}" onclick={() => currentTab = 'history'}>
				HISTORY
			</button>
		</div>
	</header>

	<!-- TRACK TAB -->
	{#if currentTab === 'track'}
		{#if currentView === 'track'}
			<TrackView
				bind:userMessage
				bind:selectedFile
				bind:selectedAudio
				bind:isRecording
				{isAiLoading}
				{placeholder}
				{audioLevels}
				{statsData}
				{dailyBudget}
				{proteinGoal}
				{proteinFocused}
				onAnalyze={analyze}
				onToggleMic={toggleMic}
				onFileSelect={(file) => selectedFile = file}
				onMealSelect={handleMealSelect}
			/>
		{/if}
	{/if}

	<!-- RESULT VIEW -->
	{#if currentView === 'result' && currentAnalysis}
		<div id="resultView">
			<div class="day-header" style="margin-top: 0;">
				<span class="day-title">ANALYSIS RESULT</span>
			</div>
			<div class="entry-card" style="opacity: 1; margin-top: 20px;">
				<div class="entry-main">
					<div class="entry-info">
						<h3 style="font-size: 1.4rem; margin-bottom: 5px;">
							{currentAnalysis.meal_title || currentAnalysis.user_message || 'Meal Analysis'}
						</h3>
						<p style="color: #666; font-size: 0.8rem;">
							{new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
						</p>
					</div>
					<div class="entry-macros">
						{#if !proteinFocused}
							<div class="macro-row">
								<span class="macro-detail">CAL</span><span
									class="macro-total"
									style="font-size: 1.2rem;">{Math.round(resultTotalCal)}</span
								>
							</div>
						{/if}
						<div class="macro-row">
							<span class="macro-detail">PROT</span><span
								class="macro-total"
								style="font-size: {proteinFocused ? '1.2rem' : '0.9rem'}; color: {proteinFocused
									? 'white'
									: '#aaa'};">{Math.round(resultTotalProt)}</span
							>
						</div>
					</div>
				</div>

				<div style="margin-top: 30px; border-top: 1px solid #333; padding-top: 20px;">
					{#each currentAnalysis.items as item, i}
						<div class="item-row" style="animation: fadeIn 0.5s forwards {i * 0.1}s;">
							<div class="item-left">
								<button class="custom-checkbox" onclick={() => toggleItem(i)}>
									{#if selectedItems.includes(i)}
										<CheckSquare size={20} />
									{:else}
										<Square size={20} />
									{/if}
								</button>
								<span class="item-name">{item.name}</span>
							</div>
							<div class="item-macros">
								<span>{item.protein || 0}g P</span>
								{#if !proteinFocused}
									<span>{item.calories} CAL</span>
								{/if}
							</div>
						</div>
					{/each}
				</div>

				{#if currentAnalysis.reasoning}
					<details class="reasoning-details" style="margin-top: 20px;">
						<summary>VIEW REASONING</summary>
						<div class="reasoning-content">{@html marked.parse(currentAnalysis.reasoning)}</div>
					</details>
				{/if}

				<div
					class="detail-view"
					style="display: block; margin-top: 30px; padding: 20px; background: #111; border-radius: 8px;"
				>
					<div class="chat-bar" style="margin-top: 0;">
						<input
							type="text"
							class="chat-input"
							placeholder="WANT TO CHANGE SOMETHING?..."
							disabled={isAiLoading}
							onkeypress={(e) => {
								if (e.key === 'Enter') {
									handleFollowup(e.target.value);
									e.target.value = '';
								}
							}}
						/>
						<button
							class="send-btn"
							onclick={(e) => {
								const input = e.currentTarget.previousElementSibling;
								handleFollowup(input.value);
								input.value = '';
							}}
							disabled={isAiLoading}
						>
							{#if isAiLoading}
								<div class="btn-spinner"></div>
							{:else}
								<Send size={18} />
							{/if}
						</button>
					</div>

				<!-- Meal Time Selector -->
				<div style="margin-top: 20px;">
					<button
						class="time-selector-btn"
						onclick={() => (showTimeSelector = !showTimeSelector)}
					>
						<Clock size={16} />
						CHANGE MEAL TIME
						{#if showTimeSelector}
							<ChevronUp size={12} />
						{:else}
							<ChevronDown size={12} />
						{/if}
					</button>

					{#if showTimeSelector}
						<div class="time-options">
							<button
								class="time-option {selectedMealPeriod === 'current' ? 'active' : ''}"
								onclick={() => {
									selectedMealPeriod = 'current';
									customMealTime = null;
									showTimeSelector = false;
								}}
							>
								Now ({new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })})
							</button>
							<button
								class="time-option {selectedMealPeriod === 'breakfast' ? 'active' : ''}"
								onclick={() => {
									selectedMealPeriod = 'breakfast';
									customMealTime = null;
									showTimeSelector = false;
								}}
							>
								Breakfast (8:00 AM)
							</button>
							<button
								class="time-option {selectedMealPeriod === 'lunch' ? 'active' : ''}"
								onclick={() => {
									selectedMealPeriod = 'lunch';
									customMealTime = null;
									showTimeSelector = false;
								}}
							>
								Lunch (1:00 PM)
							</button>
							<button
								class="time-option {selectedMealPeriod === 'dinner' ? 'active' : ''}"
								onclick={() => {
									selectedMealPeriod = 'dinner';
									customMealTime = null;
									showTimeSelector = false;
								}}
							>
								Dinner (7:00 PM)
							</button>
							<button
								class="time-option {selectedMealPeriod === 'custom' ? 'active' : ''}"
								onclick={() => (selectedMealPeriod = 'custom')}
							>
								Custom Time
							</button>

							{#if selectedMealPeriod === 'custom'}
								<input
									type="datetime-local"
									class="custom-time-input"
									bind:value={customMealTime}
									max={new Date().toISOString().slice(0, 16)}
								/>
							{/if}
						</div>
					{/if}
				</div>

				</div>



				<button
					onclick={commitAnalysis}
					style="margin-top: 30px; width: 100%; padding: 15px; background: white; color: black; border: none; text-transform: uppercase; letter-spacing: 2px; font-weight: 600; cursor: pointer;"
				>
					Save Entry
				</button>
			</div>
		</div>
	{/if}

	<!-- HISTORY TAB -->
	{#if currentTab === 'history'}
		<HistoryView
			{historyGroups}
			{historyLoading}
			{proteinFocused}
			onDeleteEntry={deleteEntry}
		/>
	{/if}
</div>

<style>


	.spinner {
		width: 40px;
		height: 40px;
		border: 3px solid rgba(255, 255, 255, 0.1);
		border-radius: 50%;
		border-top-color: #fff;
		animation: spin 1s ease-in-out infinite;
	}
	@keyframes spin {
		to {
			transform: rotate(360deg);
		}
	}

	#loadingOverlay {
		position: fixed;
		top: 0;
		left: 0;
		width: 100%;
		height: 100%;
		background: rgba(0, 0, 0, 0.8);
		z-index: 9999;
		justify-content: center;
		align-items: center;
		padding: 20px;
	}

	.btn-spinner {
		width: 18px;
		height: 18px;
		border: 2px solid rgba(0, 0, 0, 0.1);
		border-radius: 50%;
		border-top-color: #000;
		animation: spin 0.6s linear infinite;
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

	.header-actions {
		display: flex;
		gap: 0.75rem;
		align-items: center;
	}

	.icon-btn {
		background: transparent;
		border: 1px solid var(--border);
		color: var(--text);
		padding: 0.5rem;
		border-radius: 8px;
		cursor: pointer;
		transition: all 0.2s;
		display: flex;
		align-items: center;
		justify-content: center;
	}

	.icon-btn:hover {
		background: var(--surface);
		border-color: #333;
	}

	.time-selector-btn {
		background: transparent;
		border: 1px solid var(--border);
		color: var(--text);
		padding: 0.75rem 1rem;
		border-radius: 8px;
		cursor: pointer;
		transition: all 0.2s;
		width: 100%;
		display: flex;
		align-items: center;
		justify-content: center;
		gap: 0.5rem;
		font-size: 0.875rem;
	}

	.time-selector-btn:hover {
		background: #111;
		border-color: #333;
	}

	.time-options {
		margin-top: 0.75rem;
		display: flex;
		flex-direction: column;
		gap: 0.5rem;
		animation: fadeIn 0.2s ease-out;
	}

	.time-option {
		background: #111;
		border: 1px solid var(--border);
		color: var(--text);
		padding: 0.75rem;
		border-radius: 6px;
		cursor: pointer;
		transition: all 0.2s;
		font-size: 0.875rem;
		text-align: left;
	}

	.time-option:hover {
		background: #1a1a1a;
		border-color: #444;
	}

	.time-option.active {
		background: #1a1a1a;
		border-color: #4ade80;
		color: #4ade80;
	}

	.custom-time-input {
		background: #111;
		border: 1px solid var(--border);
		color: var(--text);
		padding: 0.75rem;
		border-radius: 6px;
		font-size: 0.875rem;
		width: 100%;
		margin-top: 0.5rem;
	}

	.custom-time-input:focus {
		outline: none;
		border-color: #4ade80;
	}

	/* Tab Bar */
	.tab-bar {
		display: flex;
		gap: 0.5rem;
		border-bottom: 2px solid var(--border);
		margin-bottom: 1.5rem;
	}

	.tab {
		flex: 1;
		background: transparent;
		border: none;
		color: #666;
		padding: 0.75rem 1rem;
		font-size: 0.875rem;
		font-weight: 600;
		text-transform: uppercase;
		letter-spacing: 1px;
		cursor: pointer;
		position: relative;
		transition: all 0.2s;
		display: flex;
		align-items: center;
		justify-content: center;
		gap: 0.5rem;
	}

	.tab:hover {
		color: #aaa;
	}

	.tab.active {
		color: white;
	}

	.tab.active::after {
		content: '';
		position: absolute;
		bottom: -2px;
		left: 0;
		right: 0;
		height: 2px;
		background: white;
	}

	.custom-checkbox {
		background: transparent;
		border: none;
		padding: 0;
		margin: 0;
		cursor: pointer;
		display: flex;
		align-items: center;
		justify-content: center;
		color: var(--text);
		transition: all 0.2s;
	}

	.custom-checkbox:hover {
		color: #4ade80;
		transform: scale(1.1);
	}

	.custom-checkbox:active {
		transform: scale(0.95);
	}







</style>
