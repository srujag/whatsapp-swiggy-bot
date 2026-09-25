import express from 'express';

const app = express();
app.use(express.json());

// Prevent unhandled errors from bringing down the node process
process.on('uncaughtException', (err) => console.error('Uncaught Exception:', err));
process.on('unhandledRejection', (reason) => console.error('Unhandled Rejection:', reason));

// In-memory store for user authentication tokens
const userTokens = new Map();

// Base URL for your Render app (adjust if your service name is different)
const RENDER_BASE_URL = process.env.RENDER_EXTERNAL_URL || 'https://whatsapp-swiggy-bot.onrender.com';

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

// 1. GET /webhook -> Meta Webhook Verification Handshake
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

// 2. GET /auth/callback -> Swiggy OAuth Redirect Handling
app.get('/auth/callback', async (req, res) => {
  const { code, state: phone } = req.query;

  if (!code || !phone) {
    return res.status(400).send('❌ Invalid response: Missing authorization code or user phone state.');
  }

  try {
    // Store token/code associated with user's WhatsApp number
    userTokens.set(phone, code);
    console.log(`🔑 Saved auth token for ${phone}`);

    // Notify user on WhatsApp that authentication succeeded
    await sendWhatsAppMessage(phone, "🎉 Authenticated successfully with Swiggy! What would you like to order today?");

    res.send(`
      <div style="text-align: center; font-family: sans-serif; padding-top: 50px;">
        <h2>✅ Authentication Successful!</h2>
        <p>Your account is connected. You can close this window and return to WhatsApp.</p>
      </div>
    `);
  } catch (err) {
    console.error('❌ OAuth callback error:', err);
    res.status(500).send('Authentication processing failed.');
  }
});

// 3. POST /webhook -> Process Incoming WhatsApp Messages
app.post('/webhook', async (req, res) => {
  // Acknowledge Meta immediately to prevent retry drops or timeouts
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

// Helper: Handles OpenAI Prompt Execution & Swiggy Tool Calls
async function processWithOpenAIAndSwiggy(from, userMessage, userAuthToken = null) {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) {
    return "OpenAI API Key is missing in Render environment variables.";
  }

  try {
    // 1. Send query and Swiggy tools schema to OpenAI
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

    // 2. If OpenAI decides to call a Swiggy Tool
    if (responseMessage.tool_calls && responseMessage.tool_calls.length > 0) {
      const toolCall = responseMessage.tool_calls[0];
      console.log(`🛠️ OpenAI requested Swiggy Tool: ${toolCall.function.name}`);

      // Generate fully encoded OAuth URL with required redirect_uri & state
      const redirectUri = encodeURIComponent(`${RENDER_BASE_URL}/auth/callback`);
      const authUrl = `https://mcp.swiggy.com/auth/authorize?response_type=code&client_id=whatsapp_bot&redirect_uri=${redirectUri}&state=${from}`;

      // Prompt user for authentication if no token exists
      // Note: Swap comment to test MCP with mock token during local sandbox development:
      // const activeToken = userAuthToken || "MOCK_DEVELOPMENT_TOKEN";
      if (!userAuthToken) {
        return `🔒 To search dishes, view menus, or place orders on Swiggy, please connect your account:\n\n👉 ${authUrl}`;
      }

      // Execute tool call to Swiggy MCP Endpoint
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

      // Pass tool result back to OpenAI for natural language response formatting
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

// Helper: Outbound WhatsApp Message Sender via Meta Graph API
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
