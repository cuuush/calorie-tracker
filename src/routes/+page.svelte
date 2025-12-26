<script>
	import { onMount } from 'svelte';
	import { goto } from '$app/navigation';
	import { marked } from 'marked';
	import StatsCard from '$lib/components/StatsCard.svelte';
	import LoadingSkeleton from '$lib/components/LoadingSkeleton.svelte';

	let { data } = $props();

	// View State
	let currentView = $state('track');
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
		weeklyData: [],
		weeklyProteinData: []
	});

	onMount(async () => {
		setDynamicPlaceholder();
		await loadStats();
	});

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
			goto('/history');
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
			todayEntries.forEach((e) => {
				const h = new Date(e.timestamp).getHours();
				if (h >= 4 && h < 11) groups['BREAKFAST'] += e.total_calories;
				else if (h >= 11 && h < 16) groups['LUNCH'] += e.total_calories;
				else if (h >= 16 && h < 22) groups['DINNER'] += e.total_calories;
				else groups['SNACK'] += e.total_calories;
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
		<div style="display: flex; justify-content: space-between; align-items: center;">
			<h1>TRACKER</h1>
			<div class="header-actions">
				<button class="icon-btn" onclick={() => goto('/history')} title="View History">
					<svg
						width="20"
						height="20"
						viewBox="0 0 24 24"
						fill="none"
						stroke="currentColor"
						stroke-width="2"
					>
						<circle cx="12" cy="12" r="10" />
						<polyline points="12 6 12 12 16 14" />
					</svg>
				</button>
				<button class="icon-btn" onclick={() => goto('/settings')} title="Settings">
					<svg
						width="20"
						height="20"
						viewBox="0 0 24 24"
						fill="none"
						stroke="currentColor"
						stroke-width="2"
					>
						<circle cx="12" cy="12" r="3" />
						<path
							d="M12 1v6m0 6v6m9-9h-6m-6 0H3m15.364 6.364l-4.243-4.243m-6.242 0L3.636 17.364m12.728 0l-4.243-4.243m-6.242 0L3.636 6.636"
						/>
					</svg>
				</button>
				<button class="logout-btn" onclick={logout}>LOGOUT</button>
			</div>
		</div>
	</header>

	<!-- TRACK VIEW -->
	{#if currentView === 'track'}
		<div id="trackView">
			<input
				type="file"
				bind:this={fileInput}
				hidden
				accept="image/*"
				onchange={(e) => (selectedFile = e.target.files[0])}
			/>
			<div class="chat-bar">
				<div class="input-wrapper">
					<input
						type="text"
						bind:value={userMessage}
						class="chat-input"
						placeholder={isRecording ? '' : placeholder}
						disabled={isAiLoading}
						onkeypress={(e) => e.key === 'Enter' && analyze()}
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
					<svg
						width="20"
						height="20"
						viewBox="0 0 24 24"
						fill="none"
						stroke="currentColor"
						stroke-width="2"
						stroke-linecap="round"
						stroke-linejoin="round"
					>
						<path
							d="M23 19a2 2 0 0 1-2 2H3a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h4l2-3h6l2 3h4a2 2 0 0 1 2 2z"
						/>
						<circle cx="12" cy="13" r="4" />
					</svg>
				</button>
				<button class="icon-btn {isRecording ? 'active' : ''}" onclick={toggleMic}>
					{#if isRecording}
						<svg width="20" height="20" viewBox="0 0 24 24" fill="currentColor">
							<rect x="6" y="6" width="12" height="12" rx="2" />
						</svg>
					{:else}
						<svg
							width="20"
							height="20"
							viewBox="0 0 24 24"
							fill="none"
							stroke="currentColor"
							stroke-width="2"
							stroke-linecap="round"
							stroke-linejoin="round"
						>
							<path d="M12 1a3 3 0 0 0-3 3v8a3 3 0 0 0 6 0V4a3 3 0 0 0-3-3z" />
							<path d="M19 10v2a7 7 0 0 1-14 0v-2" />
							<line x1="12" y1="19" x2="12" y2="23" />
							<line x1="8" y1="23" x2="16" y2="23" />
						</svg>
					{/if}
				</button>
				<button class="send-btn" onclick={analyze} disabled={isAiLoading}>
					{#if isAiLoading}
						<div class="btn-spinner"></div>
					{:else}
						<svg
							width="18"
							height="18"
							viewBox="0 0 24 24"
							fill="none"
							stroke="currentColor"
							stroke-width="2.5"
							stroke-linecap="round"
							stroke-linejoin="round"
						>
							<line x1="22" y1="2" x2="11" y2="13"></line>
							<polygon points="22 2 15 22 11 13 2 9 22 2"></polygon>
						</svg>
					{/if}
				</button>
			</div>
			{#if selectedFile}
				<div class="attachment-badge">
					<svg
						width="14"
						height="14"
						viewBox="0 0 24 24"
						fill="none"
						stroke="currentColor"
						stroke-width="2.5"
						stroke-linecap="round"
						stroke-linejoin="round"
					>
						<path
							d="M23 19a2 2 0 0 1-2 2H3a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h4l2-3h6l2 3h4a2 2 0 0 1 2 2z"
						/>
						<circle cx="12" cy="13" r="4" />
					</svg>
					<span>IMAGE ATTACHED</span>
					<button class="clear-btn" onclick={() => (selectedFile = null)} title="Remove image"
						>&times;</button
					>
				</div>
			{/if}
			{#if selectedAudio}
				<div class="attachment-badge">
					<svg
						width="14"
						height="14"
						viewBox="0 0 24 24"
						fill="none"
						stroke="currentColor"
						stroke-width="2.5"
						stroke-linecap="round"
						stroke-linejoin="round"
					>
						<path d="M12 1a3 3 0 0 0-3 3v8a3 3 0 0 0 6 0V4a3 3 0 0 0-3-3z" />
						<path d="M19 10v2a7 7 0 0 1-14 0v-2" />
					</svg>
					<span>AUDIO ATTACHED</span>
					<button class="clear-btn" onclick={() => (selectedAudio = null)} title="Remove audio"
						>&times;</button
					>
				</div>
			{/if}

			<!-- STATS -->
			<div id="statsView" style="margin-top: 30px;">
				{#if !proteinFocused}
					<div class="stats-card" style="margin: 0; padding: 0; background: transparent; border: none;">
						<div style="display: flex; justify-content: space-between; align-items: baseline;">
							{#if statsLoading}
								<LoadingSkeleton width="120px" height="20px" />
								<LoadingSkeleton width="150px" height="20px" />
							{:else}
								<span class="day-title">DAILY BUDGET</span>
								<span class="day-summary"
									>{Math.round(statsData.todayTotal)} / {dailyBudget} CAL</span
								>
							{/if}
						</div>
						{#if statsLoading}
							<LoadingSkeleton width="100%" height="40px" borderRadius="12px" />
						{:else}
							<div class="progress-container" style="display: flex;">
								{#each ['BREAKFAST', 'LUNCH', 'DINNER', 'SNACK'] as type}
									{#if statsData.groups[type] > 0}
										<div
											style="width: {(statsData.groups[type] / dailyBudget) *
												100}%; background: {{
												BREAKFAST: '#B5EAD7',
												LUNCH: '#FFD3B6',
												DINNER: '#C7CEEA',
												SNACK: '#FDE2E4'
											}[type]}; height: 100%;"
										></div>
									{/if}
								{/each}
							</div>
							<div style="display: flex; justify-content: space-between; margin-bottom: 20px;">
								<div
									style="display:flex; gap:10px; font-size: 0.6rem; color: #666; text-transform: uppercase;"
								>
									<span style="color:#B5EAD7">Breakfast</span>
									<span style="color:#FFD3B6">Lunch</span>
									<span style="color:#C7CEEA">Dinner</span>
									<span style="color:#FDE2E4">Snack</span>
								</div>
								<span class="stat-label"
									>{Math.round(Math.max(dailyBudget - statsData.todayTotal, 0))} REMAINING</span
								>
							</div>
						{/if}
					</div>
				{/if}

				<div
					class="stats-card"
					style="margin: 0; padding: 0; background: transparent; border: none; margin-top: {proteinFocused
						? '0'
						: '30px'};"
				>
					<div style="display: flex; justify-content: space-between; align-items: baseline;">
						{#if statsLoading}
							<LoadingSkeleton width="120px" height="20px" />
							<LoadingSkeleton width="150px" height="20px" />
						{:else}
							<span class="day-title">PROTEIN GOAL</span>
							<span class="day-summary"
								>{Math.round(statsData.todayProtein)}g / {proteinGoal}g</span
							>
						{/if}
					</div>
					{#if statsLoading}
						<LoadingSkeleton width="100%" height="40px" borderRadius="12px" />
					{:else}
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
					{/if}
				</div>

				{#if statsLoading}
					<div class="stats-grid">
						<LoadingSkeleton width="100%" height="80px" />
						<LoadingSkeleton width="100%" height="80px" />
					</div>
				{:else}
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
				{/if}

				{#if statsLoading}
					<LoadingSkeleton width="100%" height="150px" />
				{:else}
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
				{/if}
			</div>
		</div>
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
								<svg
									width="18"
									height="18"
									viewBox="0 0 24 24"
									fill="none"
									stroke="currentColor"
									stroke-width="2.5"
									stroke-linecap="round"
									stroke-linejoin="round"
								>
									<line x1="22" y1="2" x2="11" y2="13"></line>
									<polygon points="22 2 15 22 11 13 2 9 22 2"></polygon>
								</svg>
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
						<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
							<circle cx="12" cy="12" r="10" />
							<polyline points="12 6 12 12 16 14" />
						</svg>
						Change Meal Time
						<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
							<polyline points="{showTimeSelector ? '18 15 12 9 6 15' : '6 9 12 15 18 9'}" />
						</svg>
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
</style>
