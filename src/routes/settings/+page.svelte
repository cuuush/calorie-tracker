<script>
	import { onMount } from 'svelte';
	import { goto } from '$app/navigation';
	import LoadingSkeleton from '$lib/components/LoadingSkeleton.svelte';
	import { ArrowLeft } from 'lucide-svelte';

	let loading = $state(true);
	let isSaving = $state(false);
	let isExporting = $state(false);
	let settings = $state({
		weight: '',
		weight_unit: 'lbs',
		height: '',
		height_unit: 'in',
		age: '',
		gender: '',
		activity_level: '',
		maintenance_calories: '',
		protein_goal: 150,
		protein_focused_mode: 0
	});

	// Separate feet/inches for height input
	let heightFeet = $state('');
	let heightInches = $state('');
	let saveTimeout;

	$effect(() => {
		if (settings.height_unit === 'in' && settings.height) {
			heightFeet = Math.floor(settings.height / 12).toString();
			heightInches = (settings.height % 12).toString();
		}
	});

	// Prevent navigation while saving
	$effect(() => {
		const handleBeforeUnload = (e) => {
			if (isSaving) {
				e.preventDefault();
				e.returnValue = '';
			}
		};

		window.addEventListener('beforeunload', handleBeforeUnload);
		return () => window.removeEventListener('beforeunload', handleBeforeUnload);
	});

	onMount(async () => {
		try {
			const response = await fetch('/api/settings');
			if (response.ok) {
				const data = await response.json();
				if (data && Object.keys(data).length > 0) {
					settings = { ...settings, ...data };
				}
			}
		} catch (error) {
			console.error('Failed to load settings:', error);
		} finally {
			loading = false;
		}
	});

	function calculateTDEE() {
		const weight = settings.weight_unit === 'lbs'
			? settings.weight * 0.453592
			: settings.weight;

		let height = settings.height;
		if (settings.height_unit === 'in') {
			if (heightFeet || heightInches) {
				height = (parseInt(heightFeet) || 0) * 12 + (parseInt(heightInches) || 0);
				settings.height = height;
			}
			height = height * 2.54;
		}

		if (!weight || !height || !settings.age || !settings.gender || !settings.activity_level) {
			alert('Please fill in all fields to calculate TDEE');
			return;
		}

		// Mifflin-St Jeor equation
		let bmr = 10 * weight + 6.25 * height - 5 * parseInt(settings.age);
		bmr += settings.gender === 'male' ? 5 : -161;

		const activityMultipliers = {
			sedentary: 1.2,
			light: 1.375,
			moderate: 1.55,
			active: 1.725,
			very_active: 1.9
		};

		const tdee = Math.round(bmr * activityMultipliers[settings.activity_level]);
		settings.maintenance_calories = tdee;

		// Trigger auto-save after calculation
		autoSave();
	}

	function calculateProteinGoal() {
		if (!settings.weight) {
			alert('Please enter your weight to calculate protein goal');
			return;
		}

		// Convert to lbs if needed
		const weightInLbs = settings.weight_unit === 'lbs'
			? settings.weight
			: settings.weight * 2.20462;

		// Recommended: 0.8-1g per lb (using 0.9g as middle ground)
		const recommendedProtein = Math.round(weightInLbs * 0.9);
		settings.protein_goal = recommendedProtein;

		// Trigger auto-save after calculation
		autoSave();
	}

	async function autoSave() {
		// Clear existing timeout
		clearTimeout(saveTimeout);
		isSaving = true;

		// Debounce the save by 500ms
		saveTimeout = setTimeout(async () => {
			try {
				// Convert height from feet/inches if needed
				if (settings.height_unit === 'in' && (heightFeet || heightInches)) {
					settings.height = (parseInt(heightFeet) || 0) * 12 + (parseInt(heightInches) || 0);
				}

				const response = await fetch('/api/settings', {
					method: 'POST',
					headers: { 'Content-Type': 'application/json' },
					body: JSON.stringify(settings)
				});

				if (!response.ok) {
					console.error('Failed to save settings');
				}
			} catch (error) {
				console.error('Error saving settings:', error);
			} finally {
				isSaving = false;
			}
		}, 500);
	}

	async function exportHistory() {
		isExporting = true;
		try {
			const response = await fetch('/api/export');
			if (!response.ok) {
				throw new Error('Export failed');
			}
			const data = await response.json();

			// Create blob and download
			const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
			const url = URL.createObjectURL(blob);
			const a = document.createElement('a');
			a.href = url;
			a.download = `calorie-tracker-export-${new Date().toISOString().split('T')[0]}.json`;
			document.body.appendChild(a);
			a.click();
			document.body.removeChild(a);
			URL.revokeObjectURL(url);
		} catch (error) {
			console.error('Export failed:', error);
			alert('Failed to export history. Please try again.');
		} finally {
			isExporting = false;
		}
	}
</script>

<div class="settings-page">
	<div class="header">
		<button class="back-btn" onclick={() => goto('/')}>
			<ArrowLeft size={20} />
			Back
		</button>
		<h1>Settings</h1>
	</div>

	{#if loading}
		<div class="loading-state">
			<LoadingSkeleton width="100%" height="60px" />
			<LoadingSkeleton width="100%" height="60px" />
			<LoadingSkeleton width="100%" height="60px" />
			<LoadingSkeleton width="100%" height="60px" />
		</div>
	{:else}
		<div>
			<!-- Display Mode Section -->
			<section class="settings-section">
				<h2>Display Preferences</h2>
				<div class="form-group">
					<label class="toggle-label">
						<div class="toggle-info">
							<span class="label-text">Protein-Focused Mode</span>
							<span class="label-description">Hide calories and focus on protein tracking</span>
						</div>
						<label class="toggle-switch">
							<input
								type="checkbox"
								bind:checked={settings.protein_focused_mode}
								onchange={(e) => {
									settings.protein_focused_mode = e.target.checked ? 1 : 0;
									autoSave();
								}}
							/>
							<span class="slider"></span>
						</label>
					</label>
				</div>
			</section>

			<!-- Physical Stats Section -->
			<section class="settings-section">
				<h2>Physical Stats</h2>

				<div class="form-group">
					<label for="weight">Weight</label>
					<div class="input-with-unit">
						<input
							id="weight"
							type="number"
							step="0.1"
							bind:value={settings.weight}
							oninput={autoSave}
							placeholder="Enter weight"
						/>
						<select bind:value={settings.weight_unit} onchange={autoSave}>
							<option value="lbs">lbs</option>
							<option value="kg">kg</option>
						</select>
					</div>
				</div>

				<div class="form-group">
					<label for="height">Height</label>
					{#if settings.height_unit === 'in'}
						<div class="height-inputs">
							<input
								type="number"
								bind:value={heightFeet}
								oninput={autoSave}
								placeholder="Feet"
							/>
							<input
								type="number"
								bind:value={heightInches}
								oninput={autoSave}
								placeholder="Inches"
							/>
							<select bind:value={settings.height_unit} onchange={autoSave}>
								<option value="in">ft/in</option>
								<option value="cm">cm</option>
							</select>
						</div>
					{:else}
						<div class="input-with-unit">
							<input
								id="height"
								type="number"
								step="0.1"
								bind:value={settings.height}
								oninput={autoSave}
								placeholder="Enter height"
							/>
							<select bind:value={settings.height_unit} onchange={autoSave}>
								<option value="in">ft/in</option>
								<option value="cm">cm</option>
							</select>
						</div>
					{/if}
				</div>

				<div class="form-group">
					<label for="age">Age</label>
					<input
						id="age"
						type="number"
						bind:value={settings.age}
						oninput={autoSave}
						placeholder="Enter age"
					/>
				</div>

				<div class="form-group">
					<label for="gender">Gender</label>
					<select id="gender" bind:value={settings.gender} onchange={autoSave}>
						<option value="">Select gender</option>
						<option value="male">Male</option>
						<option value="female">Female</option>
					</select>
				</div>

				<div class="form-group">
					<label for="activity">Activity Level</label>
					<select id="activity" bind:value={settings.activity_level} onchange={autoSave}>
						<option value="">Select activity level</option>
						<option value="sedentary">Sedentary (little to no exercise)</option>
						<option value="light">Light (exercise 1-3 days/week)</option>
						<option value="moderate">Moderate (exercise 3-5 days/week)</option>
						<option value="active">Active (exercise 6-7 days/week)</option>
						<option value="very_active">Very Active (intense exercise daily)</option>
					</select>
				</div>
			</section>

			<!-- Goals Section -->
			<section class="settings-section">
				<h2>Goals</h2>

				<div class="form-group">
					<label for="calories">Daily Calorie Target</label>
					<div class="input-with-button">
						<input
							id="calories"
							type="number"
							bind:value={settings.maintenance_calories}
							oninput={autoSave}
							placeholder="Enter target"
						/>
						<button type="button" class="calculate-btn" onclick={calculateTDEE}>
							Auto Calculate
						</button>
					</div>
					<span class="helper-text">Based on your stats, this is your maintenance calories</span>
				</div>

				<div class="form-group">
					<label for="protein">Daily Protein Goal (grams)</label>
					<div class="input-with-button">
						<input
							id="protein"
							type="number"
							bind:value={settings.protein_goal}
							oninput={autoSave}
							placeholder="Enter protein goal"
						/>
						<button type="button" class="calculate-btn" onclick={calculateProteinGoal}>
							Auto Calculate
						</button>
					</div>
					<span class="helper-text">Recommended: 0.8-1g per lb of body weight</span>
				</div>
			</section>

			<!-- Data Export Section -->
			<section class="settings-section">
				<h2>Data Export</h2>
				<div class="form-group">
					<label>Export Complete History</label>
					<button type="button" class="export-btn" onclick={exportHistory} disabled={isExporting}>
						{isExporting ? 'EXPORTING...' : 'EXPORT AS JSON'}
					</button>
					<span class="helper-text">Download all your meal data in LLM-friendly JSON format</span>
				</div>
			</section>
		</div>
	{/if}
</div>

<style>
	.settings-page {
		max-width: 600px;
		margin: 0 auto;
		padding: 1rem;
		min-height: 100vh;
	}

	.header {
		display: flex;
		align-items: center;
		gap: 1rem;
		margin-bottom: 2rem;
		position: sticky;
		top: 0;
		background: var(--bg);
		padding: 1rem 0;
		z-index: 10;
	}

	.back-btn {
		display: flex;
		align-items: center;
		gap: 0.5rem;
		background: transparent;
		border: 1px solid var(--border);
		color: var(--text);
		padding: 0.5rem 1rem;
		border-radius: 8px;
		cursor: pointer;
		transition: all 0.2s;
		font-size: 0.875rem;
	}

	.back-btn:hover {
		background: var(--surface);
		border-color: #333;
	}

	h1 {
		font-size: 1.5rem;
		font-weight: 700;
		margin: 0;
		color: var(--text);
	}

	.loading-state {
		display: flex;
		flex-direction: column;
		gap: 1rem;
	}

	form {
		display: flex;
		flex-direction: column;
		gap: 2rem;
	}

	.settings-section {
		background: var(--surface);
		border: 1px solid var(--border);
		border-radius: 12px;
		padding: 1.5rem;
		display: flex;
		flex-direction: column;
		gap: 1.5rem;
		margin: 1.5rem;
	}

	.settings-section h2 {
		font-size: 1.125rem;
		font-weight: 600;
		margin: 0;
		color: var(--text);
		padding-bottom: 0.75rem;
		border-bottom: 1px solid var(--border);
	}

	.form-group {
		display: flex;
		flex-direction: column;
		gap: 0.5rem;
	}

	label {
		font-size: 0.875rem;
		font-weight: 500;
		color: #aaa;
	}

	input[type="number"],
	input[type="text"],
	select {
		background: #0a0a0a;
		border: 1px solid var(--border);
		color: var(--text);
		padding: 0.75rem;
		border-radius: 8px;
		font-size: 1rem;
		transition: all 0.2s;
	}

	input:focus,
	select:focus {
		outline: none;
		border-color: #444;
		background: #111;
	}

	.input-with-unit {
		display: flex;
		flex-wrap: wrap;
		gap: 0.5rem;
	}

	.input-with-unit input {
		flex: 1 1 120px;
		min-width: 0;
	}

	.input-with-unit select {
		flex: 0 0 auto;
		min-width: 80px;
	}

	.height-inputs {
		display: flex;
		flex-wrap: wrap;
		gap: 0.5rem;
	}

	.height-inputs input {
		flex: 1 1 60px;
		min-width: 0;
	}

	.height-inputs select {
		flex: 0 0 auto;
		min-width: 80px;
	}

	.input-with-button {
		display: flex;
		flex-wrap: wrap;
		gap: 0.5rem;
	}

	.input-with-button input {
		flex: 1 1 150px;
		min-width: 0;
	}

	.input-with-button .calculate-btn {
		flex: 0 0 auto;
	}

	.calculate-btn {
		background: transparent;
		border: 1px solid var(--border);
		color: var(--text);
		padding: 0.75rem 1rem;
		border-radius: 8px;
		font-size: 0.875rem;
		cursor: pointer;
		transition: all 0.2s;
		white-space: nowrap;
	}

	.calculate-btn:hover {
		background: #1a1a1a;
		border-color: #444;
	}

	.helper-text {
		font-size: 0.75rem;
		color: #666;
		font-style: italic;
	}

	.toggle-label {
		display: flex;
		justify-content: space-between;
		align-items: center;
		gap: 1rem;
		cursor: pointer;
		padding: 0.5rem;
		border-radius: 8px;
		transition: background 0.2s;
	}

	.toggle-label:hover {
		background: #0a0a0a;
	}

	.toggle-info {
		display: flex;
		flex-direction: column;
		gap: 0.25rem;
		flex: 1;
	}

	.label-text {
		font-size: 0.875rem;
		font-weight: 500;
		color: var(--text);
	}

	.label-description {
		font-size: 0.75rem;
		color: #666;
	}

	.toggle-switch {
		position: relative;
		display: inline-block;
		width: 50px;
		height: 28px;
	}

	.toggle-switch input {
		opacity: 0;
		width: 0;
		height: 0;
	}

	.slider {
		position: absolute;
		cursor: pointer;
		top: 0;
		left: 0;
		right: 0;
		bottom: 0;
		background-color: #2a2a2a;
		transition: 0.3s;
		border-radius: 28px;
		border: 1px solid var(--border);
	}

	.slider:before {
		position: absolute;
		content: "";
		height: 20px;
		width: 20px;
		left: 4px;
		bottom: 3px;
		background-color: white;
		transition: 0.3s;
		border-radius: 50%;
	}

	input:checked + .slider {
		background-color: #4ade80;
		border-color: #4ade80;
	}

	input:checked + .slider:before {
		transform: translateX(22px);
	}

	.export-btn {
		background: transparent;
		border: 1px solid var(--border);
		color: var(--text);
		padding: 0.75rem 1.5rem;
		border-radius: 8px;
		font-size: 0.875rem;
		font-weight: 600;
		letter-spacing: 0.05em;
		cursor: pointer;
		transition: all 0.2s;
		text-transform: uppercase;
	}

	.export-btn:hover:not(:disabled) {
		background: #1a1a1a;
		border-color: #4ade80;
		color: #4ade80;
	}

	.export-btn:disabled {
		opacity: 0.5;
		cursor: not-allowed;
	}
</style>
