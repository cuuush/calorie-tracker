const $ = id => document.getElementById(id);

// Check authentication on page load
(async function checkAuth() {
    try {
        const res = await fetch('/auth/me');
        const data = await res.json();

        if (!data.authenticated) {
            window.location.href = '/login.html';
            return;
        }

        // Store user info globally if needed
        window.currentUser = data.user;

        // Set dynamic placeholder based on time of day
        setDynamicPlaceholder();
    } catch (e) {
        console.error('Auth check failed:', e);
        window.location.href = '/login.html';
    }
})();

function setDynamicPlaceholder() {
    const hour = new Date().getHours();
    let meal = 'meal';
    if (hour >= 4 && hour < 11) meal = 'breakfast';
    else if (hour >= 11 && hour < 16) meal = 'lunch';
    else if (hour >= 16 && hour < 22) meal = 'dinner';
    else meal = 'snack';

    const input = $('userMessage');
    if (input) {
        input.placeholder = `What's for ${meal}?`;
    }
}

// Logout function
async function logout() {
    if (!confirm('Are you sure you want to log out?')) return;

    try {
        await fetch('/auth/logout', { method: 'POST' });
        window.location.href = '/login.html';
    } catch (e) {
        console.error('Logout error:', e);
        alert('Failed to log out. Please try again.');
    }
}

// Helper to handle 401 responses
function handleUnauthorized(response) {
    if (response.status === 401) {
        window.location.href = '/login.html';
        return true;
    }
    return false;
}

// TABS
function switchView(viewName) {
    document.querySelectorAll('.tab').forEach(t => {
        t.classList.remove('active');
        if (t.innerText.toLowerCase() === viewName.toLowerCase()) {
            t.classList.add('active');
        }
    });

    $('trackView').classList.add('hidden');
    $('historyView').classList.add('hidden');
    $('resultView').classList.add('hidden');
    $('statsView').classList.add('hidden');
    $('settingsView').classList.add('hidden');
    $(viewName + 'View').classList.remove('hidden');
    window.scrollTo(0, 0);
}

// AUDIO RECORDING (NEW)
let mediaRecorder;
let audioChunks = [];
let isRecording = false;

async function toggleMic() {
    const btn = $('micBtn');
    if (!isRecording) {
        try {
            const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
            mediaRecorder = new MediaRecorder(stream);
            audioChunks = [];

            mediaRecorder.ondataavailable = (event) => {
                audioChunks.push(event.data);
            };

            mediaRecorder.onstop = async () => {
                const audioBlob = new Blob(audioChunks, { type: 'audio/wav' });
                await transcribeAudio(audioBlob);
            };

            mediaRecorder.start();
            isRecording = true;
            btn.classList.add('active');
            $('userMessage').placeholder = "Listening...";
        } catch (err) {
            console.error("Microphone access denied", err);
            alert("Mic access required for voice input");
        }
    } else {
        mediaRecorder.stop();
        isRecording = false;
        btn.classList.remove('active');
        $('userMessage').placeholder = "What did you eat?";
    }
}

async function transcribeAudio(blob) {
    const formData = new FormData();
    formData.append('audio', blob, 'audio.wav');

    $('loadingOverlay').style.display = 'flex';
    try {
        const res = await fetch('/transcribe', { method: 'POST', body: formData });

        if (handleUnauthorized(res)) return;

        const data = await res.json();
        if (data.text) {
            $('userMessage').value = data.text;
        }
    } catch (e) {
        console.error("Transcription error", e);
    } finally {
        $('loadingOverlay').style.display = 'none';
    }
}

// UPLOAD
$('fileInput').onchange = () => {
    if ($('fileInput').files[0]) {
        // Optional: Add visual indicator that a file is selected
        $('userMessage').placeholder = "Image selected: " + $('fileInput').files[0].name;
    }
};

// API
async function analyze() {
    const file = $('fileInput').files[0];
    const message = $('userMessage').value;

    if (!file && !message) {
        alert('Please provide an image or text description.');
        return;
    }

    const formData = new FormData();
    if (file) formData.append('image', file);
    formData.append('message', message);

    $('loadingOverlay').style.display = 'flex';
    window.selectedItems = null; // Reset selection for new analysis

    try {
        const res = await fetch('/analyze', { method: 'POST', body: formData });

        if (handleUnauthorized(res)) return;

        const data = await res.json();
        window.currentAnalysis = data; // Store globally for editing

        // Reset
        $('fileInput').value = '';
        $('userMessage').value = '';
        $('userMessage').placeholder = "What did you eat?";

        showResult(data);
    } catch (e) {
        console.error('ERROR: ' + e.message);
        alert('Analysis failed. Please try again.');
    } finally {
        $('loadingOverlay').style.display = 'none';
    }
}

function showResult(entry) {
    switchView('result');
    const container = $('resultContent');

    let itemsHtml = '';
    if (entry.items && entry.items.length > 0) {
        itemsHtml = '<div style="margin-top: 30px; border-top: 1px solid #333; padding-top: 20px;">';
        entry.items.forEach((item, index) => {
            itemsHtml += `
                <div class="item-row" style="animation: fadeIn 0.5s forwards ${index * 0.1}s;">
                    <div class="item-left">
                        <input type="checkbox" checked class="item-checkbox" onchange="toggleAnalysisItem(${index}, this.checked)">
                        <span class="item-name">${item.name}</span>
                    </div>
                    <div class="item-macros">
                       <span>${item.protein || 0}g P</span>
                       <span>${item.calories} CAL</span>
                    </div>
                </div>
            `;
        });
        itemsHtml += '</div>';
    }

    container.innerHTML = `
        <div class="day-header" style="margin-top: 0;">
            <span class="day-title">ANALYSIS RESULT</span>
        </div>
        
        <div class="entry-card" style="opacity: 1; margin-top: 20px;">
             <div class="entry-main">
              <div class="entry-info">
                <h3 style="font-size: 1.4rem; margin-bottom: 5px;">${entry.meal_title || entry.user_message || 'Meal Analysis'}</h3>
                <p style="color: #666; font-size: 0.8rem;">${new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</p>
              </div>
              <div class="entry-macros">
                  <div class="macro-row">
                      <span class="macro-detail">CAL</span>
                      <span id="result-total-cal" class="macro-total" style="font-size: 1.2rem;">${entry.total_calories || 0}</span>
                  </div>
                  <div class="macro-row">
                      <span class="macro-detail">PROT</span>
                      <span id="result-total-prot" class="macro-total" style="font-size: 0.9rem; color: #aaa;">${entry.total_protein || 0}</span>
                  </div>
              </div>
            </div>
            
            ${itemsHtml}

            <div class="result-reasoning-container" style="margin-top: 20px;">
                ${entry.reasoning ? `
                    <details class="reasoning-details">
                        <summary>VIEW REASONING</summary>
                        <div class="reasoning-content">
                            ${marked.parse(entry.reasoning)}
                        </div>
                    </details>
                ` : ''}
            </div>

            <div class="detail-view" style="display: block; margin-top: 30px; padding: 20px; background: #111; border-radius: 8px;">
                 <div class="chat-bar" style="margin-top: 0;">
                    <input type="text" class="chat-input" 
                           placeholder="WANT TO CHANGE SOMETHING?..." 
                           onkeypress="if(event.key === 'Enter') handleResultFollowup('${entry.id}', this)">
                    <button class="send-btn" onclick="handleResultFollowup('${entry.id}', this.previousElementSibling)" title="Send">
                        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round">
                            <line x1="22" y1="2" x2="11" y2="13"></line>
                            <polygon points="22 2 15 22 11 13 2 9 22 2"></polygon>
                        </svg>
                    </button>
                  </div>
                  <div class="detail-content" style="padding: 10px 0 0 0; margin-top: 10px;"></div>
            </div>
            
            <button id="saveEntryBtn" onclick="commitAnalysis()" style="margin-top: 30px; width: 100%; padding: 15px; background: white; color: black; border: none; text-transform: uppercase; letter-spacing: 2px; font-weight: 600; cursor: pointer;">
                Save Entry
            </button>
        </div>
    `;

    // Initialize temporary selection state if not exists
    if (!window.selectedItems) {
        window.selectedItems = entry.items.map((_, i) => i);
    }
}

function toggleAnalysisItem(index, isChecked) {
    if (!window.selectedItems) window.selectedItems = window.currentAnalysis.items.map((_, i) => i);

    if (isChecked) {
        if (!window.selectedItems.includes(index)) {
            window.selectedItems.push(index);
        }
    } else {
        window.selectedItems = window.selectedItems.filter(i => i !== index);
    }

    updateResultTotals();
}

function updateResultTotals() {
    const items = window.currentAnalysis.items;
    const selected = window.selectedItems;

    const totalCal = selected.reduce((sum, idx) => sum + (items[idx].calories || 0), 0);
    const totalProt = selected.reduce((sum, idx) => sum + (items[idx].protein || 0), 0);

    $('result-total-cal').innerText = Math.round(totalCal);
    $('result-total-prot').innerText = Math.round(totalProt);
}

async function commitAnalysis() {
    if (!window.currentAnalysis) return;

    const items = window.currentAnalysis.items;
    const selectedIndices = window.selectedItems || items.map((_, i) => i);

    const selectedItems = selectedIndices.map(idx => items[idx]);

    // Only send the items that are selected
    const finalEntry = {
        ...window.currentAnalysis,
        items: selectedItems,
        total_calories: selectedItems.reduce((sum, i) => sum + (i.calories || 0), 0),
        total_protein: selectedItems.reduce((sum, i) => sum + (i.protein || 0), 0),
        total_carbs: selectedItems.reduce((sum, i) => sum + (i.carbs || 0), 0)
    };

    $('saveEntryBtn').innerText = 'Saving...';
    $('saveEntryBtn').disabled = true;

    try {
        const res = await fetch('/entry', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(finalEntry)
        });

        if (handleUnauthorized(res)) return;

        // Clear local state
        window.currentAnalysis = null;
        window.selectedItems = null;

        switchView('history');
        loadHistory();
    } catch (e) {
        console.error('Save failed:', e);
        alert('Failed to save. Please try again.');
        $('saveEntryBtn').innerText = 'Save Entry';
        $('saveEntryBtn').disabled = false;
    }
}

async function handleResultFollowup(id, input) {
    const msg = input.value;
    if (!msg) return;

    const isUnsaved = (!id || id === 'undefined' || id === 'null');
    const reasoningEl = document.querySelector('#resultView .detail-content');
    reasoningEl.innerHTML += `<div style="margin-top:15px; color:#fff; border-left: 2px solid #333; padding-left: 10px; font-size: 0.85rem;">${msg}</div><div class="loading-followup" style="color:#666">...</div>`;
    input.value = '';

    try {
        const payload = { message: msg };
        if (isUnsaved) {
            payload.messages = window.currentAnalysis.messages;
        } else {
            payload.entryId = id;
        }

        const res = await fetch('/followup', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(payload)
        });

        if (handleUnauthorized(res)) return;

        const data = await res.json();

        document.querySelector('.loading-followup')?.remove();

        if (isUnsaved) {
            // Update local analysis state
            if (data.updatedEntry) {
                // Merge updated items/macros but keep original metadata like user_message
                window.currentAnalysis = {
                    ...window.currentAnalysis,
                    ...data.updatedEntry,
                    reasoning: data.reasoning || window.currentAnalysis.reasoning,
                    messages: data.messages
                };
                window.selectedItems = null; // Reset selection since items updated
                showResult(window.currentAnalysis);
            } else {
                window.currentAnalysis.messages = data.messages;
                reasoningEl.innerHTML += `<div style="margin-top:10px; color:#aaa; font-size: 0.9rem;">${marked.parse(data.content)}</div>`;
            }
        } else {
            if (data.updatedEntry) {
                showResult(data.updatedEntry);
            } else {
                reasoningEl.innerHTML += `<div style="margin-top:10px; color:#aaa; font-size: 0.9rem;">${marked.parse(data.content)}</div>`;
            }
        }
    } catch (e) {
        console.error(e);
        document.querySelector('.loading-followup')?.remove();
    }
}

async function loadHistory() {
    const res = await fetch('/history');

    if (handleUnauthorized(res)) return;

    const entries = await res.json();
    renderHistory(entries);
}

async function loadStats() {
    const [historyRes, settingsRes] = await Promise.all([
        fetch('/history'),
        fetch('/settings')
    ]);

    if (handleUnauthorized(historyRes) || handleUnauthorized(settingsRes)) return;

    const resp = [historyRes, settingsRes];
    const entries = await resp[0].json();
    const settings = await resp[1].json();
    renderStats(entries, settings);
}

function renderStats(entries, settings) {
    const container = $('statsView');
    const goal = settings.maintenance_calories || 2000;
    const proteinGoal = settings.protein_goal || 150;

    const now = new Date();
    const todayStr = now.toLocaleDateString();
    const todayEntries = entries.filter(e => new Date(e.timestamp).toLocaleDateString() === todayStr);
    const todayTotal = todayEntries.reduce((sum, e) => sum + (e.total_calories || 0), 0);
    const todayProtein = todayEntries.reduce((sum, e) => sum + (e.total_protein || 0), 0);
    const remaining = Math.max(goal - todayTotal, 0);
    const proteinRemaining = Math.max(proteinGoal - todayProtein, 0);

    const groups = { 'BREAKFAST': 0, 'LUNCH': 0, 'DINNER': 0, 'SNACK': 0 };
    todayEntries.forEach(entry => {
        const h = new Date(entry.timestamp).getHours();
        if (h >= 4 && h < 11) groups['BREAKFAST'] += (entry.total_calories || 0);
        else if (h >= 11 && h < 16) groups['LUNCH'] += (entry.total_calories || 0);
        else if (h >= 16 && h < 22) groups['DINNER'] += (entry.total_calories || 0);
        else groups['SNACK'] += (entry.total_calories || 0);
    });

    const colors = { 'BREAKFAST': '#E0E0E0', 'LUNCH': '#9E9E9E', 'DINNER': '#616161', 'SNACK': '#333333' };
    let progressHtml = '';
    ['BREAKFAST', 'LUNCH', 'DINNER', 'SNACK'].forEach(type => {
        const val = groups[type];
        if (val > 0) {
            const p = (val / goal) * 100;
            progressHtml += `<div style="width: ${p}%; background: ${colors[type]}; height: 100%;"></div>`;
        }
    });

    const proteinProgressWidth = Math.min((todayProtein / proteinGoal) * 100, 100);

    const startOfWeek = new Date(now);
    startOfWeek.setDate(now.getDate() - now.getDay());
    startOfWeek.setHours(0, 0, 0, 0);

    const weeklyData = [0, 0, 0, 0, 0, 0, 0];
    const weeklyProteinData = [0, 0, 0, 0, 0, 0, 0];
    entries.forEach(e => {
        const d = new Date(e.timestamp);
        if (d >= startOfWeek) {
            weeklyData[d.getDay()] += (e.total_calories || 0);
            weeklyProteinData[d.getDay()] += (e.total_protein || 0);
        }
    });

    const weeklyTotal = weeklyData.reduce((a, b) => a + b, 0);
    const weeklyProteinTotal = weeklyProteinData.reduce((a, b) => a + b, 0);
    const daysPassed = now.getDay() + 1;

    let weeklyHtml = '';
    const graphMax = Math.max(goal * 1.2, ...weeklyData);
    ['S', 'M', 'T', 'W', 'T', 'F', 'S'].forEach((day, i) => {
        const h = (weeklyData[i] / graphMax) * 100;
        weeklyHtml += `
          <div class="day-column">
              <div class="day-bar-wrap"><div class="day-bar ${i === now.getDay() ? 'today' : ''} ${weeklyData[i] > goal ? 'over' : ''}" style="height: ${h}%"></div></div>
              <span class="day-name">${day}</span>
          </div>`;
    });

    container.innerHTML = `
      <div class="stats-card">
            <div style="display: flex; justify-content: space-between; align-items: baseline;">
                <span class="day-title">DAILY BUDGET</span>
                <span class="day-summary">${Math.round(todayTotal)} / ${goal} CAL</span>
            </div>
            <div class="progress-container" style="display: flex;">${progressHtml}</div>
            <div style="display: flex; justify-content: space-between; margin-bottom: 20px;">
                <div style="display:flex; gap:10px; font-size: 0.6rem; color: #666; text-transform: uppercase;">
                    <span style="color:${colors.BREAKFAST}">Breakfast</span>
                    <span style="color:${colors.LUNCH}">Lunch</span>
                    <span style="color:${colors.DINNER}">Dinner</span>
                    <span style="color:${colors.SNACK}">Snack</span>
                </div>
                <span class="stat-label">${Math.round(remaining)} REMAINING</span>
            </div>

            <div style="display: flex; justify-content: space-between; align-items: baseline; margin-top: 30px;">
                <span class="day-title">PROTEIN GOAL</span>
                <span class="day-summary">${Math.round(todayProtein)}g / ${proteinGoal}g</span>
            </div>
            <div class="progress-container">
                <div class="progress-bar protein" style="width: ${proteinProgressWidth}%;"></div>
            </div>
            <div style="display: flex; justify-content: flex-end; margin-bottom: 20px;">
                <span class="stat-label">${Math.round(proteinRemaining)}g REMAINING</span>
            </div>

            <div class="stats-grid">
                <div class="stat-box"><span class="stat-label">WEEKLY CALS</span><span class="stat-value">${Math.round(weeklyTotal)}</span></div>
                <div class="stat-box" style="text-align: right;"><span class="stat-label">WEEKLY PROT</span><span class="stat-value">${Math.round(weeklyProteinTotal)}g</span></div>
            </div>
            <div class="weekly-chart" style="padding-top:20px;">${weeklyHtml}</div>
            <button class="btn-outline" style="width: 100%; margin-top: 40px;" onclick="loadSettings(); switchView('settings')">Adjust Profile</button>
        </div>`;
}

async function loadSettings() {
    const res = await fetch('/settings');

    if (handleUnauthorized(res)) return;

    const s = await res.json();
    if (s.user_id) {
        $('setWeight').value = s.weight || '';
        $('setWeightUnit').value = s.weight_unit || 'lbs';
        $('setHeight').value = s.height || '';
        $('setHeightUnit').value = s.height_unit || 'in';
        $('setAge').value = s.age || '';
        $('setGender').value = s.gender || 'male';
        $('setActivity').value = s.activity_level || 'moderate';
        $('setMaintenance').value = s.maintenance_calories || '';
        $('setProtein').value = s.protein_goal || '150';
    }
}

async function saveSettings() {
    const data = {
        weight: parseFloat($('setWeight').value), weight_unit: $('setWeightUnit').value,
        height: parseFloat($('setHeight').value), height_unit: $('setHeightUnit').value,
        age: parseInt($('setAge').value), gender: $('setGender').value,
        activity_level: $('setActivity').value, maintenance_calories: parseInt($('setMaintenance').value),
        protein_goal: parseInt($('setProtein').value)
    };
    const res = await fetch('/settings', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(data) });

    if (handleUnauthorized(res)) return;

    switchView('stats'); loadStats();
}

function calcTDEE() {
    const w = parseFloat($('setWeight').value), h = parseFloat($('setHeight').value), a = parseInt($('setAge').value), g = $('setGender').value, act = $('setActivity').value;
    if (!w || !h || !a) return alert('Fill info');
    let weightKg = $('setWeightUnit').value === 'lbs' ? w * 0.453592 : w;
    let heightCm = $('setHeightUnit').value === 'in' ? h * 2.54 : h;
    let bmr = (10 * weightKg) + (6.25 * heightCm) - (5 * a) + (g === 'male' ? 5 : -161);
    const m = { sedentary: 1.2, light: 1.375, moderate: 1.55, active: 1.725, very_active: 1.9 };
    $('setMaintenance').value = Math.round(bmr * (m[act] || 1.2));
}

function getMealTime(timestamp) {
    const hour = new Date(timestamp).getHours();
    if (hour >= 4 && hour < 11) return 'Breakfast';
    if (hour >= 11 && hour < 16) return 'Lunch';
    if (hour >= 16 && hour < 23) return 'Dinner';
    return 'Late Night';
}

function renderHistory(entries) {
    const container = $('historyView');
    container.innerHTML = '';

    // Group by date
    const grouped = {};
    entries.forEach(e => {
        const date = new Date(e.timestamp).toLocaleDateString(undefined, { weekday: 'long', month: 'short', day: 'numeric' });
        if (!grouped[date]) grouped[date] = [];
        grouped[date].push(e);
    });

    let globalIndex = 0;
    for (const [date, dayEntries] of Object.entries(grouped)) {
        const dayDiv = document.createElement('div');
        const dayCals = Math.round(dayEntries.reduce((a, b) => a + (b.total_calories || 0), 0));
        const dayProtein = Math.round(dayEntries.reduce((a, b) => a + (b.total_protein || 0), 0));
        dayDiv.innerHTML = `<div class="day-header"><span class="day-title">${date.toUpperCase()}</span><span class="day-summary">${dayCals} CALS &middot; ${dayProtein}g PROT</span></div>`;

        // Group by meal time
        const mealGroups = { 'Breakfast': [], 'Lunch': [], 'Dinner': [], 'Late Night': [] };
        dayEntries.forEach(e => {
            const mealTime = getMealTime(e.timestamp);
            mealGroups[mealTime].push(e);
        });

        // Render each meal section
        for (const [mealName, mealEntries] of Object.entries(mealGroups)) {
            if (mealEntries.length === 0) continue;

            const mealCals = Math.round(mealEntries.reduce((a, b) => a + (b.total_calories || 0), 0));
            const mealProtein = Math.round(mealEntries.reduce((a, b) => a + (b.total_protein || 0), 0));
            const mealSection = document.createElement('div');
            mealSection.style.marginTop = '30px';
            mealSection.innerHTML = `<div style="display: flex; justify-content: space-between; margin-bottom: 15px; padding-bottom: 8px; border-bottom: 1px solid #222;">
                <span style="font-size: 0.85rem; color: #666; text-transform: uppercase; letter-spacing: 1px;">${mealName}</span>
                <span style="font-size: 0.8rem; color: #666;">${mealCals} cal &middot; ${mealProtein}g prot</span>
            </div>`;

            mealEntries.forEach(entry => {
                const card = document.createElement('div');
                card.className = 'entry-card';
                card.style.animationDelay = `${globalIndex++ * 0.05}s`;
                card.innerHTML = `
              <div class="entry-main">
                <div class="entry-info">
                  <h3>${entry.meal_title || entry.user_message || 'Meal'}</h3>
                  <span class="entry-user-msg" style="font-size:0.7rem">${new Date(entry.timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</span>
                </div>
                <div class="entry-macros">
                    <div class="macro-row"><span class="macro-detail">CAL</span><span class="macro-total">${entry.total_calories}</span></div>
                    <div class="macro-row"><span class="macro-detail">PROT</span><span class="macro-total" style="font-size: 0.9rem; color: #aaa;">${entry.total_protein}</span></div>
                </div>
              </div>
              <div class="entry-actions"><button class="action-btn" onclick="toggleDetails('${entry.id}', this)">Details</button><button class="action-btn delete" onclick="deleteEntry('${entry.id}')">Delete</button></div>
              <div id="detail-${entry.id}" class="detail-view">
                <div id="detail-items-${entry.id}"></div>
                <div id="detail-reasoning-${entry.id}" class="detail-content" style="margin-top:20px"></div>
                <div class="chat-bar" style="margin-top: 20px;">
                    <input type="text" class="chat-input" placeholder="REVISE..." onkeypress="if(event.key === 'Enter') sendFollowup('${entry.id}', this)">
                    <button class="send-btn" onclick="sendFollowup('${entry.id}', this.previousElementSibling)" title="Send">
                        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round">
                            <line x1="22" y1="2" x2="11" y2="13"></line>
                            <polygon points="22 2 15 22 11 13 2 9 22 2"></polygon>
                        </svg>
                    </button>
                </div>
              </div>`;
                mealSection.appendChild(card);
            });

            dayDiv.appendChild(mealSection);
        }

        container.appendChild(dayDiv);
    }
}

async function toggleDetails(id, btn) {
    const el = $('detail-' + id);
    if (el.style.display === 'block') { el.style.display = 'none'; btn.innerText = 'DETAILS'; return; }
    el.style.display = 'block'; btn.innerText = 'CLOSE';

    const res = await fetch('/entry/' + id);

    if (handleUnauthorized(res)) return;

    const data = await res.json();

    let itemsHtml = '';
    data.items.forEach(item => {
        itemsHtml += `<div class="item-row" style="border-bottom:none; padding:4px 0;"><span class="item-name">${item.name}</span><span style="font-size:0.8rem; color:#666">${item.protein || 0}g prot &middot; ${item.calories} cal</span></div>`;
    });
    $('detail-items-' + id).innerHTML = itemsHtml;
    $('detail-reasoning-' + id).innerHTML = marked.parse(data.reasoning || '');
}

async function deleteEntry(id) {
    if (!confirm('DELETE?')) return;
    const res = await fetch('/entry/' + id, { method: 'DELETE' });

    if (handleUnauthorized(res)) return;

    loadHistory();
}

async function sendFollowup(id, input) {
    const msg = input.value; if (!msg) return;
    const reasoningEl = $('detail-reasoning-' + id);
    reasoningEl.innerHTML += `<p><b>You:</b> ${msg}</p><p class="loading-f">...</p>`;
    input.value = '';
    const res = await fetch('/followup', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ entryId: id, message: msg }) });

    if (handleUnauthorized(res)) return;

    const data = await res.json();
    const loading = reasoningEl.querySelector('.loading-f'); if (loading) loading.remove();
    reasoningEl.innerHTML += `<p>${marked.parse(data.content)}</p>`;
}
