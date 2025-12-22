# Calorie Tracker

A Cloudflare Workers app that uses OpenRouter + Gemini Flash to estimate calories from food images.

## Setup

1. **Install dependencies:**
   ```bash
   npm install
   ```

2. **Set up OpenRouter API key:**
   - Get an API key from https://openrouter.ai/
   - Create `.dev.vars` file:
     ```
     OPENROUTER_API_KEY=your_key_here
     ```

3. **Optional: Enable history storage (KV):**
   ```bash
   npx wrangler kv:namespace create CALORIE_HISTORY
   ```
   Then uncomment the KV section in `wrangler.toml` and add the ID.

4. **Test locally:**
   ```bash
   npx wrangler dev
   ```

5. **Deploy to Cloudflare:**
   ```bash
   # Set the API key as a secret
   npx wrangler secret put OPENROUTER_API_KEY

   # Deploy
   npx wrangler deploy
   ```

## Features

- 📸 Upload food images (drag & drop or camera)
- 🤖 AI-powered calorie estimation using Gemini Flash
- 📊 Breakdown of food items and calories
- 💾 Optional history storage with KV
- 🎨 Clean, responsive UI

## Endpoints

- `GET /` - Main app interface
- `POST /analyze` - Upload image for analysis
- `GET /history` - View calorie history (if KV enabled)
