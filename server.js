import express from 'express';
import crypto from 'crypto';

const app = express();
app.use(express.json());

process.on('uncaughtException', (err) => console.error('Uncaught Exception:', err));
process.on('unhandledRejection', (reason) => console.error('Unhandled Rejection:', reason));

const userTokens = new Map();
const pkceStore = new Map();

const SWIGGY_REDIRECT_URI = 'http://localhost/callback';

function generatePKCE() {
  const verifier = crypto.randomBytes(32).toString('hex');
  const challenge = crypto
    .createHash('sha256')
    .update(verifier)
    .digest('base64url');
  
  return { verifier, challenge };
}

const SWIGGY_FOOD_TOOLS = [
  {
    type: 'function',
    function: {
      name: 'get_addresses',
      description: 'Fetch saved delivery addresses for the logged-in Swiggy user.',
      parameters: { type: 'object', properties: {} }
    }
  },
  {
    type: 'function',
    function: {
      name: 'search_restaurants',
      description: 'Search Swiggy for restaurants and food items based on dish query and address/location.',
      parameters: {
        type: 'object',
        properties: {
          query: { type: 'string', description: 'Dish name or cuisine, e.g. Chicken Biryani' },
          location: { type: 'string', description: 'Delivery location or neighborhood, e.g. Kondapur, 500084' }
        },
        required: ['query', 'location']
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
          restaurant_id: { type: 'string', description: 'Swiggy Restaurant ID' }
        },
        required: ['restaurant_id']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'update_food_cart',
      description: 'Add or update items in the Swiggy food cart.',
      parameters: {
        type: 'object',
        properties: {
          restaurant_id: { type: 'string', description: 'Swiggy Restaurant ID' },
          item_id: { type: 'string', description: 'Item ID to add' },
          quantity: { type: 'number', description: 'Quantity to add (default 1)' }
        },
        required: ['restaurant_id', 'item_id']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'get_food_cart',
      description: 'Fetch current cart contents and total price summary.',
      parameters: { type: 'object', properties: {} }
    }
  },
  {
    type: 'function',
    function: {
      name: 'place_food_order',
      description: 'Place final food order on Swiggy using Cash on Delivery (COD).',
      parameters: {
        type: 'object',
        properties: {
          address: { type: 'string', description: 'Delivery address text or ID' },
          payment_method: { type: 'string', description: 'Payment method, set to COD' }
        },
        required: ['payment_method']
      }
    }
  }
];

const SYSTEM_PROMPT = `You are an active Swiggy ordering assistant on WhatsApp.

CRITICAL WORKFLOW RULES:
1. When a user asks to order food:
   - Call \`get_addresses\` to fetch their saved addresses.
   - IF \`get_addresses\` returns an error or no saved address, DO NOT repeatedly ask them to check their account. Use the location text provided in the user's chat (e.g., "Kondapur") and directly call \`search_restaurants\`.
2. Present 3-5 clear dish options including restaurant name, item name, price, and rating.
3. When the user picks an option:
   - Add it to cart using \`update_food_cart\`.
   - Call \`get_food_cart\` and present the final total bill with Cash on Delivery (COD).
   - Ask for confirmation before calling \`place_food_order\`.`;

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
      await sendWhatsAppMessage(from, "⚠️ Session expired. Please ask for your dish again to generate a new login link.");
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
      await sendWhatsAppMessage(from, "🎉 Authenticated successfully with Swiggy! Re-send your food item order to view options.");
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
          { role: 'system', content: SYSTEM_PROMPT },
          { role: 'user', content: userMessage }
        ],
        tools: SWIGGY_FOOD_TOOLS,
        tool_choice: 'auto'
      })
    });

    const aiData = await openaiRes.json();
    if (aiData.error) throw new Error(aiData.error.message);

    let responseMessage = aiData.choices[0].message;

    while (responseMessage.tool_calls && responseMessage.tool_calls.length > 0) {
      const toolCall = responseMessage.tool_calls[0];
      console.log(`🛠️ OpenAI requested Swiggy Tool: ${toolCall.function.name}`);

      if (!userAuthToken) {
        const { verifier, challenge } = generatePKCE();
        pkceStore.set(from, verifier);

        const encodedRedirect = encodeURIComponent(SWIGGY_REDIRECT_URI);
        const authUrl = `https://mcp.swiggy.com/auth/authorize?response_type=code&client_id=whatsapp_bot&redirect_uri=${encodedRedirect}&state=${from}&code_challenge=${challenge}&code_challenge_method=S256`;

        return `🔒 Connect your Swiggy account to fetch addresses & place orders:\n\n1. Open link: ${authUrl}\n2. Sign in to Swiggy.\n3. Copy the browser URL (starts with http://localhost/callback...) and paste it directly into this chat!`;
      }

      let toolResult;
      try {
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
              arguments: JSON.parse(toolCall.function.arguments || '{}')
            }
          })
        });

        toolResult = await mcpRes.json();
      } catch (mcpErr) {
        console.error(`❌ MCP Tool Error [${toolCall.function.name}]:`, mcpErr.message);
        toolResult = { error: `Failed to fetch data from Swiggy: ${mcpErr.message}` };
      }

      const followUpRes = await fetch('https://api.openai.com/v1/chat/completions', {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${apiKey}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          model: 'gpt-4o',
          messages: [
            { role: 'system', content: SYSTEM_PROMPT },
            { role: 'user', content: userMessage },
            responseMessage,
            { role: 'tool', tool_call_id: toolCall.id, content: JSON.stringify(toolResult) }
          ],
          tools: SWIGGY_FOOD_TOOLS
        })
      });

      const followUpData = await followUpRes.json();
      responseMessage = followUpData.choices[0].message;
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
