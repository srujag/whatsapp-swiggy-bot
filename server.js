import express from 'express';
import crypto from 'crypto';

const app = express();
app.use(express.json());

process.on('uncaughtException', (err) => console.error('Uncaught Exception:', err));
process.on('unhandledRejection', (reason) => console.error('Unhandled Rejection:', reason));

const userTokens = new Map();
const pkceStore = new Map();
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

/**
 * Corrected Swiggy MCP Tool Definitions (OpenAI Compliant JSON Schema)
 */
const SWIGGY_FOOD_TOOLS = [
  {
    type: 'function',
    function: {
      name: 'get_addresses',
      description: 'Fetch saved delivery addresses for the logged-in Swiggy user.',
      parameters: {
        type: 'object',
        properties: {
          dummy: { type: 'string', description: 'Optional unused parameter' }
        }
      }
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
      description: 'Search Swiggy for restaurants using an addressId.',
      parameters: {
        type: 'object',
        properties: {
          addressId: { type: 'string', description: 'Address ID obtained from get_addresses or create_address' },
          query: { type: 'string', description: 'Restaurant name or cuisine search query' }
        },
        required: ['addressId', 'query']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'search_menu',
      description: 'Search Swiggy for specific food items and dishes across restaurant menus.',
      parameters: {
        type: 'object',
        properties: {
          addressId: { type: 'string', description: 'Address ID obtained from get_addresses or create_address' },
          query: { type: 'string', description: 'Dish name, e.g., chicken biryani' }
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
      parameters: {
        type: 'object',
        properties: {
          dummy: { type: 'string', description: 'Optional unused parameter' }
        }
      }
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
          payment_method: { type: 'string', description: 'Must be set to COD' }
        },
        required: ['addressId', 'payment_method']
      }
    }
  }
];

const SYSTEM_PROMPT = `You are an active Swiggy ordering assistant on WhatsApp.

CRITICAL WORKFLOW RULES:
1. When a user asks for a dish or restaurant (e.g. "Butterscotch in Kondapur"):
   - Step A: Call \`get_addresses\`.
   - Step B: If \`get_addresses\` returns an address, pick the first \`addressId\`.
   - Step C: If \`get_addresses\` returns NO address or fails, and the user provided an area (e.g., "Kondapur"), IMMEDIATELY call \`create_address(address="Kondapur, Hyderabad")\` to acquire an \`addressId\`.
   - Step D: Once you have an \`addressId\`, call \`search_menu(addressId=..., query="Butterscotch")\` or \`search_restaurants\`.
   - DO NOT repeatedly ask the user for their location if they already provided an area in previous messages!

2. Present 3-5 dish options with restaurant name, item name, price (in INR), and rating.
3. Upon user confirmation:
   - Call \`update_food_cart\` and \`get_food_cart\`.
   - Request final user confirmation to place order via Cash on Delivery (COD).`;

/**
 * Execute calls to Swiggy MCP Server
 */
async function callSwiggyMCP(toolName, args, token) {
  const headers = {
    'Content-Type': 'application/json',
    'Authorization': `Bearer ${token}`
  };

  try {
    const mcpRes = await fetch(SWIGGY_MCP_ENDPOINT, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: Date.now(),
        method: 'tools/call',
        params: {
          name: toolName,
          arguments: args || {}
        }
      })
    });

    const mcpData = await mcpRes.json().catch(() => null);

    if (!mcpRes.ok || !mcpData || mcpData.error) {
      console.error(`❌ Swiggy MCP Tool [${toolName}] Error:`, mcpData);
      return { 
        status: "error", 
        message: mcpData?.error?.message || `HTTP ${mcpRes.status} response from Swiggy` 
      };
    }

    return mcpData.result || mcpData;
  } catch (err) {
    console.error(`❌ Exception in callSwiggyMCP [${toolName}]:`, err.message);
    return { status: "error", message: `Failed to communicate with Swiggy: ${err.message}` };
  }
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
          if (text.toLowerCase().trim() === 'logout') {
            userTokens.delete(from);
            conversationHistory.delete(from);
            await sendWhatsAppMessage(from, "Logged out successfully and session cleared!");
            return;
          }

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

      // Force-reset conversation history so the new chat starts with clean message roles
      conversationHistory.set(from, [{ role: 'system', content: SYSTEM_PROMPT }]);

      console.log(`🔑 Token acquired for ${from}`);
      await sendWhatsAppMessage(from, "🎉 Authenticated with Swiggy! Please ask for your dish again (e.g., 'Butterscotch in Kondapur').");
    } else {
      throw new Error(tokenData.error_description || 'Token exchange failed.');
    }
  } catch (err) {
    console.error('❌ OAuth Exchange Error:', err.message);
    await sendWhatsAppMessage(from, `❌ Authentication error: ${err.message}. Please copy and paste the browser URL again.`);
  }
}

async function processWithOpenAIAndSwiggy(from, userMessage, userAuthToken = null) {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) return "OpenAI API Key missing.";

  // Pre-Authentication Guard
  if (!userAuthToken) {
    const { verifier, challenge } = generatePKCE();
    pkceStore.set(from, verifier);

    const encodedRedirect = encodeURIComponent(SWIGGY_REDIRECT_URI);
    const authUrl = `https://mcp.swiggy.com/auth/authorize?response_type=code&client_id=whatsapp_bot&redirect_uri=${encodedRedirect}&state=${from}&code_challenge=${challenge}&code_challenge_method=S256`;

    return `🔒 Swiggy Login Required:\n\n1. Open link: ${authUrl}\n2. Login to Swiggy.\n3. Copy the browser URL (http://localhost/callback...) and paste it here!`;
  }

  if (!conversationHistory.has(from)) {
    conversationHistory.set(from, [{ role: 'system', content: SYSTEM_PROMPT }]);
  }

  const history = conversationHistory.get(from);
  history.push({ role: 'user', content: userMessage });

  if (history.length > 12) {
    history.splice(1, history.length - 12);
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
        console.error('❌ OpenAI Error Payload:', JSON.stringify(aiData));
        // Reset corrupt state on error
        conversationHistory.set(from, [{ role: 'system', content: SYSTEM_PROMPT }]);
        return `OpenAI Error: ${aiData.error?.message || "Invalid response format"}`;
      }

      const responseMessage = aiData.choices[0].message;

      if (responseMessage.tool_calls && responseMessage.tool_calls.length > 0) {
        history.push(responseMessage);

        for (const toolCall of responseMessage.tool_calls) {
          const toolName = toolCall.function.name;
          const toolArgs = JSON.parse(toolCall.function.arguments || '{}');

          console.log(`🛠️ Calling Swiggy MCP Tool: ${toolName}`, toolArgs);

          const toolResult = await callSwiggyMCP(toolName, toolArgs, userAuthToken);

          history.push({
            role: 'tool',
            tool_call_id: toolCall.id,
            content: JSON.stringify(toolResult)
          });
        }
      } else {
        history.push(responseMessage);
        finalReply = responseMessage.content;
        continueLoop = false;
      }
    }

    return finalReply;
  } catch (err) {
    console.error('⚠️ Processing loop error:', err.message);
    conversationHistory.set(from, [{ role: 'system', content: SYSTEM_PROMPT }]);
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
