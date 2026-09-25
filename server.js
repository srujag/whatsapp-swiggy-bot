import express from 'express';
import crypto from 'crypto';

const app = express();
app.use(express.json());

process.on('uncaughtException', (err) => console.error('Uncaught Exception:', err));
process.on('unhandledRejection', (reason) => console.error('Unhandled Rejection:', reason));

const userTokens = new Map();
const pkceStore = new Map();

const SWIGGY_MCP_ENDPOINT = 'https://mcp.swiggy.com/food';
const SWIGGY_REDIRECT_URI = 'http://localhost/callback';

function generatePKCE() {
  const verifier = crypto.randomBytes(32).toString('hex');
  const challenge = crypto
    .createHash('sha256')
    .update(verifier)
    .digest('base64url');
  
  return { verifier, challenge };
}

/**
 * OpenAI Tool Definitions matching Swiggy MCP Server Schema
 */
const SWIGGY_FOOD_TOOLS = [
  {
    type: 'function',
    function: {
      name: 'get_addresses',
      description: 'Fetch saved delivery addresses for the logged-in Swiggy account.',
      parameters: { type: 'object', properties: {} }
    }
  },
  {
    type: 'function',
    function: {
      name: 'search_restaurants',
      description: 'Search Swiggy for restaurants and dishes based on query and area location.',
      parameters: {
        type: 'object',
        properties: {
          query: { type: 'string', description: 'Dish name, e.g., Chicken Biryani, Dessert, Pizza' },
          location: { type: 'string', description: 'Neighborhood, area, or full address, e.g. Kondapur, Hyderabad' }
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
          quantity: { type: 'number', description: 'Quantity (default 1)' }
        },
        required: ['restaurant_id', 'item_id']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'get_food_cart',
      description: 'Fetch current cart items, delivery charges, and final bill amount.',
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
          address: { type: 'string', description: 'Delivery address text or address ID' },
          payment_method: { type: 'string', description: 'Payment method, set strictly to COD' }
        },
        required: ['payment_method']
      }
    }
  }
];

const SYSTEM_PROMPT = `You are an active Swiggy ordering assistant on WhatsApp.

WORKFLOW INSTRUCTIONS:
1. When a user asks to view or order food options (e.g., "I want chicken biryani"):
   - Extract the food item and delivery location from their text (e.g. "Kondapur").
   - Directly call \`search_restaurants\` using their location and query.
   - Do NOT force \`get_addresses\` if they have already supplied a neighborhood in chat.
2. Present 3-5 dish options with restaurant name, dish name, price (in INR), and rating.
3. When the user confirms an option:
   - Call \`update_food_cart\` to add the item.
   - Call \`get_food_cart\` to summarize item costs, taxes, delivery fee, and total bill.
   - Request final user confirmation to place order with Cash on Delivery (COD).
4. Upon user confirmation, call \`place_food_order\` with payment_method="COD".`;

/**
 * Execute JSON-RPC 2.0 calls to Swiggy MCP Server with Initialization
 */
async function callSwiggyMCP(toolName, args, token) {
  const headers = {
    'Content-Type': 'application/json',
    'Authorization': `Bearer ${token}`
  };

  // Step 1: Execute JSON-RPC 'initialize' handshake
  try {
    const initRes = await fetch(SWIGGY_MCP_ENDPOINT, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'initialize',
        params: {
          protocolVersion: '2024-11-05',
          capabilities: {},
          clientInfo: { name: 'whatsapp-swiggy-bot', version: '1.0.0' }
        }
      })
    });

    if (!initRes.ok) {
      console.warn(`⚠️ MCP initialize returned status ${initRes.status}`);
    }
  } catch (err) {
    console.warn(`⚠️ MCP initialize handshake failed: ${err.message}`);
  }

  // Step 2: Execute JSON-RPC 'tools/call'
  const mcpRes = await fetch(SWIGGY_MCP_ENDPOINT, {
    method: 'POST',
    headers,
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: Date.now(),
      method: 'tools/call',
      params: {
        name: toolName,
        arguments: args
      }
    })
  });

  const mcpData = await mcpRes.json();

  if (!mcpRes.ok || mcpData.error) {
    console.error(`❌ MCP Tool Call Failed [${toolName}]:`, JSON.stringify(mcpData));
    throw new Error(mcpData.error?.message || `Swiggy server returned HTTP ${mcpRes.status}`);
  }

  return mcpData.result || mcpData;
}

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

        console.log(`📩 Message from ${from}: "${text}"`);

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
    console.error('❌ Webhook error:', error);
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
      await sendWhatsAppMessage(from, "⚠️ Session expired. Please send your food order again to receive a fresh login link.");
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

      console.log(`🔑 Token acquired for ${from}`);
      await sendWhatsAppMessage(from, "🎉 Authenticated successfully with Swiggy! Please re-send your food request (e.g., 'Chicken Biryani in Kondapur').");
    } else {
      throw new Error(tokenData.error_description || 'Token exchange failed.');
    }
  } catch (err) {
    console.error('❌ OAuth Exchange Error:', err.message);
    await sendWhatsAppMessage(from, `❌ Authentication error: ${err.message}. Please copy and paste the entire browser URL again.`);
  }
}

async function processWithOpenAIAndSwiggy(from, userMessage, userAuthToken = null) {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) {
    return "OpenAI API Key missing in environment variables.";
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

    // Guard against undefined choices (prevents crash)
    if (!aiData.choices || aiData.choices.length === 0) {
      console.error('❌ OpenAI invalid response:', JSON.stringify(aiData));
      return "I encountered a temporary issue processing your request. Please try again.";
    }

    let responseMessage = aiData.choices[0].message;

    // Process tool calls iteratively
    while (responseMessage.tool_calls && responseMessage.tool_calls.length > 0) {
      const toolCall = responseMessage.tool_calls[0];
      const toolName = toolCall.function.name;
      const toolArgs = JSON.parse(toolCall.function.arguments || '{}');

      console.log(`🛠️ Executing Swiggy Tool: ${toolName}`, toolArgs);

      if (!userAuthToken) {
        const { verifier, challenge } = generatePKCE();
        pkceStore.set(from, verifier);

        const encodedRedirect = encodeURIComponent(SWIGGY_REDIRECT_URI);
        const authUrl = `https://mcp.swiggy.com/auth/authorize?response_type=code&client_id=whatsapp_bot&redirect_uri=${encodedRedirect}&state=${from}&code_challenge=${challenge}&code_challenge_method=S256`;

        return `🔒 Swiggy Login Required:\n\n1. Open link: ${authUrl}\n2. Login to Swiggy.\n3. Copy the browser URL (http://localhost/callback...) and paste it here!`;
      }

      let toolResult;
      try {
        toolResult = await callSwiggyMCP(toolName, toolArgs, userAuthToken);
      } catch (err) {
        console.error(`❌ Tool execution error [${toolName}]:`, err.message);
        toolResult = { error: `Failed to execute ${toolName}: ${err.message}` };
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
      if (!followUpData.choices || followUpData.choices.length === 0) {
        return "I received an unexpected format from the order system. Please try again.";
      }

      responseMessage = followUpData.choices[0].message;
    }

    return responseMessage.content;
  } catch (err) {
    console.error('⚠️ Processing error:', err.message);
    return `Sorry, I couldn't process that: ${err.message}`;
  }
}

async function sendWhatsAppMessage(to, messageText) {
  const phoneId = process.env.PHONE_NUMBER_ID;
  const token = process.env.WHATSAPP_TOKEN;

  if (!phoneId || !token) {
    console.error('❌ Missing PHONE_NUMBER_ID or WHATSAPP_TOKEN.');
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
    console.log('📤 WhatsApp Send Status:', data);
  } catch (err) {
    console.error('❌ WhatsApp delivery failed:', err);
  }
}

const PORT = process.env.PORT || 10000;
app.listen(PORT, () => console.log(`🚀 Webhook server running on port ${PORT}`));
