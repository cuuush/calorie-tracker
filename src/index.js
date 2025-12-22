import OpenAI from 'openai';



async function encodeImageToBase64(imageFile) {
  const arrayBuffer = await imageFile.arrayBuffer();
  const bytes = new Uint8Array(arrayBuffer);
  let binary = '';
  for (let i = 0; i < bytes.byteLength; i++) {
    binary += String.fromCharCode(bytes[i]);
  }
  const base64Image = btoa(binary);
  const mimeType = imageFile.type || 'image/jpeg';
  return `data:${mimeType};base64,${base64Image}`;
}


export default {

  async fetch(request, env) {
    const url = new URL(request.url);

    // Serve HTML page
    if (url.pathname === '/' && request.method === 'GET') {
      return new Response(HTML, {
        headers: { 'Content-Type': 'text/html' }
      });
    }

    // Handle image upload and calorie estimation
    if (url.pathname === '/analyze' && request.method === 'POST') {
      try {
        const formData = await request.formData();
        const imageFile = formData.get('image');
        const userMessage = formData.get('message') || '';

        if (!imageFile) {
          return new Response(JSON.stringify({ error: 'No image provided' }), {
            status: 400,
            headers: { 'Content-Type': 'application/json' }
          });
        }


        const base64Image = await encodeImageToBase64(imageFile);


        // Initialize OpenAI client with OpenRouter
        const client = new OpenAI({
          baseURL: 'https://openrouter.ai/api/v1',
          apiKey: env.OPENROUTER_API_KEY,
          defaultHeaders: {
            'HTTP-Referer': request.url,
            'X-Title': 'Calorie Tracker'
          }
        });



        // Call OpenRouter API with Gemini Flash using OpenAI SDK
        const completion = await client.chat.completions.create({
          model: 'google/gemini-3-flash-preview',
          messages: [
            {
              role: 'user',
              content: [
                {
                  type: 'text',
                  text: 'Analyze this food image and estimate the nutritional content. Provide a breakdown of each food item with calories, protein (grams), and carbs (grams). Format your response as JSON with the following structure: {"items": [{"name": "food name", "calories": number, "protein": number, "carbs": number}]}'
                },
                {
                  type: 'image_url',
                  image_url: {
                    url: base64Image
                  }
                }
              ]
            }
          ],
          reasoning: { enabled: true }
        });

        // Extract message with reasoning_details
        const message = completion.choices[0].message;
        const content = message.content;
        const reasoning_details = message.reasoning_details;

        // Try to parse JSON from the response
        let calorieData;
        try {
          // Extract JSON from markdown code blocks if present
          const jsonMatch = content.match(/```json\s*([\s\S]*?)\s*```/) || content.match(/\{[\s\S]*\}/);
          const jsonStr = jsonMatch ? (jsonMatch[1] || jsonMatch[0]) : content;
          calorieData = JSON.parse(jsonStr);
        } catch (e) {
          // If parsing fails, return raw content
          calorieData = {
            raw_response: content,
            total_calories: null,
            items: []
          };
        }

        // Calculate totals ourselves
        if (calorieData.items && calorieData.items.length > 0) {
          calorieData.total_calories = calorieData.items.reduce((sum, item) => sum + (item.calories || 0), 0);
          calorieData.total_protein = Math.round(calorieData.items.reduce((sum, item) => sum + (item.protein || 0), 0) * 10) / 10;
          calorieData.total_carbs = Math.round(calorieData.items.reduce((sum, item) => sum + (item.carbs || 0), 0) * 10) / 10;
        }

        // Extract reasoning text from reasoning_details structure
        if (reasoning_details) {
          let reasoningText = '';
          if (Array.isArray(reasoning_details)) {
            // Extract text from Gemini's reasoning format
            for (const item of reasoning_details) {
              if (item.type === 'reasoning.text' && item.text) {
                reasoningText += item.text;
              }
            }
          } else if (typeof reasoning_details === 'string') {
            reasoningText = reasoning_details;
          }

          calorieData.reasoning = reasoningText || reasoning_details;
          calorieData.reasoning_details = reasoning_details; // Keep original for followup
        }

        // Build conversation history for potential followup
        const initialMessage = {
          role: 'user',
          content: [
            {
              type: 'text',
              text: 'Analyze this food image and estimate the nutritional content. Provide a breakdown of each food item with calories, protein (grams), and carbs (grams). Format your response as JSON with the following structure: {"items": [{"name": "food name", "calories": number, "protein": number, "carbs": number}]}'
            },
            {
              type: 'image_url',
              image_url: {
                url: base64Image
              }
            }
          ]
        };

        const assistantMessage = {
          role: 'assistant',
          content: content,
          reasoning_details: calorieData.reasoning_details // Use full reasoning_details
        };

        calorieData.messages = [initialMessage, assistantMessage];
        calorieData.user_message = userMessage;

        // Store in D1 database
        if (env.DB) {
          const entryId = `${Date.now()}-${Math.random().toString(36).substring(7)}`;

          await env.DB.prepare(`
            INSERT INTO nutrition_entries (
              id, user_message, total_calories, total_protein, total_carbs,
              items, reasoning, reasoning_details, conversation_messages, raw_response, notes
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
          `).bind(
            entryId,
            userMessage || null,
            calorieData.total_calories || null,
            calorieData.total_protein || null,
            calorieData.total_carbs || null,
            JSON.stringify(calorieData.items || []),
            calorieData.reasoning || null,
            JSON.stringify(calorieData.reasoning_details || null),
            JSON.stringify(calorieData.messages || []),
            calorieData.raw_response || null,
            calorieData.notes || null
          ).run();

          calorieData.entry_id = entryId;
        }

        return new Response(JSON.stringify(calorieData), {
          headers: { 'Content-Type': 'application/json' }
        });

      } catch (error) {
        return new Response(JSON.stringify({ error: error.message }), {
          status: 500,
          headers: { 'Content-Type': 'application/json' }
        });
      }
    }

    // Handle followup messages
    if (url.pathname === '/followup' && request.method === 'POST') {
      try {
        const body = await request.json();
        const { messages, followupQuestion } = body;

        if (!messages || !Array.isArray(messages)) {
          return new Response(JSON.stringify({ error: 'Invalid messages array' }), {
            status: 400,
            headers: { 'Content-Type': 'application/json' }
          });
        }

        if (!followupQuestion) {
          return new Response(JSON.stringify({ error: 'No followup question provided' }), {
            status: 400,
            headers: { 'Content-Type': 'application/json' }
          });
        }

        // Initialize OpenAI client with OpenRouter
        const client = new OpenAI({
          baseURL: 'https://openrouter.ai/api/v1',
          apiKey: env.OPENROUTER_API_KEY,
          defaultHeaders: {
            'HTTP-Referer': request.url,
            'X-Title': 'Calorie Tracker'
          }
        });

        // Add the new followup question to the conversation
        const conversationMessages = [
          ...messages,
          {
            role: 'user',
            content: followupQuestion
          }
        ];

        // Call API with preserved reasoning_details in conversation history
        const completion = await client.chat.completions.create({
          model: 'google/gemini-3-flash-preview',
          messages: conversationMessages,
          reasoning: { enabled: true }
        });

        // Extract message with reasoning_details
        const message = completion.choices[0].message;
        const followupReasoningDetails = message.reasoning_details;

        // Extract reasoning text
        let reasoningText = '';
        if (followupReasoningDetails) {
          if (Array.isArray(followupReasoningDetails)) {
            for (const item of followupReasoningDetails) {
              if (item.type === 'reasoning.text' && item.text) {
                reasoningText += item.text;
              }
            }
          } else if (typeof followupReasoningDetails === 'string') {
            reasoningText = followupReasoningDetails;
          }
        }

        return new Response(JSON.stringify({
          content: message.content,
          reasoning: reasoningText || followupReasoningDetails,
          reasoning_details: followupReasoningDetails,
          // Return updated conversation history for next followup
          messages: [
            ...conversationMessages,
            {
              role: 'assistant',
              content: message.content,
              reasoning_details: followupReasoningDetails
            }
          ]
        }), {
          headers: { 'Content-Type': 'application/json' }
        });

      } catch (error) {
        return new Response(JSON.stringify({ error: error.message }), {
          status: 500,
          headers: { 'Content-Type': 'application/json' }
        });
      }
    }

    // Get calorie history
    if (url.pathname === '/history' && request.method === 'GET') {
      if (!env.CALORIE_HISTORY) {
        return new Response(JSON.stringify({ error: 'History not enabled' }), {
          status: 501,
          headers: { 'Content-Type': 'application/json' }
        });
      }

      const list = await env.CALORIE_HISTORY.list();
      const entries = await Promise.all(
        list.keys.map(async (key) => {
          const value = await env.CALORIE_HISTORY.get(key.name);
          return JSON.parse(value);
        })
      );

      return new Response(JSON.stringify(entries.sort((a, b) =>
        new Date(b.timestamp) - new Date(a.timestamp)
      )), {
        headers: { 'Content-Type': 'application/json' }
      });
    }

    return new Response('Not Found', { status: 404 });
  }
};

const HTML = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Calorie Tracker</title>
  <style>
    * {
      margin: 0;
      padding: 0;
      box-sizing: border-box;
    }

    body {
      font-family: 'Helvetica Neue', -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
      background: #0a0a0a;
      min-height: 100vh;
      padding: 20px;
      color: #ffffff;
    }

    .container {
      max-width: 700px;
      margin: 0 auto;
    }

    h1 {
      color: #ffffff;
      margin-bottom: 40px;
      text-align: center;
      font-size: 2.5em;
      font-weight: 300;
      letter-spacing: 2px;
      text-transform: uppercase;
    }

    .upload-area {
      border: 2px solid #333;
      border-radius: 4px;
      padding: 60px 40px;
      text-align: center;
      cursor: pointer;
      transition: all 0.3s ease;
      margin-bottom: 30px;
      background: #111;
    }

    .upload-area:hover {
      border-color: #666;
      background: #1a1a1a;
    }

    .upload-area.dragover {
      border-color: #999;
      background: #1a1a1a;
    }

    .upload-text {
      font-size: 0.95em;
      color: #888;
      text-transform: uppercase;
      letter-spacing: 1px;
      font-weight: 400;
    }

    .upload-subtext {
      font-size: 0.85em;
      color: #555;
      margin-top: 10px;
      letter-spacing: 0.5px;
    }

    #imageInput {
      display: none;
    }

    .preview {
      max-width: 100%;
      max-height: 400px;
      margin: 30px 0;
      border-radius: 4px;
      display: none;
      box-shadow: 0 10px 40px rgba(0,0,0,0.5);
    }

    button {
      background: #ffffff;
      color: #000000;
      border: none;
      padding: 18px 40px;
      border-radius: 2px;
      font-size: 0.9em;
      cursor: pointer;
      width: 100%;
      font-weight: 500;
      letter-spacing: 1.5px;
      text-transform: uppercase;
      transition: all 0.2s ease;
    }

    button:hover {
      background: #e0e0e0;
    }

    button:disabled {
      opacity: 0.4;
      cursor: not-allowed;
    }

    .result {
      margin-top: 40px;
      display: none;
    }

    .total-calories {
      font-size: 3.5em;
      font-weight: 200;
      color: #ffffff;
      text-align: center;
      margin-bottom: 20px;
      letter-spacing: 2px;
    }

    .macros {
      display: flex;
      justify-content: center;
      gap: 40px;
      margin-bottom: 40px;
      padding-bottom: 30px;
      border-bottom: 1px solid #222;
    }

    .macro-item {
      text-align: center;
    }

    .macro-label {
      font-size: 0.75em;
      color: #555;
      text-transform: uppercase;
      letter-spacing: 1px;
      margin-bottom: 5px;
    }

    .macro-value {
      font-size: 1.5em;
      color: #aaa;
      font-weight: 300;
    }

    .food-items {
      margin-bottom: 30px;
    }

    .food-item {
      padding: 20px 0;
      border-bottom: 1px solid #222;
      display: flex;
      justify-content: space-between;
      align-items: center;
    }

    .food-item:last-child {
      border-bottom: none;
    }

    .food-name {
      font-weight: 300;
      color: #ccc;
      font-size: 1.1em;
      letter-spacing: 0.5px;
    }

    .food-calories {
      color: #888;
      font-weight: 300;
      font-size: 1.1em;
    }

    .notes {
      margin-top: 30px;
      padding: 20px;
      background: #111;
      border-left: 2px solid #333;
      color: #888;
      font-size: 0.9em;
      line-height: 1.6;
      display: none;
    }

    .reasoning {
      margin-top: 30px;
      padding: 20px;
      background: #111;
      border-left: 2px solid #444;
      color: #888;
      font-size: 0.85em;
      display: none;
      white-space: pre-wrap;
      line-height: 1.8;
    }

    .reasoning-title {
      font-weight: 500;
      margin-bottom: 15px;
      color: #aaa;
      text-transform: uppercase;
      letter-spacing: 1px;
      font-size: 0.9em;
    }

    .chat-section {
      margin-top: 40px;
      padding-top: 40px;
      border-top: 1px solid #222;
      display: none;
    }

    .chat-messages {
      max-height: 400px;
      overflow-y: auto;
      margin-bottom: 20px;
      padding-right: 10px;
    }

    .chat-messages::-webkit-scrollbar {
      width: 4px;
    }

    .chat-messages::-webkit-scrollbar-track {
      background: #111;
    }

    .chat-messages::-webkit-scrollbar-thumb {
      background: #333;
      border-radius: 2px;
    }

    .chat-message {
      margin-bottom: 25px;
      animation: fadeIn 0.3s ease;
    }

    @keyframes fadeIn {
      from { opacity: 0; transform: translateY(10px); }
      to { opacity: 1; transform: translateY(0); }
    }

    .chat-label {
      font-size: 0.75em;
      color: #555;
      text-transform: uppercase;
      letter-spacing: 1px;
      margin-bottom: 8px;
    }

    .chat-content {
      color: #ccc;
      line-height: 1.6;
      font-size: 0.95em;
      font-weight: 300;
    }

    .chat-reasoning {
      margin-top: 10px;
      padding: 15px;
      background: #0d0d0d;
      border-left: 2px solid #333;
      font-size: 0.85em;
      color: #777;
      line-height: 1.6;
      white-space: pre-wrap;
    }

    .chat-input-container {
      display: flex;
      gap: 10px;
    }

    .chat-input {
      flex: 1;
      background: #111;
      border: 1px solid #333;
      border-radius: 2px;
      padding: 15px 20px;
      color: #fff;
      font-size: 0.95em;
      font-family: inherit;
      transition: border-color 0.2s ease;
    }

    .chat-input:focus {
      outline: none;
      border-color: #555;
    }

    .chat-input::placeholder {
      color: #444;
    }

    .chat-send-btn {
      background: #ffffff;
      color: #000000;
      border: none;
      padding: 15px 30px;
      border-radius: 2px;
      font-size: 0.85em;
      cursor: pointer;
      font-weight: 500;
      letter-spacing: 1.5px;
      text-transform: uppercase;
      transition: all 0.2s ease;
      white-space: nowrap;
    }

    .chat-send-btn:hover:not(:disabled) {
      background: #e0e0e0;
    }

    .chat-send-btn:disabled {
      opacity: 0.4;
      cursor: not-allowed;
    }

    .error {
      background: #1a0000;
      border-left: 2px solid #660000;
      color: #ff6666;
      padding: 20px;
      margin-top: 20px;
      display: none;
      font-size: 0.9em;
    }

    .loading {
      text-align: center;
      padding: 40px;
      display: none;
    }

    .spinner {
      border: 2px solid #222;
      border-top: 2px solid #888;
      border-radius: 50%;
      width: 40px;
      height: 40px;
      animation: spin 1s linear infinite;
      margin: 0 auto;
    }

    .loading-text {
      margin-top: 20px;
      color: #666;
      font-size: 0.9em;
      text-transform: uppercase;
      letter-spacing: 1px;
    }

    @keyframes spin {
      0% { transform: rotate(0deg); }
      100% { transform: rotate(360deg); }
    }
  </style>
</head>
<body>
  <div class="container">
    <h1>Nutrition</h1>

    <div class="upload-area" id="uploadArea">
      <p class="upload-text">Upload Image</p>
      <p class="upload-subtext">Click or drag to analyze</p>
      <input type="file" id="imageInput" accept="image/*" capture="environment">
    </div>

    <img id="preview" class="preview" alt="Preview">

    <div id="messageContainer" style="display: none; margin: 30px 0;">
      <input
        type="text"
        class="chat-input"
        id="messageInput"
        placeholder="Add a note (optional)..."
        autocomplete="off"
      >
    </div>

    <button id="analyzeBtn" style="display: none;">Analyze</button>

    <div class="loading" id="loading">
      <div class="spinner"></div>
      <p class="loading-text">Analyzing</p>
    </div>

    <div class="error" id="error"></div>

    <div class="result" id="result">
      <div class="total-calories" id="totalCalories"></div>
      <div class="food-items" id="foodItems"></div>
      <div class="notes" id="notes"></div>
      <div class="reasoning" id="reasoning">
        <div class="reasoning-title">Reasoning</div>
        <div id="reasoningContent"></div>
      </div>
    </div>

    <div class="chat-section" id="chatSection">
      <div class="chat-messages" id="chatMessages"></div>
      <div class="chat-input-container">
        <input
          type="text"
          class="chat-input"
          id="chatInput"
          placeholder="Ask a follow-up question..."
          autocomplete="off"
        >
        <button class="chat-send-btn" id="chatSendBtn">Send</button>
      </div>
    </div>
  </div>

  <script>
    const uploadArea = document.getElementById('uploadArea');
    const imageInput = document.getElementById('imageInput');
    const preview = document.getElementById('preview');
    const analyzeBtn = document.getElementById('analyzeBtn');
    const loading = document.getElementById('loading');
    const result = document.getElementById('result');
    const error = document.getElementById('error');
    const chatSection = document.getElementById('chatSection');
    const chatMessages = document.getElementById('chatMessages');
    const chatInput = document.getElementById('chatInput');
    const chatSendBtn = document.getElementById('chatSendBtn');
    const messageContainer = document.getElementById('messageContainer');
    const messageInput = document.getElementById('messageInput');

    let conversationMessages = [];

    uploadArea.addEventListener('click', () => imageInput.click());

    uploadArea.addEventListener('dragover', (e) => {
      e.preventDefault();
      uploadArea.classList.add('dragover');
    });

    uploadArea.addEventListener('dragleave', () => {
      uploadArea.classList.remove('dragover');
    });

    uploadArea.addEventListener('drop', (e) => {
      e.preventDefault();
      uploadArea.classList.remove('dragover');
      const files = e.dataTransfer.files;
      if (files.length > 0) {
        handleFile(files[0]);
      }
    });

    imageInput.addEventListener('change', (e) => {
      if (e.target.files.length > 0) {
        handleFile(e.target.files[0]);
      }
    });

    function handleFile(file) {
      if (!file.type.startsWith('image/')) {
        showError('Please select an image file');
        return;
      }

      const reader = new FileReader();
      reader.onload = (e) => {
        preview.src = e.target.result;
        preview.style.display = 'block';
        messageContainer.style.display = 'block';
        analyzeBtn.style.display = 'block';
        result.style.display = 'none';
        chatSection.style.display = 'none';
        chatMessages.innerHTML = '';
        conversationMessages = [];
        messageInput.value = '';
        error.style.display = 'none';
      };
      reader.readAsDataURL(file);
    }

    analyzeBtn.addEventListener('click', async () => {
      const file = imageInput.files[0];
      if (!file) return;

      const formData = new FormData();
      formData.append('image', file);
      const userMessage = messageInput.value.trim();
      if (userMessage) {
        formData.append('message', userMessage);
      }

      loading.style.display = 'block';
      analyzeBtn.disabled = true;
      result.style.display = 'none';
      chatSection.style.display = 'none';
      error.style.display = 'none';

      try {
        const response = await fetch('/analyze', {
          method: 'POST',
          body: formData
        });

        const data = await response.json();

        if (!response.ok) {
          throw new Error(data.error || 'Analysis failed');
        }

        conversationMessages = data.messages || [];
        displayResult(data);
        chatSection.style.display = 'block';
      } catch (err) {
        showError(err.message);
      } finally {
        loading.style.display = 'none';
        analyzeBtn.disabled = false;
      }
    });

    chatSendBtn.addEventListener('click', sendFollowup);
    chatInput.addEventListener('keypress', (e) => {
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        sendFollowup();
      }
    });

    async function sendFollowup() {
      const question = chatInput.value.trim();
      if (!question || !conversationMessages.length) return;

      // Add user message to chat
      addChatMessage('You', question);
      chatInput.value = '';
      chatSendBtn.disabled = true;

      try {
        const response = await fetch('/followup', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            messages: conversationMessages,
            followupQuestion: question
          })
        });

        const data = await response.json();

        if (!response.ok) {
          throw new Error(data.error || 'Followup failed');
        }

        // Update conversation history
        conversationMessages = data.messages;

        // Add assistant response to chat
        addChatMessage('Assistant', data.content, data.reasoning);

      } catch (err) {
        showError(err.message);
      } finally {
        chatSendBtn.disabled = false;
        chatInput.focus();
      }
    }

    function addChatMessage(label, content, reasoning) {
      const messageDiv = document.createElement('div');
      messageDiv.className = 'chat-message';

      const labelDiv = document.createElement('div');
      labelDiv.className = 'chat-label';
      labelDiv.textContent = label;

      const contentDiv = document.createElement('div');
      contentDiv.className = 'chat-content';
      contentDiv.textContent = content;

      messageDiv.appendChild(labelDiv);
      messageDiv.appendChild(contentDiv);

      if (reasoning) {
        const reasoningDiv = document.createElement('div');
        reasoningDiv.className = 'chat-reasoning';
        reasoningDiv.textContent = reasoning;
        messageDiv.appendChild(reasoningDiv);
      }

      chatMessages.appendChild(messageDiv);
      chatMessages.scrollTop = chatMessages.scrollHeight;
    }

    function displayResult(data) {
      if (data.raw_response) {
        document.getElementById('totalCalories').textContent = 'Response received';
        document.getElementById('foodItems').innerHTML = '<pre style="white-space: pre-wrap; color: #888;">' + data.raw_response + '</pre>';
      } else {
        const totalCal = data.total_calories || 0;
        document.getElementById('totalCalories').textContent = totalCal;

        const itemsHtml = (data.items || []).map(item => \`
          <div class="food-item">
            <span class="food-name">\${item.name}</span>
            <span class="food-calories">\${item.calories} cal</span>
          </div>
        \`).join('');

        document.getElementById('foodItems').innerHTML = itemsHtml;

        if (data.notes) {
          document.getElementById('notes').textContent = data.notes;
          document.getElementById('notes').style.display = 'block';
        } else {
          document.getElementById('notes').style.display = 'none';
        }
      }

      // Display reasoning if available
      if (data.reasoning) {
        const reasoningContent = typeof data.reasoning === 'string'
          ? data.reasoning
          : JSON.stringify(data.reasoning, null, 2);

        document.getElementById('reasoningContent').textContent = reasoningContent;
        document.getElementById('reasoning').style.display = 'block';
      } else {
        document.getElementById('reasoning').style.display = 'none';
      }

      result.style.display = 'block';
    }

    function showError(message) {
      error.textContent = message;
      error.style.display = 'block';
    }
  </script>
</body>
</html>
`;
