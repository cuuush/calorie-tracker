<script>
    import { onMount } from 'svelte';
    import { marked } from 'marked';
    import { Base64 } from 'js-base64';

    let { data } = $props();
    let user = data.user;

    // View State
    let currentView = $state('track');
    let isLoading = $state(false);
    let isAiLoading = $state(false);
    let expandedEntries = $state(new Set());

    // Track State
    let userMessage = $state('');
    let fileInput;
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
    let resultTotalCal = $derived(selectedItems.reduce((sum, idx) => sum + (currentAnalysis?.items[idx]?.calories || 0), 0));
    let resultTotalProt = $derived(selectedItems.reduce((sum, idx) => sum + (currentAnalysis?.items[idx]?.protein || 0), 0));

    // History State
    let history = $state([]);

    // Stats State
    let settings = $state({});
    let dailyBudget = $derived(settings.maintenance_calories || 2000);
    let proteinGoal = $derived(settings.protein_goal || 150);
    let statsData = $state({ todayTotal: 0, todayProtein: 0, groups: {}, weeklyData: [], weeklyProteinData: [] });

    // Settings State (for editing)
    let editSettings = $state({});

    onMount(async () => {
        setDynamicPlaceholder();
        loadStats();
        if (currentView === 'history') loadHistory();
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

    function switchView(view) {
        currentView = view;
        if (view === 'track') loadStats();
        if (view === 'history') loadHistory();
        if (view === 'settings') loadSettings();
        window.scrollTo(0, 0);
    }

    // --- TRACK ---
    function analyzeAudio() {
        if (!audioAnalyser) return;

        const dataArray = new Uint8Array(audioAnalyser.frequencyBinCount);
        audioAnalyser.getByteFrequencyData(dataArray);

        // Calculate average volume
        const average = dataArray.reduce((a, b) => a + b) / dataArray.length;
        const level = Math.min(100, Math.max(10, (average / 255) * 250));

        // Only add new bar every 6 frames for slower scroll
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

                // Set up audio visualization
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
                alert("Mic access required");
            }
        } else {
            mediaRecorder.stop();
            isRecording = false;
            placeholder = setDynamicPlaceholder();

            // Clean up audio visualization
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
        // If recording, stop it first and wait for the blob
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

            // Clean up recording state
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

        if (!selectedFile && !userMessage && !selectedAudio) return alert('Provide image, text, or audio');
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
            selectedItems = selectedItems.filter(i => i !== index);
        } else {
            selectedItems = [...selectedItems, index];
        }
    }

    async function commitAnalysis() {
        isLoading = true;
        const finalItems = selectedItems.map(idx => currentAnalysis.items[idx]);
        const entry = {
            ...currentAnalysis,
            items: finalItems,
            total_calories: finalItems.reduce((s, i) => s + i.calories, 0),
            total_protein: finalItems.reduce((s, i) => s + i.protein, 0),
            total_carbs: finalItems.reduce((s, i) => s + i.carbs, 0)
        };

        try {
            await fetch('/api/entry', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(entry)
            });
            currentView = 'history';
            loadHistory();
            loadStats();
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
                // Append response to reasoning? Original app did this
            }
        } catch (e) {
            console.error(e);
        } finally {
            isAiLoading = false;
        }
    }

    // --- HISTORY ---
    async function loadHistory() {
        const res = await fetch('/api/history');
        history = await res.json();
    }

    async function deleteEntry(id) {
        if (!confirm('Delete this entry?')) return;
        expandedEntries.delete(id);
        const res = await fetch(`/api/entry/${id}`, { method: 'DELETE' });
        loadHistory();
        loadStats();
    }

    function getMealTime(timestamp) {
        const hour = new Date(timestamp).getHours();
        if (hour >= 4 && hour < 11) return 'Breakfast';
        if (hour >= 11 && hour < 16) return 'Lunch';
        if (hour >= 16 && hour < 23) return 'Dinner';
        return 'Late Night';
    }

    function groupHistory(entries) {
        const groups = {};
        entries.forEach(entry => {
            const date = new Date(entry.timestamp).toLocaleDateString([], { weekday: 'long', month: 'short', day: 'numeric' });
            if (!groups[date]) groups[date] = { entries: [], totalCal: 0, totalProt: 0 };
            groups[date].entries.push(entry);
            groups[date].totalCal += entry.total_calories;
            groups[date].totalProt += entry.total_protein;
        });
        return groups;
    }

    function toggleEntry(id) {
        const newSet = new Set(expandedEntries);
        if (newSet.has(id)) {
            newSet.delete(id);
        } else {
            newSet.add(id);
        }
        expandedEntries = newSet;
    }

    // --- STATS ---
    async function loadStats() {
        const [hRes, sRes] = await Promise.all([fetch('/api/history'), fetch('/api/settings')]);
        const entries = await hRes.json();
        settings = await sRes.json();
        
        const todayStr = new Date().toLocaleDateString();
        const todayEntries = entries.filter(e => new Date(e.timestamp).toLocaleDateString() === todayStr);
        
        const groups = { 'BREAKFAST': 0, 'LUNCH': 0, 'DINNER': 0, 'SNACK': 0 };
        todayEntries.forEach(e => {
            const h = new Date(e.timestamp).getHours();
            if (h >= 4 && h < 11) groups['BREAKFAST'] += e.total_calories;
            else if (h >= 11 && h < 16) groups['LUNCH'] += e.total_calories;
            else if (h >= 16 && h < 22) groups['DINNER'] += e.total_calories;
            else groups['SNACK'] += e.total_calories;
        });

        const startOfWeek = new Date();
        startOfWeek.setDate(startOfWeek.getDate() - startOfWeek.getDay());
        startOfWeek.setHours(0,0,0,0);

        const weeklyData = [0,0,0,0,0,0,0];
        const weeklyProteinData = [0,0,0,0,0,0,0];
        entries.forEach(e => {
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
    }

    // --- SETTINGS ---
    async function loadSettings() {
        const res = await fetch('/api/settings');
        settings = await res.json();
        editSettings = { ...settings };
    }

    async function saveSettings() {
        await fetch('/api/settings', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(editSettings)
        });
        switchView('stats');
    }

    function calcTDEE() {
        const { weight, weight_unit, height, height_unit, age, gender, activity_level } = editSettings;
        if (!weight || !height || !age) return alert('Fill info');
        let weightKg = weight_unit === 'lbs' ? weight * 0.453592 : weight;
        let heightCm = height_unit === 'in' ? height * 2.54 : height;
        let bmr = (10 * weightKg) + (6.25 * heightCm) - (5 * age) + (gender === 'male' ? 5 : -161);
        const m = { sedentary: 1.2, light: 1.375, moderate: 1.55, active: 1.725, very_active: 1.9 };
        editSettings.maintenance_calories = Math.round(bmr * (m[activity_level] || 1.2));
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
            <button class="logout-btn" onclick={logout}>LOGOUT</button>
        </div>
    </header>

    <div class="tabs">
        <button class="tab {currentView === 'track' ? 'active' : ''}" onclick={() => switchView('track')}>Track</button>
        <button class="tab {currentView === 'history' ? 'active' : ''}" onclick={() => switchView('history')}>History</button>
    </div>

    <!-- TRACK VIEW -->
    {#if currentView === 'track'}
        <div id="trackView">
            <input type="file" bind:this={fileInput} hidden accept="image/*" onchange={(e) => selectedFile = e.target.files[0]}>
            <div class="chat-bar">
                <div class="input-wrapper">
                    <input type="text" bind:value={userMessage} class="chat-input" placeholder={isRecording ? '' : placeholder}
                        disabled={isAiLoading}
                        onkeypress={(e) => e.key === 'Enter' && analyze()}>
                    {#if isRecording}
                        <div class="audio-visualizer">
                            {#each audioLevels as level, i}
                                <div class="audio-bar"
                                     style="height: {level}%; opacity: {(audioLevels.length - i) / audioLevels.length}"></div>
                            {/each}
                        </div>
                    {/if}
                </div>
                <button class="icon-btn" onclick={() => fileInput.click()} title="Add Image">
                    <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                        <path d="M23 19a2 2 0 0 1-2 2H3a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h4l2-3h6l2 3h4a2 2 0 0 1 2 2z" />
                        <circle cx="12" cy="13" r="4" />
                    </svg>
                </button>
                <button class="icon-btn {isRecording ? 'active' : ''}" onclick={toggleMic}>
                    {#if isRecording}
                        <svg width="20" height="20" viewBox="0 0 24 24" fill="currentColor">
                            <rect x="6" y="6" width="12" height="12" rx="2"/>
                        </svg>
                    {:else}
                        <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
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
                        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round">
                            <line x1="22" y1="2" x2="11" y2="13"></line>
                            <polygon points="22 2 15 22 11 13 2 9 22 2"></polygon>
                        </svg>
                    {/if}
                </button>
            </div>
            {#if selectedFile}
                <div class="attachment-badge">
                    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round">
                        <path d="M23 19a2 2 0 0 1-2 2H3a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h4l2-3h6l2 3h4a2 2 0 0 1 2 2z" />
                        <circle cx="12" cy="13" r="4" />
                    </svg>
                    <span>IMAGE ATTACHED</span>
                    <button class="clear-btn" onclick={() => selectedFile = null} title="Remove image">&times;</button>
                </div>
            {/if}
            {#if selectedAudio}
                <div class="attachment-badge">
                    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round">
                        <path d="M12 1a3 3 0 0 0-3 3v8a3 3 0 0 0 6 0V4a3 3 0 0 0-3-3z" />
                        <path d="M19 10v2a7 7 0 0 1-14 0v-2" />
                    </svg>
                    <span>AUDIO ATTACHED</span>
                    <button class="clear-btn" onclick={() => selectedAudio = null} title="Remove audio">&times;</button>
                </div>
            {/if}

            <div id="statsView" style="margin-top: 30px;">
                <div class="stats-card" style="margin: 0; padding: 0; background: transparent; border: none;">
                    <div style="display: flex; justify-content: space-between; align-items: baseline;">
                        <span class="day-title">DAILY BUDGET</span>
                        <span class="day-summary">{Math.round(statsData.todayTotal)} / {dailyBudget} CAL</span>
                    </div>
                    <div class="progress-container" style="display: flex;">
                        {#each ['BREAKFAST', 'LUNCH', 'DINNER', 'SNACK'] as type}
                            {#if statsData.groups[type] > 0}
                                <div style="width: {(statsData.groups[type] / dailyBudget) * 100}%; background: {{BREAKFAST: '#B5EAD7', LUNCH: '#FFD3B6', DINNER: '#C7CEEA', SNACK: '#FDE2E4'}[type]}; height: 100%;"></div>
                            {/if}
                        {/each}
                    </div>
                    <div style="display: flex; justify-content: space-between; margin-bottom: 20px;">
                        <div style="display:flex; gap:10px; font-size: 0.6rem; color: #666; text-transform: uppercase;">
                            <span style="color:#B5EAD7">Breakfast</span>
                            <span style="color:#FFD3B6">Lunch</span>
                            <span style="color:#C7CEEA">Dinner</span>
                            <span style="color:#FDE2E4">Snack</span>
                        </div>
                        <span class="stat-label">{Math.round(Math.max(dailyBudget - statsData.todayTotal, 0))} REMAINING</span>
                    </div>

                    <div style="display: flex; justify-content: space-between; align-items: baseline; margin-top: 30px;">
                        <span class="day-title">PROTEIN GOAL</span>
                        <span class="day-summary">{Math.round(statsData.todayProtein)}g / {proteinGoal}g</span>
                    </div>
                    <div class="progress-container">
                        <div class="progress-bar protein" style="width: {Math.min((statsData.todayProtein / proteinGoal) * 100, 100)}%;"></div>
                    </div>
                    <div style="display: flex; justify-content: flex-end; margin-bottom: 20px;">
                        <span class="stat-label">{Math.round(Math.max(proteinGoal - statsData.todayProtein, 0))}g REMAINING</span>
                    </div>

                    <div class="stats-grid">
                        {#if statsData.weeklyData.filter(x => x > 0).length > 0}
                            {@const daysTracked = statsData.weeklyData.filter(x => x > 0).length}
                            {@const avgCals = Math.round(statsData.weeklyData.reduce((a,b)=>a+b, 0) / daysTracked)}
                            {@const avgProt = Math.round(statsData.weeklyProteinData.reduce((a,b)=>a+b, 0) / daysTracked)}
                            <div class="stat-box">
                                <span class="stat-label">DAILY AVG</span>
                                <span class="stat-value">{avgCals} / {dailyBudget}</span>
                                <span class="stat-label" style="font-size: 0.5rem; margin-top: 4px; color: {avgCals <= dailyBudget ? '#4ade80' : '#f87171'}">
                                    {avgCals <= dailyBudget ? '✓' : '!'} {avgCals - dailyBudget > 0 ? '+' : ''}{avgCals - dailyBudget} CAL
                                </span>
                            </div>
                            <div class="stat-box" style="text-align: right;">
                                <span class="stat-label">PROTEIN AVG</span>
                                <span class="stat-value">{avgProt}g / {proteinGoal}g</span>
                                <span class="stat-label" style="font-size: 0.5rem; margin-top: 4px; color: {avgProt >= proteinGoal ? '#4ade80' : '#f87171'}">
                                    {avgProt >= proteinGoal ? '✓' : '!'} {avgProt - proteinGoal > 0 ? '+' : ''}{avgProt - proteinGoal}g
                                </span>
                            </div>
                        {:else}
                            <div class="stat-box"><span class="stat-label">NO DATA YET</span><span class="stat-value">-</span></div>
                        {/if}
                    </div>
                    
                    <div class="weekly-chart" style="padding-top:20px;">
                        {#each ['S','M','T','W','T','F','S'] as day, i}
                            <div class="day-column">
                                <div class="day-bar-wrap">
                                    <div class="day-bar {i === new Date().getDay() ? 'today' : ''} {statsData.weeklyData[i] > dailyBudget ? 'over' : ''}" 
                                         style="height: {(statsData.weeklyData[i] / Math.max(dailyBudget*1.2, ...statsData.weeklyData)) * 100}%"></div>
                                </div>
                                <span class="day-name">{day}</span>
                            </div>
                        {/each}
                    </div>
                    <button class="btn-outline" style="width: 100%; margin-top: 40px;" onclick={() => switchView('settings')}>Adjust Profile</button>
                </div>
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
                        <h3 style="font-size: 1.4rem; margin-bottom: 5px;">{currentAnalysis.meal_title || currentAnalysis.user_message || 'Meal Analysis'}</h3>
                        <p style="color: #666; font-size: 0.8rem;">{new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</p>
                    </div>
                    <div class="entry-macros">
                        <div class="macro-row"><span class="macro-detail">CAL</span><span class="macro-total" style="font-size: 1.2rem;">{Math.round(resultTotalCal)}</span></div>
                        <div class="macro-row"><span class="macro-detail">PROT</span><span class="macro-total" style="font-size: 0.9rem; color: #aaa;">{Math.round(resultTotalProt)}</span></div>
                    </div>
                </div>

                <div style="margin-top: 30px; border-top: 1px solid #333; padding-top: 20px;">
                    {#each currentAnalysis.items as item, i}
                        <div class="item-row" style="animation: fadeIn 0.5s forwards {i * 0.1}s;">
                            <div class="item-left">
                                <input type="checkbox" checked={selectedItems.includes(i)} onchange={() => toggleItem(i)}>
                                <span class="item-name">{item.name}</span>
                            </div>
                            <div class="item-macros">
                                <span>{item.protein || 0}g P</span>
                                <span>{item.calories} CAL</span>
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

                <div class="detail-view" style="display: block; margin-top: 30px; padding: 20px; background: #111; border-radius: 8px;">
                    <div class="chat-bar" style="margin-top: 0;">
                        <input type="text" class="chat-input" placeholder="WANT TO CHANGE SOMETHING?..."
                            disabled={isAiLoading}
                            onkeypress={(e) => { 
                                if(e.key === 'Enter') { 
                                    handleFollowup(e.target.value); 
                                    e.target.value = ''; 
                                } 
                            }}>
                        <button class="send-btn" onclick={(e) => {
                            const input = e.currentTarget.previousElementSibling;
                            handleFollowup(input.value);
                            input.value = '';
                        }} disabled={isAiLoading}>
                            {#if isAiLoading}
                                <div class="btn-spinner"></div>
                            {:else}
                                <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round">
                                    <line x1="22" y1="2" x2="11" y2="13"></line>
                                    <polygon points="22 2 15 22 11 13 2 9 22 2"></polygon>
                                </svg>
                            {/if}
                        </button>
                    </div>
                </div>

                <button onclick={commitAnalysis} style="margin-top: 30px; width: 100%; padding: 15px; background: white; color: black; border: none; text-transform: uppercase; letter-spacing: 2px; font-weight: 600; cursor: pointer;">
                    Save Entry
                </button>
            </div>
        </div>
    {/if}


    <!-- SETTINGS VIEW -->
    {#if currentView === 'settings'}
        <div id="settingsView">
            <div class="day-header" style="margin-top: 0;">
                <span class="day-title">PROFILE</span>
                <button class="action-btn" onclick={() => switchView('track')}>BACK</button>
            </div>

            <div class="settings-group">
                <label class="settings-label">Weight</label>
                <div style="display: flex; gap: 10px;">
                    <input type="number" bind:value={editSettings.weight} class="settings-input">
                    <select bind:value={editSettings.weight_unit} class="settings-input" style="width: 80px;">
                        <option value="lbs">LB</option>
                        <option value="kg">KG</option>
                    </select>
                </div>
            </div>

            <div class="settings-group">
                <label class="settings-label">Height</label>
                <div style="display: flex; gap: 10px; align-items: center;">
                    {#if editSettings.height_unit === 'in'}
                        <div style="display: flex; gap: 5px; align-items: center; flex: 1;">
                            <input 
                                type="number" 
                                value={Math.floor((editSettings.height || 0) / 12)} 
                                oninput={(e) => {
                                    const ft = parseInt(e.target.value) || 0;
                                    const currIn = (editSettings.height || 0) % 12;
                                    editSettings.height = (ft * 12) + currIn;
                                }}
                                class="settings-input"
                                style="width: 100%;"
                                placeholder="FT"
                            >
                            <span style="font-size: 0.7rem; color: #666;">FT</span>
                            <input 
                                type="number" 
                                value={(editSettings.height || 0) % 12} 
                                oninput={(e) => {
                                    const inch = parseInt(e.target.value) || 0;
                                    const currFt = Math.floor((editSettings.height || 0) / 12);
                                    editSettings.height = (currFt * 12) + inch;
                                }}
                                class="settings-input"
                                style="width: 100%;"
                                placeholder="IN"
                            >
                            <span style="font-size: 0.7rem; color: #666;">IN</span>
                        </div>
                    {:else}
                        <input type="number" bind:value={editSettings.height} class="settings-input">
                    {/if}
                    <select bind:value={editSettings.height_unit} class="settings-input" style="width: 80px;">
                        <option value="in">IN</option>
                        <option value="cm">CM</option>
                    </select>
                </div>
            </div>

            <div class="settings-group">
                <label class="settings-label">Age & Gender</label>
                <div style="display: flex; gap: 10px;">
                    <input type="number" bind:value={editSettings.age} class="settings-input" placeholder="Age">
                    <select bind:value={editSettings.gender} class="settings-input">
                        <option value="male">MALE</option>
                        <option value="female">FEMALE</option>
                    </select>
                </div>
            </div>

            <div class="settings-group">
                <label class="settings-label">Activity</label>
                <select bind:value={editSettings.activity_level} class="settings-input">
                    <option value="sedentary">Sedentary</option>
                    <option value="light">Light</option>
                    <option value="moderate">Moderate</option>
                    <option value="active">Active</option>
                    <option value="very_active">Very Active</option>
                </select>
            </div>

            <div class="settings-group">
                <label class="settings-label">Protein Goal (g)</label>
                <input type="number" bind:value={editSettings.protein_goal} class="settings-input">
            </div>

            <div class="settings-group">
                <div style="display: flex; justify-content: space-between; margin-bottom: 5px;">
                    <label class="settings-label">Maintenance Goal</label>
                    <button class="action-btn" onclick={calcTDEE}>AUTO CALCULATE</button>
                </div>
                <input type="number" bind:value={editSettings.maintenance_calories} class="settings-input">
            </div>

            <button onclick={saveSettings} style="width: 100%; padding: 20px; background: white; color: black; border: none; text-transform: uppercase; letter-spacing: 2px; font-weight: 600; cursor: pointer;">
                Save
            </button>
        </div>
    {/if}

    <!-- HISTORY VIEW -->
    {#if currentView === 'history'}
        <div id="historyView">
            {#each Object.entries(groupHistory(history)) as [date, day]}
                <div class="day-header">
                    <span class="day-title">{date.toUpperCase()}</span>
                    <span class="day-summary">{Math.round(day.totalCal)} CALS &middot; {Math.round(day.totalProt)}g PROT</span>
                </div>
                {#each day.entries as entry, i}
                    <div class="entry-card" style="animation-delay: {i * 0.05}s">
                        <div class="entry-main">
                            <div class="entry-info">
                                <h3>{entry.meal_title || entry.user_message || 'Meal'}</h3>
                                <span class="entry-user-msg" style="font-size:0.7rem">{new Date(entry.timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</span>
                            </div>
                            <div class="entry-macros">
                                <div class="macro-row"><span class="macro-detail">CAL</span><span class="macro-total">{entry.total_calories}</span></div>
                                <div class="macro-row"><span class="macro-detail">PROT</span><span class="macro-total" style="font-size: 0.9rem; color: #aaa;">{entry.total_protein}</span></div>
                            </div>
                        </div>
                        <div class="entry-actions">
                            <button class="action-btn" onclick={() => toggleEntry(entry.id)}>
                                {expandedEntries.has(entry.id) ? 'Hide Details' : 'Details'}
                            </button>
                            <button class="action-btn delete" onclick={() => deleteEntry(entry.id)}>Delete</button>
                        </div>

                        {#if expandedEntries.has(entry.id)}
                            <div class="history-details" style="margin-top: 15px; border-top: 1px solid #222; padding-top: 15px; animation: fadeIn 0.3s ease-out;">
                                {#each entry.items || [] as item}
                                    <div class="item-row" style="border-bottom: 1px solid #111; padding: 6px 0;">
                                        <div class="item-left">
                                            <span class="item-name" style="font-size: 0.8rem;">{item.name}</span>
                                        </div>
                                        <div class="item-macros" style="font-size: 0.75rem;">
                                            <span>{item.protein || 0}g P</span>
                                            <span>{item.calories} CAL</span>
                                        </div>
                                    </div>
                                {/each}
                                {#if entry.reasoning}
                                    <div class="reasoning-content" style="font-size: 0.75rem; border: none; padding: 10px 0 0 0; color: #777;">
                                        {@html marked.parse(entry.reasoning)}
                                    </div>
                                {/if}
                            </div>
                        {/if}
                    </div>
                {/each}
            {/each}
        </div>
    {/if}
</div>

<style>
    /* Add any Svelte-specific styles here */
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
        border: 3px solid rgba(255,255,255,0.1);
        border-radius: 50%;
        border-top-color: #fff;
        animation: spin 1s ease-in-out infinite;
    }
    @keyframes spin { to { transform: rotate(360deg); } }
    
    #loadingOverlay {
        position: fixed;
        top: 0;
        left: 0;
        width: 100%;
        height: 100%;
        background: rgba(0,0,0,0.8);
        z-index: 9999;
        justify-content: center;
        align-items: center;
    }

    .btn-spinner {
        width: 18px;
        height: 18px;
        border: 2px solid rgba(0,0,0,0.1);
        border-radius: 50%;
        border-top-color: #000;
        animation: spin 0.6s linear infinite;
    }

    .btn-spinner.white {
        border-color: rgba(255,255,255,0.1);
        border-top-color: #fff;
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
        from { opacity: 0; transform: translateY(5px); }
        to { opacity: 1; transform: translateY(0); }
    }
</style>
