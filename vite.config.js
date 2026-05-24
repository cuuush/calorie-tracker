import { sveltekit } from '@sveltejs/kit/vite';
import { defineConfig } from 'vite';

export default defineConfig({
	plugins: [sveltekit()],
	test: {
		include: ['src/**/*.test.js'],
		environment: 'node',
		testTimeout: 15000,
		hookTimeout: 30000
	}
});
