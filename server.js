import express from 'express';
import crypto from 'crypto';

const app = express();
app.use(express.json());

// Prevent unhandled errors from crashing the node process
process.on('uncaughtException', (err) => console.error('Uncaught Exception:', err));
process.on('unhandledRejection', (reason) => console.error('Unhandled Rejection:', reason));

// In-memory stores for user tokens and PKCE state
const userTokens = new Map();
const pkceStore = new Map();

// Swiggy Whitelisted Localhost Redirect URI
const SWIGGY_REDIRECT_URI = 'http://localhost/callback';

// Helper: Generate OAuth 2.1 PKCE Challenge Pair (S256)
function generatePKCE() {
  const verifier = crypto.randomBytes(32).toString('hex');
  const challenge = crypto
    .createHash('sha256')
    .update(verifier)
    .digest('base64url');
  
  return { verifier, challenge };
}

// Swiggy Core Tools Schema for OpenAI
const SWIGGY_FOOD_TOOLS = [
  {
    type: 'function',
    function: {
      name: 'search_restaurants',
      description: 'Search Swiggy for available dishes, restaurants, biryani, or pizzas.',
      parameters: {
        type: 'object',
        properties: {
          query: { type: 'string', description: 'Dish name or cuisine type, e.g. Biryani' },
          location: { type: 'string', description: 'User delivery city or neighborhood area' }
        },
        required: ['query']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'get_restaurant_menu',
      description: 'Get menu items and pricing for a specific restaurant on Swiggy.',
      parameters: {
        type: 'object',
        properties: {
          restaurant_id: { type: 'string', description: 'Restaurant ID' }
        },
        required: ['restaurant_id']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'get_addresses',
      description: 'Fetch saved delivery addresses for the logged-in Swiggy user.',
      parameters: { type: 'object', properties: {} }
    }
  }
];

// 1. GET /webhook -> Verification Handshake
app.get('/webhook', (req, res) => {
  const mode = req.query['hub.mode'];
  const token = req.query['hub.verify_token'];
  const challenge = req.query['hub.challenge'];

  if (mode === 'subscribe' && token === process.env.WEBHOOK_VERIFY_TOKEN) {
    console.log('✅ Webhook verified successfully!');
    res.status(200).send(challenge);
  } else {
    res.sendStatus(403);
  }
});

// 2. POST /webhook -> Process Incoming WhatsApp Messages
app.post('/webhook', async (req, res) => {
  res.sendStatus(200);

  try {
    const body = req.body;
    if (body.object === 'whatsapp_business_account') {
      const value = body.entry?.[0]?.changes?.[0]?.value;
      if (value?.messages?.[0]) {
        const from = value.messages[0].from;
        const text = value.messages[0].text?.body;

        console.log(`📩 Incoming message from ${from}: "${text}"`);

        if (text) {
          // Check if user pasted a redirect URL or authorization code
          if (text.includes('code=') || text.includes('localhost/callback')) {
            await handleUserCodeSubmission(from, text);
          } else {
            const userAuthToken = userTokens.get(from) || null;
            const reply = await processWithOpenAIAndSwiggy(from, text, userAuthToken);
            await sendWhatsAppMessage(from, reply);
          }
        }
      }
    }
  } catch (error) {
    console.error('❌ Webhook processing error:', error);
  }
});

// Exchange Authorization Code pasted by the user
async function handleUserCodeSubmission(from, input) {
  try {
    let authCode = input.trim();
    if (input.includes('code=')) {
      const urlString = input.startsWith('http') ? input : `http://${input}`;
      const urlObj = new URL(urlString);
      authCode = urlObj.searchParams.get('code');
    }

    const codeVerifier = pkceStore.get(from);
    if (!codeVerifier) {
      await sendWhatsAppMessage(from, "⚠️ Session expired. Please request your food search again to generate a new login link.");
      return;
    }

    const tokenRes = await fetch('https://mcp.swiggy.com/auth/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'authorization_code',
        client_id: 'whatsapp_bot',
        code: authCode,
        redirect_uri: SWIGGY_REDIRECT_URI,
        code_verifier: codeVerifier
      })
    });

    const tokenData = await tokenRes.json();

    if (tokenData.access_token) {
      userTokens.set(from, tokenData.access_token);
      pkceStore.delete(from);

      console.log(`🔑 Token successfully acquired for ${from}`);
      await sendWhatsAppMessage(from, "🎉 Authenticated successfully with Swiggy! Re-send your food item order or search to view options.");
    } else {
      throw new Error(tokenData.error_description || 'Token exchange failed.');
    }
  } catch (err) {
    console.error('❌ Token Exchange Error:', err.message);
    await sendWhatsAppMessage(from, `❌ Authentication failed: ${err.message}. Please copy the entire browser URL and paste it again.`);
  }
}

async function processWithOpenAIAndSwiggy(from, userMessage, userAuthToken = null) {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) {
    return "OpenAI API Key is missing in Render environment variables.";
  }

  try {
    const openaiRes = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${apiKey}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        model: 'gpt-4o',
        messages: [
          { 
            role: 'system', 
            content: 'You are an active Swiggy ordering assistant on WhatsApp. NEVER instruct users to open the Swiggy website or mobile app. ALWAYS invoke available Swiggy tools (like search_restaurants) to fetch live items and menus directly.' 
          },
          { role: 'user', content: userMessage }
        ],
        tools: SWIGGY_FOOD_TOOLS,
        tool_choice: 'auto'
      })
    });

    const aiData = await openaiRes.json();
    if (aiData.error) throw new Error(aiData.error.message);

    const responseMessage = aiData.choices[0].message;

    // Check if AI requested a tool execution
    if (responseMessage.tool_calls && responseMessage.tool_calls.length > 0) {
      const toolCall = responseMessage.tool_calls[0];
      console.log(`🛠️ OpenAI requested Swiggy Tool: ${toolCall.function.name}`);

      if (!userAuthToken) {
        const { verifier, challenge } = generatePKCE();
        pkceStore.set(from, verifier);

        const encodedRedirect = encodeURIComponent(SWIGGY_REDIRECT_URI);
        const authUrl = `https://mcp.swiggy.com/auth/authorize?response_type=code&client_id=whatsapp_bot&redirect_uri=${encodedRedirect}&state=${from}&code_challenge=${challenge}&code_challenge_method=S256`;

        return `🔒 Connect your Swiggy account to search menu items:\n\n1. Open link: ${authUrl}\n2. Sign in to Swiggy.\n3. Copy the full address/URL from your browser bar (it starts with http://localhost/callback...) and paste it directly into this chat!`;
      }

      // Call Swiggy MCP Tool Endpoint
      const mcpRes = await fetch('https://mcp.swiggy.com/food', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${userAuthToken}`
        },
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: Date.now(),
          method: 'tools/call',
          params: {
            name: toolCall.function.name,
            arguments: JSON.parse(toolCall.function.arguments)
          }
        })
      });

      const toolResult = await mcpRes.json();

      // Send tool results back to OpenAI for final response formatting
      const secondAiRes = await fetch('https://api.openai.com/v1/chat/completions', {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${apiKey}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          model: 'gpt-4o',
          messages: [
            { role: 'user', content: userMessage },
            responseMessage,
            { role: 'tool', tool_call_id: toolCall.id, content: JSON.stringify(toolResult) }
          ]
        })
      });

      const secondAiData = await secondAiRes.json();
      return secondAiData.choices[0].message.content;
    }

    return responseMessage.content;
  } catch (err) {
    console.error('⚠️ Processing error:', err.message);
    return `Got your message: "${userMessage}". (Note: ${err.message})`;
  }
}

async function sendWhatsAppMessage(to, messageText) {
  const phoneId = process.env.PHONE_NUMBER_ID;
  const token = process.env.WHATSAPP_TOKEN;

  if (!phoneId || !token) {
    console.error('❌ PHONE_NUMBER_ID or WHATSAPP_TOKEN missing.');
    return;
  }

  try {
    const res = await fetch(`https://graph.facebook.com/v20.0/${phoneId}/messages`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        messaging_product: 'whatsapp',
        recipient_type: 'individual',
        to: to,
        type: 'text',
        text: { body: messageText }
      }),
    });
    const data = await res.json();
    console.log('📤 WhatsApp Outbound Status:', data);
  } catch (err) {
    console.error('❌ Failed to send WhatsApp message:', err);
  }
}

const PORT = process.env.PORT || 10000;
app.listen(PORT, () => console.log(`🚀 Webhook server active on port ${PORT}`));
