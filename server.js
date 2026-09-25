import express from 'express';

const app = express();
app.use(express.json());

// Prevent unhandled errors from bringing down the node process
process.on('uncaughtException', (err) => console.error('Uncaught Exception:', err));
process.on('unhandledRejection', (reason) => console.error('Unhandled Rejection:', reason));

// In-memory store for user authentication tokens (Swap with Redis/DB for production)
const userTokens = new Map();

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

// 2. POST /webhook -> Process Incoming WhatsApp Messages
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
          const reply = await processWithOpenAIAndSwiggy(text, userAuthToken);
          await sendWhatsAppMessage(from, reply);
        }
      }
    }
  } catch (error) {
    console.error('❌ Webhook processing error:', error);
  }
});

// Helper: Handles OpenAI Prompt Execution & Swiggy Tool Calls
async function processWithOpenAIAndSwiggy(userMessage, userAuthToken = null) {
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

      // Check if user is authenticated with Swiggy
      if (!userAuthToken) {
        const authUrl = `https://mcp.swiggy.com/auth/authorize?response_type=code&client_id=whatsapp_bot&scope=mcp:tools`;
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
