import { test, expect } from '@playwright/test';

test.describe('Food Tracking', () => {
	test('should display tracking interface', async ({ page }) => {
		await page.goto('/');

		// Check for main UI elements
		await expect(page.locator('text=TRACKER')).toBeVisible();
		await expect(page.locator('button:has-text("Track")')).toBeVisible();
		await expect(page.locator('button:has-text("History")')).toBeVisible();
	});

	test('should allow text input for food tracking', async ({ page }) => {
		await page.goto('/');

		// Find the input field
		const input = page.locator('.chat-input').first();
		await expect(input).toBeVisible();

		// Type a meal description
		await input.fill('chicken and rice');
		await expect(input).toHaveValue('chicken and rice');
	});

	test('should have file upload and mic buttons', async ({ page }) => {
		await page.goto('/');

		// Check for image upload button
		const uploadButton = page.locator('button[title="Add Image"]');
		await expect(uploadButton).toBeVisible();

		// Check for mic button
		const micButton = page.locator('button.icon-btn').nth(1);
		await expect(micButton).toBeVisible();
	});

	test('should analyze text input and show results', async ({ page }) => {
		await page.goto('/');

		// Enter a meal
		const input = page.locator('.chat-input').first();
		await input.fill('grilled chicken with rice');

		// Click send button
		const sendButton = page.locator('button.send-btn');
		await sendButton.click();

		// Wait for analysis to complete (should use debug mode canned response)
		await page.waitForTimeout(1000);

		// Should show result view with the test meal
		await expect(page.locator('text=Test Meal')).toBeVisible();
		await expect(page.locator('text=Grilled Chicken')).toBeVisible();
		await expect(page.locator('text=Brown Rice')).toBeVisible();
	});
});

test.describe('Navigation', () => {
	test('should switch between tabs', async ({ page }) => {
		await page.goto('/');

		// Should start on Track tab
		const trackTab = page.locator('button:has-text("Track")');
		await expect(trackTab).toHaveClass(/active/);

		// Click History tab
		const historyTab = page.locator('button:has-text("History")');
		await historyTab.click();

		// Should show history view with active tab
		await expect(historyTab).toHaveClass(/active/);
	});
});
