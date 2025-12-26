<script>
	import { onMount } from 'svelte';
	import { goto } from '$app/navigation';
	import { marked } from 'marked';
	import { Settings, Clock, Send, ChevronDown, ChevronUp } from 'lucide-svelte';
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

	// Stats State
	let settings = $state({});
	let statsLoading = $state(true);
	let dailyBudget = $derived(settings.maintenance_calories || 2000);
	let proteinGoal = $derived(settings.protein_goal || 150);
	let proteinFocused = $derived(settings.protein_focused_mode === 1);
	let statsData = $state({
		todayTotal: 0,
		todayProtein: 0,
		groups: {},
		proteinGroups: {},
		weeklyData: [],
		weeklyProteinData: []
	});

	// History State
	let historyLoading = $state(true);
	let history = $state([]);

	onMount(async () => {
		setDynamicPlaceholder();
		await loadStats();
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
			return customMealTime;
		} else if (selectedMealPeriod === 'current') {
			return new Date().toISOString();
		} else {
			// Set time based on meal period
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

	// --- STATS ---
	async function loadStats() {
		statsLoading = true;
		try {
			const [hRes, sRes] = await Promise.all([fetch('/api/history'), fetch('/api/settings')]);
			const entries = await hRes.json();
			settings = await sRes.json();

			const todayStr = new Date().toLocaleDateString();
			const todayEntries = entries.filter(
				(e) => new Date(e.timestamp).toLocaleDateString() === todayStr
			);

			const groups = { BREAKFAST: 0, LUNCH: 0, DINNER: 0, SNACK: 0 };
			const proteinGroups = { BREAKFAST: 0, LUNCH: 0, DINNER: 0, SNACK: 0 };
			todayEntries.forEach((e) => {
				const h = new Date(e.timestamp).getHours();
				let mealType;
				if (h >= 4 && h < 11) mealType = 'BREAKFAST';
				else if (h >= 11 && h < 16) mealType = 'LUNCH';
				else if (h >= 16 && h < 22) mealType = 'DINNER';
				else mealType = 'SNACK';

				groups[mealType] += e.total_calories;
				proteinGroups[mealType] += e.total_protein || 0;
			});

			const startOfWeek = new Date();
			startOfWeek.setDate(startOfWeek.getDate() - startOfWeek.getDay());
			startOfWeek.setHours(0, 0, 0, 0);

			const weeklyData = [0, 0, 0, 0, 0, 0, 0];
			const weeklyProteinData = [0, 0, 0, 0, 0, 0, 0];
			entries.forEach((e) => {
				const d = new Date(e.timestamp);
				if (d >= startOfWeek) {
					weeklyData[d.getDay()] += e.total_calories;
					weeklyProteinData[d.getDay()] += e.total_protein;
				}
			});

			statsData = {
				todayTotal: todayEntries.reduce((s, e) => s + e.total_calories, 0),
				todayProtein: todayEntries.reduce((s, e) => s + e.total_protein, 0),
				groups,
				proteinGroups,
				weeklyData,
				weeklyProteinData
			};
		} finally {
			statsLoading = false;
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
				<button class="icon-btn settings-btn" onclick={() => goto('/settings')} title="Settings">
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
				<Clock size={16} />
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
				{statsLoading}
				{dailyBudget}
				{proteinGoal}
				{proteinFocused}
				onAnalyze={analyze}
				onToggleMic={toggleMic}
				onFileSelect={(file) => selectedFile = file}
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
								<input
									type="checkbox"
									checked={selectedItems.includes(i)}
									onchange={() => toggleItem(i)}
								/>
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
				</div>

				<!-- Meal Time Selector -->
				<div class="meal-time-selector" style="margin-top: 20px;">
					<button
						class="time-selector-btn"
						onclick={() => (showTimeSelector = !showTimeSelector)}
					>
						<Clock size={16} />
						Change Meal Time
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
								}}
							>
								Now ({new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })})
							</button>
							<button
								class="time-option {selectedMealPeriod === 'breakfast' ? 'active' : ''}"
								onclick={() => {
									selectedMealPeriod = 'breakfast';
									customMealTime = null;
								}}
							>
								Breakfast (8:00 AM)
							</button>
							<button
								class="time-option {selectedMealPeriod === 'lunch' ? 'active' : ''}"
								onclick={() => {
									selectedMealPeriod = 'lunch';
									customMealTime = null;
								}}
							>
								Lunch (1:00 PM)
							</button>
							<button
								class="time-option {selectedMealPeriod === 'dinner' ? 'active' : ''}"
								onclick={() => {
									selectedMealPeriod = 'dinner';
									customMealTime = null;
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

	.meal-time-selector {
		background: #0a0a0a;
		border-radius: 8px;
		padding: 0.75rem;
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

	/* Logout Button */
	.logout-btn {
		background: transparent;
		border: 1px solid var(--border);
		color: white;
		padding: 0.5rem 1rem;
		border-radius: 8px;
		cursor: pointer;
		transition: all 0.2s;
		font-size: 0.75rem;
		font-weight: 600;
		letter-spacing: 1px;
		height: 40px;
		display: flex;
		align-items: center;
	}

	.logout-btn:hover {
		background: var(--surface);
		border-color: #333;
	}

	/* Settings Button (Gray) */
	.settings-btn {
		color: #666 !important;
	}

	.settings-btn:hover {
		color: #aaa !important;
	}

	/* History View */
	#historyView {
		animation: fadeIn 0.3s ease-out;
	}

	.loading-state {
		display: flex;
		flex-direction: column;
		gap: 1.5rem;
	}

	.empty-state {
		text-align: center;
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

	/* Pie Charts */
	.pie-charts-container {
		display: grid;
		grid-template-columns: 1fr 1fr;
		gap: 1.5rem;
		margin-top: 2rem;
		margin-bottom: 1rem;
	}

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

	/* Color Key */
	.color-key {
		display: flex;
		justify-content: center;
		gap: 1.5rem;
		margin-top: 1rem;
		padding: 0.75rem;
		background: var(--surface);
		border: 1px solid var(--border);
		border-radius: 8px;
	}

	.key-item {
		display: flex;
		align-items: center;
		gap: 0.5rem;
	}

	.key-color {
		width: 12px;
		height: 12px;
		border-radius: 3px;
		border: 1px solid rgba(0, 0, 0, 0.3);
	}

	.key-item span {
		font-size: 0.7rem;
		color: #888;
		text-transform: uppercase;
		letter-spacing: 0.05em;
	}
</style>
