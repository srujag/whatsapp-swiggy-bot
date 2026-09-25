import express from 'express';
import crypto from 'crypto';

const app = express();
app.use(express.json());

process.on('uncaughtException', (err) => console.error('Uncaught Exception:', err));
process.on('unhandledRejection', (reason) => console.error('Unhandled Rejection:', reason));

const userTokens = new Map();
const pkceStore = new Map();
// 💡 IN-MEMORY CONVERSATION HISTORY TO PREVENT LOOPS
const conversationHistory = new Map(); 

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

const SWIGGY_FOOD_TOOLS = [
  {
    type: 'function',
    function: {
      name: 'get_addresses',
      description: 'Get saved delivery addresses for the logged-in Swiggy user.',
      parameters: { type: 'object', properties: {} }
    }
  },
  {
    type: 'function',
    function: {
      name: 'create_address',
      description: 'Create a new delivery address on Swiggy.',
      parameters: {
        type: 'object',
        properties: {
          address: { type: 'string', description: 'Address text, neighborhood, or area name (e.g. Kondapur, Hyderabad)' }
        },
        required: ['address']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'search_restaurants',
      description: 'Search Swiggy for restaurants and dishes using an addressId.',
      parameters: {
        type: 'object',
        properties: {
          addressId: { type: 'string', description: 'Valid addressId from get_addresses or create_address' },
          query: { type: 'string', description: 'Dish name or cuisine (e.g. chicken biryani)' }
        },
        required: ['addressId', 'query']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'get_restaurant_menu',
      description: 'Fetch menu for a specific restaurant ID.',
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
      description: 'Add or update items in the Swiggy cart.',
      parameters: {
        type: 'object',
        properties: {
          restaurantId: { type: 'string', description: 'Swiggy Restaurant ID' },
          menu_item_id: { type: 'string', description: 'Item ID to add' },
          quantity: { type: 'number', description: 'Quantity' }
        },
        required: ['restaurantId', 'menu_item_id']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'get_food_cart',
      description: 'Fetch current cart items and bill summary.',
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
          payment_method: { type: 'string', description: 'Must be COD' }
        },
        required: ['addressId', 'payment_method']
      }
    }
  }
];

const SYSTEM_PROMPT = `You are a Swiggy food ordering assistant on WhatsApp.

RULES TO ELIMINATE LOCATION LOOPS:
1. Whenever the user specifies a dish (e.g., "chicken biryani") and a location (e.g., "Kondapur"):
   - Call \`get_addresses\`.
   - If \`get_addresses\` returns valid addresses, use the first addressId.
   - If \`get_addresses\` returns NO address, immediately call \`create_address(address="Kondapur, Hyderabad")\` to get an addressId.
   - IMMEDIATELY call \`search_restaurants(addressId=..., query="chicken biryani")\` with the addressId.
2. NEVER ask the user for their location if they have already provided a neighborhood or area in previous messages!
3. Format output clearly with top 3-5 dish options (restaurant, item, price in INR, rating).`;

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
      await sendWhatsAppMessage(from, "⚠️ Session expired. Please request your order again to generate a new login link.");
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
      await sendWhatsAppMessage(from, "🎉 Authenticated with Swiggy! Please ask for your food again (e.g., 'Chicken Biryani in Kondapur').");
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
  if (!apiKey) return "OpenAI API Key missing.";

  // Fetch or initialize conversation thread for this user
  if (!conversationHistory.has(from)) {
    conversationHistory.set(from, [{ role: 'system', content: SYSTEM_PROMPT }]);
  }

  const history = conversationHistory.get(from);
  history.push({ role: 'user', content: userMessage });

  // Limit thread context to last 15 messages to prevent context overflow
  if (history.length > 15) {
    history.splice(1, history.length - 15);
  }

  try {
    let continueLoop = true;
    let finalReply = "";

    while (continueLoop) {
      const openaiRes = await fetch('https://api.openai.com/v1/chat/completions', {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${apiKey}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          model: 'gpt-4o',
          messages: history,
          tools: SWIGGY_FOOD_TOOLS,
          tool_choice: 'auto'
        })
      });

      const aiData = await openaiRes.json();

      if (!aiData.choices || aiData.choices.length === 0) {
        console.error('❌ Invalid response from OpenAI:', JSON.stringify(aiData));
        return "I encountered an error processing your request. Please try again.";
      }

      const responseMessage = aiData.choices[0].message;
      history.push(responseMessage); // Add model output to history

      if (responseMessage.tool_calls && responseMessage.tool_calls.length > 0) {
        for (const toolCall of responseMessage.tool_calls) {
          const toolName = toolCall.function.name;
          const toolArgs = JSON.parse(toolCall.function.arguments || '{}');

          console.log(`🛠️ Calling Swiggy Tool: ${toolName}`, toolArgs);

          if (!userAuthToken) {
            const { verifier, challenge } = generatePKCE();
            pkceStore.set(from, verifier);

            const encodedRedirect = encodeURIComponent(SWIGGY_REDIRECT_URI);
            const authUrl = `https://mcp.swiggy.com/auth/authorize?response_type=code&client_id=whatsapp_bot&redirect_uri=${encodedRedirect}&state=${from}&code_challenge=${challenge}&code_challenge_method=S256`;

            return `🔒 Swiggy Login Required:\n\n1. Open link: ${authUrl}\n2. Login to Swiggy.\n3. Copy the browser URL (http://localhost/callback...) and paste it here!`;
          }

          const toolResult = await callSwiggyMCP(toolName, toolArgs, userAuthToken);

          // Append tool result to context history
          history.push({
            role: 'tool',
            tool_call_id: toolCall.id,
            content: JSON.stringify(toolResult)
          });
        }
      } else {
        // No more tool calls required; retrieve text response
        finalReply = responseMessage.content;
        continueLoop = false;
      }
    }

    return finalReply;
  } catch (err) {
    console.error('⚠️ Processing error:', err.message);
    return `Error processing request: ${err.message}`;
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
