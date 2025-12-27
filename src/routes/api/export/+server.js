import { json } from '@sveltejs/kit';

export async function GET({ platform, locals }) {
	const userId = locals.user?.id;
	if (!userId) {
		return json({ error: 'Unauthorized' }, { status: 401 });
	}

	const db = platform.env.DB;

	try {
		// Get user settings
		const settings = await db.prepare(
			'SELECT * FROM user_settings WHERE user_id = ?'
		).bind(userId).first();

		// Get all entries
		const entries = await db.prepare(
			'SELECT * FROM nutrition_entries WHERE user_id = ? ORDER BY timestamp DESC'
		).bind(userId).all();

		// Group entries by date
		const entriesByDate = {};
		for (const entry of entries.results) {
			const date = new Date(entry.timestamp);
			const dateKey = date.toISOString().split('T')[0];

			if (!entriesByDate[dateKey]) {
				entriesByDate[dateKey] = {
					date: dateKey,
					dayOfWeek: date.toLocaleDateString('en-US', { weekday: 'long' }),
					entries: [],
					totalCalories: 0,
					totalProtein: 0,
					totalCarbs: 0,
					totalFat: 0
				};
			}

			// Parse items
			const items = typeof entry.items === 'string' ? JSON.parse(entry.items) : entry.items;

			// Format entry
			const formattedEntry = {
				id: entry.id,
				timestamp: entry.timestamp,
				timeOfDay: new Date(entry.timestamp).toLocaleTimeString('en-US', {
					hour: '2-digit',
					minute: '2-digit',
					hour12: true
				}),
				mealType: getMealType(entry.timestamp),
				mealTitle: entry.meal_title,
				userMessage: entry.user_message,
				items: items.map(item => ({
					name: item.name,
					calories: item.calories,
					protein: item.protein,
					carbs: item.carbs,
					fat: item.fat
				})),
				totals: {
					calories: entry.total_calories,
					protein: entry.total_protein,
					carbs: entry.total_carbs,
					fat: entry.total_fat
				},
				reasoning: entry.reasoning
			};

			entriesByDate[dateKey].entries.push(formattedEntry);
			entriesByDate[dateKey].totalCalories += entry.total_calories || 0;
			entriesByDate[dateKey].totalProtein += entry.total_protein || 0;
			entriesByDate[dateKey].totalCarbs += entry.total_carbs || 0;
			entriesByDate[dateKey].totalFat += entry.total_fat || 0;
		}

		// Calculate percentages and add summary for each day
		const dailyGoalCalories = settings?.maintenance_calories || 2000;
		const dailyGoalProtein = settings?.protein_goal || 150;

		const dailySummaries = Object.values(entriesByDate).map(day => ({
			...day,
			percentages: {
				caloriesPercent: Math.round((day.totalCalories / dailyGoalCalories) * 100),
				proteinPercent: Math.round((day.totalProtein / dailyGoalProtein) * 100)
			},
			remaining: {
				calories: Math.max(0, dailyGoalCalories - day.totalCalories),
				protein: Math.max(0, dailyGoalProtein - day.totalProtein)
			}
		}));

		// Calculate overall stats
		const totalDays = dailySummaries.length;
		const avgCalories = totalDays > 0
			? Math.round(dailySummaries.reduce((sum, day) => sum + day.totalCalories, 0) / totalDays)
			: 0;
		const avgProtein = totalDays > 0
			? Math.round(dailySummaries.reduce((sum, day) => sum + day.totalProtein, 0) / totalDays)
			: 0;

		// Build LLM-friendly export
		const exportData = {
			exportInfo: {
				exportDate: new Date().toISOString(),
				totalDays: totalDays,
				totalEntries: entries.results.length
			},
			userProfile: {
				goals: {
					dailyCalories: dailyGoalCalories,
					dailyProtein: dailyGoalProtein
				},
				physicalStats: settings ? {
					weight: settings.weight,
					weightUnit: settings.weight_unit,
					height: settings.height,
					heightUnit: settings.height_unit,
					age: settings.age,
					gender: settings.gender,
					activityLevel: settings.activity_level
				} : null,
				preferences: {
					proteinFocusedMode: settings?.protein_focused_mode === 1
				}
			},
			overallStats: {
				averageDailyCalories: avgCalories,
				averageDailyProtein: avgProtein,
				averageCaloriesVsGoal: Math.round((avgCalories / dailyGoalCalories) * 100),
				averageProteinVsGoal: Math.round((avgProtein / dailyGoalProtein) * 100)
			},
			dailyHistory: dailySummaries
		};

		return json(exportData);
	} catch (error) {
		console.error('Export error:', error);
		return json({ error: 'Failed to export data' }, { status: 500 });
	}
}

function getMealType(timestamp) {
	const hours = new Date(timestamp).getHours();
	if (hours >= 5 && hours < 12) return 'breakfast';
	else if (hours >= 12 && hours < 17) return 'lunch';
	else if (hours >= 17 && hours < 22) return 'dinner';
	else return 'snack';
}
