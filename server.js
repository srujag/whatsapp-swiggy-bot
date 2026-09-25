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
 * Official Swiggy MCP Tool Definitions
 */
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
      name: 'create_address',
      description: 'Create and save a new delivery address for the user on Swiggy.',
      parameters: {
        type: 'object',
        properties: {
          address: { type: 'string', description: 'Full address or neighborhood provided by user (e.g., Kondapur, Hyderabad)' }
        },
        required: ['address']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'search_restaurants',
      description: 'Search Swiggy for restaurants and dishes using addressId.',
      parameters: {
        type: 'object',
        properties: {
          addressId: { type: 'string', description: 'REQUIRED addressId obtained from get_addresses or create_address' },
          query: { type: 'string', description: 'Dish or restaurant search query (e.g., chicken biryani)' }
        },
        required: ['addressId', 'query']
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
          restaurantId: { type: 'string', description: 'Swiggy Restaurant ID' }
        },
        required: ['restaurantId']
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
          restaurantId: { type: 'string', description: 'Swiggy Restaurant ID' },
          menu_item_id: { type: 'string', description: 'Item ID to add' },
          quantity: { type: 'number', description: 'Quantity (default 1)' }
        },
        required: ['restaurantId', 'menu_item_id']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'get_food_cart',
      description: 'Fetch current cart contents, bill breakdown, and delivery charges.',
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
          addressId: { type: 'string', description: 'Selected address ID for delivery' },
          payment_method: { type: 'string', description: 'Set strictly to COD' }
        },
        required: ['addressId', 'payment_method']
      }
    }
  }
];

const SYSTEM_PROMPT = `You are an active Swiggy ordering assistant on WhatsApp.

CRITICAL INSTRUCTIONS TO PREVENT LOCATION LOOPS:
1. When a user asks for food (e.g. "chicken biryani order" in "Kondapur"):
   - Step A: Call \`get_addresses\`.
   - Step B: If \`get_addresses\` returns an address, pick the first \`addressId\`.
   - Step C: If \`get_addresses\` returns NO address or fails, and the user provided an area (e.g., "Kondapur"), IMMEDIATELY call \`create_address(address="Kondapur, Hyderabad")\` to acquire a new \`addressId\`.
   - Step D: Once you have an \`addressId\`, directly call \`search_restaurants(addressId=..., query="chicken biryani")\`.
   - DO NOT repeatedly ask the user for their location if they already typed an area in chat!

2. Present 3-5 dish options with restaurant name, item name, price, and rating.
3. Upon user confirmation:
   - Call \`update_food_cart\` and \`get_food_cart\`.
   - Request final user confirmation to place order via Cash on Delivery (COD).`;

/**
 * Execute JSON-RPC 2.0 calls to Swiggy MCP Server with Initialization
 */
async function callSwiggyMCP(toolName, args, token) {
  const headers = {
    'Content-Type': 'application/json',
    'Authorization': `Bearer ${token}`
  };

  try {
    await fetch(SWIGGY_MCP_ENDPOINT, {
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
  } catch (err) {
    console.warn(`⚠️ MCP initialize handshake warning: ${err.message}`);
  }

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
    return { success: false, error: mcpData.error?.message || `Error status ${mcpRes.status}` };
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
      await sendWhatsAppMessage(from, "⚠️ Session expired. Please send your food order again to generate a new login link.");
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
      await sendWhatsAppMessage(from, "🎉 Authenticated successfully with Swiggy! Please ask for your dish again (e.g. 'Chicken Biryani in Kondapur').");
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

    if (!aiData.choices || aiData.choices.length === 0) {
      console.error('❌ OpenAI invalid response:', JSON.stringify(aiData));
      return "I encountered a temporary issue processing your request. Please try again.";
    }

    let responseMessage = aiData.choices[0].message;

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

      const toolResult = await callSwiggyMCP(toolName, toolArgs, userAuthToken);

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
