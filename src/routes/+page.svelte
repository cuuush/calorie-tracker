<script>
	import { onMount } from 'svelte';
	import { goto } from '$app/navigation';
	import { marked } from 'marked';
	import { fade } from 'svelte/transition';
	import { Settings, Clock, Send, Square, CheckSquare, MessageSquare, ChevronLeft, ChevronRight } from 'lucide-svelte';
	import TrackView from '$lib/components/TrackView.svelte';
	import HistoryView from '$lib/components/HistoryView.svelte';
	import ChatView from '$lib/components/ChatView.svelte';
	import { toast } from '$lib/toast.svelte.js';
	import { fetchWithRetry } from '$lib/net.js';

	let { data } = $props();

	// View State
	let currentView = $state('track');
	let currentTab = $state('track'); // 'track' | 'history' | 'chat'
	let chatMessages = $state([]); // persists across tab switches
	let chatConversationId = $state(null); // server-side persistence id
	let isLoading = $state(false);
	let isAiLoading = $state(false);

	// Analyze flow state
	// 'idle' | 'loading' | 'clarifying' | 'rejected' | 'ready'
	let analyzePhase = $state('idle');
	let pendingClarification = $state(null);
	let analysisRejection = $state(null);
	let analyzeAbort = null;
	let otherInput = $state('');
	let showOtherInput = $state(false);

	// Edit-with-AI three-phase animation: idle → fading-out → loading → fading-in → idle
	let editPhase = $state('idle');
	let skeletonRowCount = $state(0);

	// Track State
	let userMessage = $state('');
	let selectedImages = $state([]); // [{ id, file, key?, mime?, progress, error?, thumb }]
	let selectedAudio = $state(null); // { blob, key?, mime?, progress, error?, uploading? } | null
	let isRecording = $state(false);
	let mediaRecorder;
	let mediaStream;
	let audioChunks = [];
	let audioLevels = $state([]);
	let audioContext;
	let audioAnalyser;
	let audioAnimationFrame;
	let audioFrameCount = 0;

	// Result State
	let currentAnalysis = $state(null);
	let currentEntryId = $state(null); // server-side row created at analyze-time
	let selectedItems = $state([]);
	let customHour = $state(null); // integer 0-23 when selectedMealPeriod === 'custom'
	let showTimeSelector = $state(false);
	let showFollowupPanel = $state(false);
	let selectedMealPeriod = $state('current'); // 'breakfast', 'lunch', 'dinner', 'custom', 'current'
	let selectedDate = $state(new Date()); // day for new meal — shift with arrows
	let resultTotalCal = $derived(
		selectedItems.reduce((sum, idx) => sum + (currentAnalysis?.items[idx]?.calories || 0), 0)
	);
	let resultTotalProt = $derived(
		selectedItems.reduce((sum, idx) => sum + (currentAnalysis?.items[idx]?.protein || 0), 0)
	);

	function fmtTime(date) {
		return date.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
	}

	function fmtHour12(h) {
		if (h === 0) return '12 AM';
		if (h === 12) return '12 PM';
		return h < 12 ? `${h} AM` : `${h - 12} PM`;
	}

	let displayMealTime = $derived.by(() => {
		if (selectedMealPeriod === 'custom' && customHour !== null) {
			return fmtHour12(customHour);
		}
		if (selectedMealPeriod === 'breakfast') return '8:00 AM';
		if (selectedMealPeriod === 'lunch') return '1:00 PM';
		if (selectedMealPeriod === 'dinner') return '7:00 PM';
		return fmtTime(new Date());
	});

	// Stats State - Initialize from server-rendered data
	// $derived so navigating back from /settings picks up the fresh load.
	let settings = $derived(data.settings || {});
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
		// Stats already loaded server-side via +page.server.js — but if the user's tz
		// differs from what the server used (e.g. first-ever visit before the tz cookie
		// was set), refetch with the correct local date so the pie charts populate.
		const clientTz = Intl.DateTimeFormat().resolvedOptions().timeZone;
		if (data.tz_used && data.tz_used !== clientTz) {
			loadStats();
		}
	});

	// Lock body scroll when chat tab is active so touch events hit
	// the chat message list instead of scrolling the outer page.
	$effect(() => {
		document.body.style.overflow = currentTab === 'chat' ? 'hidden' : '';
		return () => { document.body.style.overflow = ''; };
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
			const response = await fetchWithRetry('/api/history');
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
			const response = await fetchWithRetry(`/api/entry/${id}`, { method: 'DELETE' });
			if (response.ok) {
				history = history.filter(entry => entry.id !== id);
				// Reload stats to reflect the deletion
				await loadStats();
			}
		} catch (error) {
			console.error('Failed to delete entry:', error);
			toast('Failed to delete entry', { kind: 'error' });
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
					entries: [],
					totalCalories: 0,
					totalProtein: 0
				};
			}

			grouped[dateKey].entries.push(entry);
			grouped[dateKey].totalCalories += entry.total_calories || 0;
			grouped[dateKey].totalProtein += entry.total_protein || 0;
		}

		// Sort entries within each day by timestamp (earliest to latest)
		Object.values(grouped).forEach(day => {
			day.entries.sort((a, b) => new Date(a.timestamp) - new Date(b.timestamp));
		});

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

	function stopMicStream() {
		if (mediaStream) {
			mediaStream.getTracks().forEach((t) => t.stop());
			mediaStream = null;
		}
	}

	async function toggleMic() {
		if (!isRecording) {
			try {
				mediaStream = await navigator.mediaDevices.getUserMedia({ audio: true });
				mediaRecorder = new MediaRecorder(mediaStream);
				audioChunks = [];
				mediaRecorder.ondataavailable = (e) => audioChunks.push(e.data);
				mediaRecorder.onstop = async () => {
					const blob = new Blob(audioChunks, { type: 'audio/wav' });
					selectedAudio = { blob };
					stopMicStream();
				};
				mediaRecorder.start();

				audioContext = new AudioContext();
				const source = audioContext.createMediaStreamSource(mediaStream);
				audioAnalyser = audioContext.createAnalyser();
				audioAnalyser.fftSize = 256;
				source.connect(audioAnalyser);
				audioLevels = [];
				audioFrameCount = 0;
				analyzeAudio();

				isRecording = true;
			} catch (err) {
				stopMicStream();
				toast('Mic access required', { kind: 'error' });
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
					selectedAudio = { blob };
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

		if (selectedImages.length === 0 && !userMessage && !selectedAudio) {
			toast('Add a photo, text, or voice first.');
			return;
		}

		// Navigate to result view IMMEDIATELY with skeleton placeholders.
		currentAnalysis = null;
		currentEntryId = null;
		pendingClarification = null;
		analysisRejection = null;
		showOtherInput = false;
		otherInput = '';
		analyzePhase = 'loading';
		currentView = 'result';

		// Wait for any in-flight image/audio uploads to finish (or fail).
		try {
			await waitForUploads();
		} catch (e) {
			analysisRejection = { message: e.message || 'Upload failed' };
			analyzePhase = 'rejected';
			return;
		}

		const imageKeys = selectedImages.map((s) => s.key).filter(Boolean);
		const audioKey = selectedAudio?.key || null;

		analyzeAbort = new AbortController();
		try {
			const res = await fetchWithRetry('/api/analyze', {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({
					message: userMessage,
					imageKeys,
					audioKey,
					timestamp: getMealTime()
				}),
				signal: analyzeAbort.signal
			});
			const data = await res.json();
			if (data.entryId) currentEntryId = data.entryId;
			handleAnalyzeResponse(data);
		} catch (err) {
			if (err.name === 'AbortError') return;
			analysisRejection = { message: "Couldn't reach the server. Try again." };
			analyzePhase = 'rejected';
		} finally {
			analyzeAbort = null;
		}
	}

	// Resolve once every upload-tracked attachment either has a key or has errored.
	function waitForUploads() {
		return new Promise((resolve, reject) => {
			const start = Date.now();
			const check = () => {
				const pendingImg = selectedImages.find((s) => !s.key && !s.error);
				const pendingAud = selectedAudio && selectedAudio.blob && !selectedAudio.key && !selectedAudio.error;
				if (!pendingImg && !pendingAud) {
					const erroredImg = selectedImages.find((s) => s.error);
					if (erroredImg) return reject(new Error('An image upload failed — remove it and retry'));
					if (selectedAudio?.error) return reject(new Error('Audio upload failed — remove it and retry'));
					return resolve();
				}
				if (Date.now() - start > 60000) return reject(new Error('Upload timed out'));
				setTimeout(check, 100);
			};
			check();
		});
	}

	function handleAnalyzeResponse(data) {
		if (data.clarification) {
			pendingClarification = data.clarification;
			currentAnalysis = { messages: data.messages, items: [], meal_title: '' };
			analyzePhase = 'clarifying';
		} else if (data.rejection) {
			analysisRejection = data.rejection;
			analyzePhase = 'rejected';
		} else {
			currentAnalysis = data;
			selectedItems = data.items.map((_, i) => i);
			userMessage = '';
			selectedImages.forEach((s) => s.thumb && URL.revokeObjectURL(s.thumb));
			selectedImages = [];
			selectedAudio = null;
			analyzePhase = 'ready';
		}
	}

	async function answerClarification(choice) {
		if (!choice || !pendingClarification) return;
		const tool_call_id = pendingClarification.tool_call_id;
		const messages = currentAnalysis.messages;
		pendingClarification = null;
		showOtherInput = false;
		otherInput = '';
		analyzePhase = 'loading';
		analyzeAbort = new AbortController();
		try {
			const res = await fetchWithRetry('/api/analyze', {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ entryId: currentEntryId, messages, tool_call_id, choice }),
				signal: analyzeAbort.signal
			});
			const data = await res.json();
			if (data.entryId) currentEntryId = data.entryId;
			handleAnalyzeResponse(data);
		} catch (err) {
			if (err.name === 'AbortError') return;
			analysisRejection = { message: "Couldn't reach the server. Try again." };
			analyzePhase = 'rejected';
		} finally {
			analyzeAbort = null;
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
		const date = new Date(selectedDate);
		if (selectedMealPeriod === 'custom' && customHour !== null) {
			date.setHours(customHour, 0, 0, 0);
		} else if (selectedMealPeriod === 'current') {
			// 'current' on a non-today date defaults to noon; on today, use actual time.
			const now = new Date();
			if (sameDay(date, now)) {
				date.setHours(now.getHours(), now.getMinutes(), now.getSeconds(), 0);
			} else {
				date.setHours(12, 0, 0, 0);
			}
		} else {
			const mealTimes = { breakfast: 8, lunch: 13, dinner: 19 };
			date.setHours(mealTimes[selectedMealPeriod] || date.getHours(), 0, 0, 0);
		}

		const year = date.getFullYear();
		const month = String(date.getMonth() + 1).padStart(2, '0');
		const day = String(date.getDate()).padStart(2, '0');
		const hours = String(date.getHours()).padStart(2, '0');
		const minutes = String(date.getMinutes()).padStart(2, '0');
		const seconds = String(date.getSeconds()).padStart(2, '0');

		return `${year}-${month}-${day}T${hours}:${minutes}:${seconds}`;
	}

	function sameDay(a, b) {
		return a.getFullYear() === b.getFullYear()
			&& a.getMonth() === b.getMonth()
			&& a.getDate() === b.getDate();
	}

	function shiftSelectedDate(days) {
		const d = new Date(selectedDate);
		d.setDate(d.getDate() + days);
		selectedDate = d;
	}

	function fmtSelectedDateLabel(d) {
		const today = new Date();
		const yest = new Date(); yest.setDate(today.getDate() - 1);
		const tom = new Date(); tom.setDate(today.getDate() + 1);
		if (sameDay(d, today)) return 'Today';
		if (sameDay(d, yest)) return 'Yesterday';
		if (sameDay(d, tom)) return 'Tomorrow';
		return d.toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric' });
	}

	function cancelAnalysis() {
		if (analyzeAbort) analyzeAbort.abort();

		// Tear down the placeholder row server-side so it doesn't litter history.
		if (currentEntryId) {
			fetchWithRetry(`/api/entry/${currentEntryId}`, { method: 'DELETE' }).catch(() => {});
		}

		currentAnalysis = null;
		currentEntryId = null;
		selectedItems = [];
		selectedMealPeriod = 'current';
		customHour = null;
		showTimeSelector = false;
		showFollowupPanel = false;
		selectedDate = new Date();
		pendingClarification = null;
		analysisRejection = null;
		showOtherInput = false;
		otherInput = '';
		analyzePhase = 'idle';
		currentView = 'track';
		// selectedImages / selectedAudio / userMessage preserved — user can retry.
	}

	async function commitAnalysis() {
		isLoading = true;
		const finalItems = selectedItems.map((idx) => currentAnalysis.items[idx]);
		const timestamp = getMealTime();

		try {
			if (currentEntryId) {
				// Common path: entry already exists from /api/analyze. Flip to committed
				// with the user's final item selection + chosen timestamp.
				await fetchWithRetry(`/api/entry/${currentEntryId}`, {
					method: 'PATCH',
					headers: { 'Content-Type': 'application/json' },
					body: JSON.stringify({
						timestamp,
						items: finalItems,
						status: 'committed'
					})
				});
			} else {
				// Fallback: handleMealSelect (re-log a past meal) skips analyze and has no entryId.
				const entry = {
					...currentAnalysis,
					items: finalItems,
					timestamp,
					total_calories: finalItems.reduce((s, i) => s + i.calories, 0),
					total_protein: Math.round(finalItems.reduce((s, i) => s + i.protein, 0)),
					total_carbs: finalItems.reduce((s, i) => s + i.carbs, 0)
				};
				await fetchWithRetry('/api/entry', {
					method: 'POST',
					headers: { 'Content-Type': 'application/json' },
					body: JSON.stringify(entry)
				});
			}
			selectedMealPeriod = 'current';
			customHour = null;
			selectedDate = new Date();
			currentEntryId = null;
			analyzePhase = 'idle';
			await loadStats();
			history = [];
			currentView = 'track';
			currentTab = 'track';
		} catch (e) {
			toast('Save failed', { kind: 'error' });
		} finally {
			isLoading = false;
		}
	}

	async function handleFollowup(message) {
		if (!message) return;

		// Snapshot the item count BEFORE the edit so the skeleton matches what was there.
		const prevCount = currentAnalysis?.items?.length || 0;
		skeletonRowCount = prevCount;

		// Phase 1: fade out the existing items top-to-bottom
		const fadeOutMs = Math.min(500, 200 + prevCount * 70);
		editPhase = 'fading-out';
		await new Promise((r) => setTimeout(r, fadeOutMs));

		// Phase 2: skeleton placeholders (count matches the previous items) while we fetch
		editPhase = 'loading';
		isAiLoading = true;

		try {
			const res = await fetchWithRetry('/api/followup', {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({
					entryId: currentEntryId,
					messages: currentAnalysis.messages,
					message,
					currentItems: currentAnalysis.items,
					currentMealTitle: currentAnalysis.meal_title
				})
			});
			const data = await res.json();
			if (data.updatedEntry) {
				currentAnalysis = {
					...currentAnalysis,
					...data.updatedEntry,
					reasoning: data.reasoning || currentAnalysis.reasoning,
					messages: data.messages,
					meal_title: data.updatedEntry.meal_title || currentAnalysis.meal_title
				};
				selectedItems = currentAnalysis.items.map((_, i) => i);
			} else {
				currentAnalysis = { ...currentAnalysis, messages: data.messages };
			}

			// Phase 3: fade in the new items top-to-bottom
			editPhase = 'fading-in';
			const newCount = currentAnalysis?.items?.length || 0;
			const fadeInMs = 200 + newCount * 80 + 250;
			await new Promise((r) => setTimeout(r, fadeInMs));
			editPhase = 'idle';
		} catch (e) {
			console.error(e);
			editPhase = 'idle';
		} finally {
			isAiLoading = false;
		}
	}

	let followupMessages = $derived(
		(currentAnalysis?.messages || []).filter((m) => {
			if (m.role === 'user' && typeof m.content === 'string') return true;
			if (m.role === 'assistant' && m.content && !m.tool_calls) return true;
			return false;
		})
	);

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

		analyzePhase = 'ready';
		currentView = 'result';
	}

	// --- STATS ---
	// Refresh stats from API (used after adding/deleting meals, not on initial load)
	async function loadStats() {
		try {
			// Send current local date to server
			const now = new Date();
			const dateStr = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
			const statsRes = await fetchWithRetry(`/api/stats?date=${dateStr}`, { silent: true });
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
			</div>
		</div>
		<div class="tab-bar">
			<button class="tab {currentTab === 'track' ? 'active' : ''}" onclick={() => currentTab = 'track'}>
				TRACK
			</button>
			<button class="tab {currentTab === 'history' ? 'active' : ''}" onclick={() => currentTab = 'history'}>
				HISTORY
			</button>
			<button class="tab {currentTab === 'chat' ? 'active' : ''}" onclick={() => currentTab = 'chat'}>
				CHAT
			</button>
		</div>
	</header>

	<!-- TRACK TAB -->
	{#key currentTab}
		{#if currentTab === 'track'}
			<div in:fade={{ duration: 150, delay: 100 }} out:fade={{ duration: 100 }}>
				{#if currentView === 'track'}
					<TrackView
						bind:userMessage
						bind:selectedImages
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
						onMealSelect={handleMealSelect}
					/>
				{/if}

				<!-- RESULT VIEW -->
				{#if currentView === 'result'}
					{#if analyzePhase === 'loading' && !currentAnalysis}
						<!-- Loading skeleton state (no analysis yet) -->
						<div id="resultView">
							<div class="day-header" style="margin-top: 0;">
								<span class="day-title">ANALYZING…</span>
							</div>
							<div class="entry-card" style="opacity: 1; margin-top: 20px;">
								<div class="entry-main">
									<div class="entry-info" style="flex: 1;">
										<div class="skeleton-title"></div>
										<div class="skeleton-pill"></div>
									</div>
									<div class="entry-macros">
										<div class="skeleton-macro"></div>
										<div class="skeleton-macro"></div>
									</div>
								</div>
								<div class="skeleton-items" style="margin-top: 30px; border-top: 1px solid #333; padding-top: 20px;">
									{#each Array(3) as _, i}
										<div class="skeleton-row" style="--delay: {i * 0.12}s"></div>
									{/each}
								</div>
								<div class="result-actions">
									<button onclick={cancelAnalysis} class="cancel-entry-btn">Cancel</button>
								</div>
							</div>
						</div>
					{:else if analyzePhase === 'clarifying' && pendingClarification}
						<!-- Clarification question state -->
						<div id="resultView">
							<div class="entry-card" style="opacity: 1; margin-top: 20px;">
								<div class="clarify-card">
									<p class="clarify-question">{pendingClarification.question}</p>
									<div class="clarify-options">
										{#each pendingClarification.options as opt}
											<button class="clarify-option" onclick={() => answerClarification(opt.value)}>
												{opt.label}
											</button>
										{/each}
										{#if !showOtherInput}
											<button class="clarify-option other" onclick={() => (showOtherInput = true)}>
												Other…
											</button>
										{:else}
											<form
												class="clarify-other-form"
												onsubmit={(e) => {
													e.preventDefault();
													if (otherInput.trim()) answerClarification(otherInput.trim());
												}}
											>
												<input
													type="text"
													bind:value={otherInput}
													class="clarify-other-input"
													placeholder="Type your answer…"
												/>
												<button type="submit" class="clarify-other-submit" disabled={!otherInput.trim()}>
													Send
												</button>
											</form>
										{/if}
									</div>
								</div>
								<div class="result-actions">
									<button onclick={cancelAnalysis} class="cancel-entry-btn">Cancel</button>
								</div>
							</div>
						</div>
					{:else if analyzePhase === 'loading' && currentAnalysis}
						<!-- Continuation loading (after clarification answer) -->
						<div id="resultView">
							<div class="day-header" style="margin-top: 0;">
								<span class="day-title">ANALYZING…</span>
							</div>
							<div class="entry-card" style="opacity: 1; margin-top: 20px;">
								<div class="skeleton-items" style="padding-top: 8px;">
									{#each Array(3) as _, i}
										<div class="skeleton-row" style="--delay: {i * 0.12}s"></div>
									{/each}
								</div>
								<div class="result-actions">
									<button onclick={cancelAnalysis} class="cancel-entry-btn">Cancel</button>
								</div>
							</div>
						</div>
					{:else if analyzePhase === 'rejected' && analysisRejection}
						<!-- Rejection card state -->
						<div id="resultView">
							<div class="entry-card" style="opacity: 1; margin-top: 20px;">
								<div class="clarify-card">
									<p class="clarify-question">{analysisRejection.message}</p>
								</div>
								<div class="result-actions">
									<button onclick={cancelAnalysis} class="save-entry-btn">Try Again</button>
								</div>
							</div>
						</div>
					{:else if currentAnalysis}
		<div id="resultView">
			<div class="day-header" style="margin-top: 0;">
				<span class="day-title">ANALYSIS RESULT</span>
			</div>
			<div class="entry-card" style="opacity: 1; margin-top: 20px;">
				<div class="entry-main">
					<div class="entry-info">
						<h3 style="font-size: 1.4rem; margin-bottom: 8px; line-height: 1.3;">
							{currentAnalysis.meal_title || currentAnalysis.user_message || 'Meal Analysis'}
						</h3>
						<div class="time-summary">
							<Clock size={12} />
							<span>{fmtSelectedDateLabel(selectedDate)} · {displayMealTime}</span>
						</div>
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

				<div class="action-row">
					<button
						class="mini-btn"
						class:active={showFollowupPanel}
						onclick={() => {
							showFollowupPanel = !showFollowupPanel;
							if (showFollowupPanel) showTimeSelector = false;
						}}
					>
						<MessageSquare size={13} />
						EDIT
					</button>
					<button
						class="mini-btn"
						class:active={showTimeSelector}
						onclick={() => {
							showTimeSelector = !showTimeSelector;
							if (showTimeSelector) showFollowupPanel = false;
						}}
					>
						<Clock size={13} />
						CHANGE TIME
					</button>
				</div>

				{#if showTimeSelector}
					<div class="time-options" style="margin-top: 12px;">
						<div class="date-nav">
							<button class="date-arrow" onclick={() => shiftSelectedDate(-1)} aria-label="Previous day">
								<ChevronLeft size={18} />
							</button>
							<span class="date-label">{fmtSelectedDateLabel(selectedDate)}</span>
							<button class="date-arrow" onclick={() => shiftSelectedDate(1)} aria-label="Next day">
								<ChevronRight size={18} />
							</button>
						</div>
						<div class="quick-times">
							<button
								class="quick-time {selectedMealPeriod === 'current' ? 'active' : ''}"
								onclick={() => { selectedMealPeriod = 'current'; customHour = null; }}
							>Now</button>
							<button
								class="quick-time {selectedMealPeriod === 'breakfast' ? 'active' : ''}"
								onclick={() => { selectedMealPeriod = 'breakfast'; customHour = null; }}
							>8 AM</button>
							<button
								class="quick-time {selectedMealPeriod === 'lunch' ? 'active' : ''}"
								onclick={() => { selectedMealPeriod = 'lunch'; customHour = null; }}
							>1 PM</button>
							<button
								class="quick-time {selectedMealPeriod === 'dinner' ? 'active' : ''}"
								onclick={() => { selectedMealPeriod = 'dinner'; customHour = null; }}
							>7 PM</button>
						</div>
						<div class="hour-grid-label">Or pick an hour</div>
						<div class="hour-grid">
							{#each Array(24) as _, h}
								{@const now = new Date()}
								{@const isFuture = sameDay(selectedDate, now) && h > now.getHours()}
								<button
									class="hour-pill"
									class:active={selectedMealPeriod === 'custom' && customHour === h}
									class:dim={isFuture}
									onclick={() => { selectedMealPeriod = 'custom'; customHour = h; }}
								>{fmtHour12(h)}</button>
							{/each}
						</div>
					</div>
				{/if}

				<div style="margin-top: 30px; border-top: 1px solid #333; padding-top: 20px;">
					{#if editPhase === 'loading'}
						<div class="edit-skeleton-list">
							{#each Array(skeletonRowCount) as _, i}
								<div class="edit-skeleton-row">
									<div class="edit-skeleton-bar" style="--delay: {i * 0.08}s"></div>
								</div>
							{/each}
						</div>
					{:else}
						<div
							class="items-container"
							class:fading-out={editPhase === 'fading-out'}
							class:fading-in={editPhase === 'fading-in'}
						>
							{#each currentAnalysis.items as item, i}
								<div class="item-row" style="--stagger: {i * 0.07}s">
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
					{/if}
				</div>

				{#if currentAnalysis.reasoning}
					<details class="reasoning-details" style="margin-top: 20px;">
						<summary>VIEW REASONING</summary>
						<div class="reasoning-content">{@html marked.parse(currentAnalysis.reasoning)}</div>
					</details>
				{/if}

				{#if showFollowupPanel}
					<div class="chat-panel" style="margin-top: 12px;">
						{#if followupMessages.length > 0}
							<div class="followup-thread">
								{#each followupMessages as msg}
									<div class="followup-msg {msg.role}">
										<div class="followup-bubble">{msg.content}</div>
									</div>
								{/each}
								{#if isAiLoading}
									<div class="followup-msg assistant">
										<div class="followup-bubble typing">
											<span></span><span></span><span></span>
										</div>
									</div>
								{/if}
							</div>
						{/if}
						<div class="chat-bar" style="margin-top: 0; margin-bottom: 0;">
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
				{/if}

				<div class="result-actions">
					<button onclick={cancelAnalysis} class="cancel-entry-btn">Cancel</button>
					<button onclick={commitAnalysis} class="save-entry-btn">Save Entry</button>
				</div>
			</div>
		</div>
					{/if}
				{/if}
			</div>
		{/if}

		<!-- HISTORY TAB -->
		{#if currentTab === 'history'}
			<div in:fade={{ duration: 150, delay: 100 }} out:fade={{ duration: 100 }}>
				<HistoryView
					{historyGroups}
					{historyLoading}
					{proteinFocused}
					onDeleteEntry={deleteEntry}
					onEntryUpdated={async () => {
						await loadHistory();
						await loadStats();
					}}
				/>
			</div>
		{/if}

		<!-- CHAT TAB -->
		{#if currentTab === 'chat'}
			<div in:fade={{ duration: 150, delay: 100 }} out:fade={{ duration: 100 }}>
				<ChatView bind:messages={chatMessages} bind:conversationId={chatConversationId} />
			</div>
		{/if}
	{/key}
</div>

<style>
	/* === Item list animation: idle / fading-out / fading-in === */
	.items-container .item-row {
		opacity: 1;
		transition: opacity 0.3s ease;
		transition-delay: var(--stagger, 0s);
	}
	.items-container.fading-out .item-row {
		opacity: 0;
	}
	.items-container.fading-in .item-row {
		opacity: 0;
		animation: itemFadeIn 0.35s ease forwards;
		animation-delay: var(--stagger);
	}
	@keyframes itemFadeIn {
		from { opacity: 0; transform: translateY(4px); }
		to { opacity: 1; transform: translateY(0); }
	}

	/* === Edit-with-AI skeleton (one bar per previous item, no horizontal dividers) === */
	.edit-skeleton-list {
		display: flex;
		flex-direction: column;
	}
	.edit-skeleton-row {
		display: flex;
		align-items: center;
		padding: 8px 0;
		min-height: 21px; /* 20px content + 1px to compensate for missing border */
	}
	.edit-skeleton-bar {
		width: 100%;
		height: 18px;
		border-radius: 4px;
		opacity: 0;
		background: linear-gradient(90deg, #161616 25%, #222 50%, #161616 75%);
		background-size: 200% 100%;
		animation: skeletonAppear 0.25s ease var(--delay, 0s) forwards,
			skeletonShimmer 1.4s linear infinite;
	}

	/* === Skeleton placeholders (initial analyze loading) === */
	.skeleton-items {
		display: flex;
		flex-direction: column;
	}
	.skeleton-row {
		height: 28px;
		border-radius: 6px;
		opacity: 0;
		margin-bottom: 14px;
		background: linear-gradient(90deg, #161616 25%, #222 50%, #161616 75%);
		background-size: 200% 100%;
		animation: skeletonAppear 0.3s ease var(--delay, 0s) forwards,
			skeletonShimmer 1.4s linear infinite;
	}
	.skeleton-row:last-child { margin-bottom: 0; }
	.skeleton-title {
		height: 24px;
		width: 65%;
		border-radius: 6px;
		margin-bottom: 12px;
		background: linear-gradient(90deg, #161616 25%, #222 50%, #161616 75%);
		background-size: 200% 100%;
		animation: skeletonShimmer 1.4s linear infinite;
	}
	.skeleton-pill {
		height: 28px;
		width: 110px;
		border-radius: 6px;
		background: linear-gradient(90deg, #161616 25%, #222 50%, #161616 75%);
		background-size: 200% 100%;
		animation: skeletonShimmer 1.4s linear infinite;
	}
	.skeleton-macro {
		height: 22px;
		width: 60px;
		border-radius: 4px;
		margin-bottom: 6px;
		background: linear-gradient(90deg, #161616 25%, #222 50%, #161616 75%);
		background-size: 200% 100%;
		animation: skeletonShimmer 1.4s linear infinite;
	}
	@keyframes skeletonAppear { to { opacity: 1; } }
	@keyframes skeletonShimmer {
		0% { background-position: 100% 0; }
		100% { background-position: -100% 0; }
	}

	/* === Clarification / rejection cards === */
	.clarify-card {
		display: flex;
		flex-direction: column;
		gap: 14px;
	}
	.clarify-question {
		margin: 0;
		color: #eaeaea;
		font-size: 1rem;
		line-height: 1.45;
	}
	.clarify-options {
		display: flex;
		flex-direction: column;
		gap: 8px;
		margin-top: 2px;
	}
	.clarify-option {
		background: #1a1a1a;
		border: 1px solid #2a2a2a;
		color: #eaeaea;
		padding: 12px 14px;
		border-radius: 8px;
		cursor: pointer;
		text-align: left;
		font-size: 0.92rem;
		transition: background 0.15s, border-color 0.15s;
	}
	.clarify-option:hover {
		background: #232323;
		border-color: #3a3a3a;
	}
	.clarify-option.other {
		color: #888;
		font-style: italic;
	}
	.clarify-other-form {
		display: flex;
		gap: 8px;
	}
	.clarify-other-input {
		flex: 1;
		background: #1a1a1a;
		border: 1px solid #2a2a2a;
		color: #eaeaea;
		padding: 10px 12px;
		border-radius: 8px;
		font-size: 0.9rem;
		outline: none;
	}
	.clarify-other-input:focus { border-color: #4ade80; }
	.clarify-other-submit {
		background: #fff;
		color: #000;
		border: none;
		padding: 0 18px;
		border-radius: 8px;
		font-weight: 600;
		cursor: pointer;
	}
	.clarify-other-submit:disabled {
		background: #2a2a2a;
		color: #555;
		cursor: not-allowed;
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

	.time-edit-btn {
		display: inline-flex;
		align-items: center;
		gap: 0.5rem;
		background: transparent;
		border: 1px solid #2a2a2a;
		color: #ddd;
		padding: 0.5rem 0.85rem;
		border-radius: 6px;
		cursor: pointer;
		font-family: inherit;
		font-size: 1rem;
		font-weight: 600;
		font-variant-numeric: tabular-nums;
		letter-spacing: 0.02em;
		transition: all 0.15s;
	}

	.time-edit-btn:hover {
		background: #111;
		border-color: #3a3a3a;
		color: #fff;
	}

	.time-edit-btn.active {
		border-color: #4ade80;
		color: #4ade80;
		background: #0d0d0d;
	}

	.time-edit-text {
		font-size: 1rem;
	}

	.time-options {
		margin-top: 0.75rem;
		display: flex;
		flex-direction: column;
		gap: 0.75rem;
		animation: fadeIn 0.2s ease-out;
	}

	.quick-times {
		display: grid;
		grid-template-columns: repeat(4, 1fr);
		gap: 0.5rem;
	}

	.quick-time {
		background: #111;
		border: 1px solid var(--border);
		color: var(--text);
		padding: 0.6rem 0.4rem;
		border-radius: 6px;
		cursor: pointer;
		transition: all 0.15s;
		font-size: 0.85rem;
		font-weight: 500;
		text-align: center;
	}

	.quick-time:hover {
		background: #1a1a1a;
		border-color: #444;
	}

	.quick-time.active {
		background: #1a1a1a;
		border-color: #4ade80;
		color: #4ade80;
	}

	.hour-grid-label {
		font-size: 0.65rem;
		font-weight: 600;
		letter-spacing: 0.08em;
		text-transform: uppercase;
		color: #666;
		margin-top: 0.25rem;
	}

	.hour-grid {
		display: grid;
		grid-template-columns: repeat(6, 1fr);
		gap: 0.35rem;
	}

	.hour-pill {
		background: #111;
		border: 1px solid var(--border);
		color: var(--text);
		padding: 0.45rem 0.2rem;
		border-radius: 5px;
		cursor: pointer;
		transition: all 0.15s;
		font-size: 0.75rem;
		font-weight: 500;
		text-align: center;
	}

	.hour-pill:hover:not(:disabled) {
		background: #1a1a1a;
		border-color: #444;
	}

	.hour-pill.active {
		background: #1a1a1a;
		border-color: #4ade80;
		color: #4ade80;
	}

	.hour-pill.dim {
		opacity: 0.4;
	}

	.time-summary {
		display: inline-flex;
		align-items: center;
		gap: 0.4rem;
		font-size: 0.75rem;
		color: #888;
		letter-spacing: 0.02em;
	}

	.action-row {
		display: flex;
		gap: 0.5rem;
		margin-top: 1rem;
		flex-wrap: wrap;
	}

	.mini-btn {
		display: inline-flex;
		align-items: center;
		gap: 0.35rem;
		background: transparent;
		border: 1px solid #2a2a2a;
		color: #aaa;
		padding: 0.4rem 0.7rem;
		border-radius: 4px;
		font-size: 0.65rem;
		font-weight: 700;
		letter-spacing: 0.08em;
		cursor: pointer;
		transition: all 0.15s;
		font-family: inherit;
	}

	.mini-btn:hover {
		background: #111;
		color: #fff;
		border-color: #3a3a3a;
	}

	.mini-btn.active {
		background: #111;
		color: #4ade80;
		border-color: #4ade80;
	}

	.date-nav {
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: 0.5rem;
		padding: 0.25rem 0;
	}

	.date-arrow {
		background: #111;
		border: 1px solid #222;
		color: #ddd;
		width: 32px;
		height: 32px;
		display: inline-flex;
		align-items: center;
		justify-content: center;
		border-radius: 6px;
		cursor: pointer;
		transition: all 0.15s;
	}

	.date-arrow:hover {
		background: #1a1a1a;
		border-color: #4ade80;
		color: #4ade80;
	}

	.date-label {
		font-size: 0.85rem;
		font-weight: 600;
		color: #eee;
		letter-spacing: 0.02em;
	}

	.chat-panel {
		padding: 0.75rem;
		background: #0a0a0a;
		border: 1px solid #1c1c1c;
		border-radius: 8px;
		display: flex;
		flex-direction: column;
		gap: 0.5rem;
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

	.followup-thread {
		display: flex;
		flex-direction: column;
		gap: 8px;
		margin-bottom: 16px;
		max-height: 280px;
		overflow-y: auto;
		padding-right: 4px;
	}

	.followup-msg {
		display: flex;
		animation: fadeIn 0.25s ease-out;
	}

	.followup-msg.user {
		justify-content: flex-end;
	}

	.followup-msg.assistant {
		justify-content: flex-start;
	}

	.followup-bubble {
		max-width: 85%;
		padding: 10px 14px;
		border-radius: 14px;
		font-size: 0.9rem;
		line-height: 1.4;
		white-space: pre-wrap;
		word-wrap: break-word;
	}

	.followup-msg.user .followup-bubble {
		background: #fff;
		color: #000;
		border-bottom-right-radius: 4px;
	}

	.followup-msg.assistant .followup-bubble {
		background: #1a1a1a;
		color: #fff;
		border: 1px solid #2a2a2a;
		border-bottom-left-radius: 4px;
	}

	.followup-bubble.typing {
		display: inline-flex;
		gap: 4px;
		align-items: center;
		padding: 12px 14px;
	}

	.followup-bubble.typing span {
		width: 6px;
		height: 6px;
		background: #888;
		border-radius: 50%;
		animation: typing 1.2s infinite ease-in-out;
	}

	.followup-bubble.typing span:nth-child(2) {
		animation-delay: 0.15s;
	}

	.followup-bubble.typing span:nth-child(3) {
		animation-delay: 0.3s;
	}

	.result-actions {
		margin-top: 30px;
		display: flex;
		gap: 10px;
	}

	.cancel-entry-btn,
	.save-entry-btn {
		flex: 1;
		padding: 15px;
		border: none;
		text-transform: uppercase;
		letter-spacing: 2px;
		font-weight: 600;
		font-size: 0.85rem;
		cursor: pointer;
		border-radius: 4px;
		transition: opacity 0.15s;
	}

	.cancel-entry-btn {
		flex: 0 0 35%;
		background: transparent;
		color: #aaa;
		border: 1px solid #333;
	}

	.cancel-entry-btn:hover {
		color: #fff;
		border-color: #555;
	}

	.save-entry-btn {
		background: white;
		color: black;
	}

	.save-entry-btn:hover {
		opacity: 0.9;
	}

	@keyframes typing {
		0%,
		60%,
		100% {
			opacity: 0.3;
			transform: translateY(0);
		}
		30% {
			opacity: 1;
			transform: translateY(-3px);
		}
	}







</style>
