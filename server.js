import express from 'express';
import crypto from 'crypto';

const app = express();
app.use(express.json());

process.on('uncaughtException', (err) => console.error('Uncaught Exception:', err));
process.on('unhandledRejection', (reason) => console.error('Unhandled Rejection:', reason));

// Stores for Tokens and PKCE Verifiers
const userTokens = new Map();
const pkceStore = new Map();

const RENDER_BASE_URL = process.env.RENDER_EXTERNAL_URL || 'https://whatsapp-swiggy-bot.onrender.com';

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
      description: 'Search for restaurants, biryani, pizza, or food items available on Swiggy.',
      parameters: {
        type: 'object',
        properties: {
          query: { type: 'string', description: 'Dish name or cuisine type, e.g. Biryani' }
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

// 2. GET /auth/callback -> Swiggy OAuth Redirect & PKCE Token Exchange
app.get('/auth/callback', async (req, res) => {
  const { code, state: phone } = req.query;

  if (!code || !phone) {
    return res.status(400).send('❌ Invalid response: Missing authorization code or user phone state.');
  }

  try {
    const codeVerifier = pkceStore.get(phone);

    const tokenRes = await fetch('https://mcp.swiggy.com/auth/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'authorization_code',
        client_id: 'whatsapp_bot',
        code: code,
        redirect_uri: `${RENDER_BASE_URL}/auth/callback`,
        code_verifier: codeVerifier
      })
    });

    const tokenData = await tokenRes.json();

    if (tokenData.access_token) {
      userTokens.set(phone, tokenData.access_token);
      pkceStore.delete(phone);

      console.log(`🔑 Token stored for ${phone}`);
      await sendWhatsAppMessage(phone, "🎉 Authenticated successfully with Swiggy! What would you like to order today?");

      res.send(`
        <div style="text-align: center; font-family: sans-serif; padding-top: 50px;">
          <h2>✅ Authentication Successful!</h2>
          <p>Your account is connected. You can close this window and return to WhatsApp.</p>
        </div>
      `);
    } else {
      throw new Error(tokenData.error_description || 'Token exchange failed.');
    }
  } catch (err) {
    console.error('❌ OAuth callback error:', err);
    res.status(500).send(`Authentication failed: ${err.message}`);
  }
});

// 3. POST /webhook -> Process Incoming Messages
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
          const userAuthToken = userTokens.get(from) || null;
          const reply = await processWithOpenAIAndSwiggy(from, text, userAuthToken);
          await sendWhatsAppMessage(from, reply);
        }
      }
    }
  } catch (error) {
    console.error('❌ Webhook processing error:', error);
  }
});

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
            content: 'You are an official Swiggy assistant on WhatsApp. Use Swiggy tools whenever users ask for food, menus, prices, or orders.' 
          },
          { role: 'user', content: userMessage }
        ],
        tools: SWIGGY_FOOD_TOOLS
      })
    });

    const aiData = await openaiRes.json();
    if (aiData.error) throw new Error(aiData.error.message);

    const responseMessage = aiData.choices[0].message;

    if (responseMessage.tool_calls && responseMessage.tool_calls.length > 0) {
      const toolCall = responseMessage.tool_calls[0];
      console.log(`🛠️ OpenAI requested Swiggy Tool: ${toolCall.function.name}`);

      if (!userAuthToken) {
        const { verifier, challenge } = generatePKCE();
        pkceStore.set(from, verifier);

        const redirectUri = encodeURIComponent(`${RENDER_BASE_URL}/auth/callback`);
        const authUrl = `https://mcp.swiggy.com/auth/authorize?response_type=code&client_id=whatsapp_bot&redirect_uri=${redirectUri}&state=${from}&code_challenge=${challenge}&code_challenge_method=S256`;

        return `🔒 To search dishes, view menus, or place orders on Swiggy, please connect your account:\n\n👉 ${authUrl}`;
      }

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
