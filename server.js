import express from 'express';

const app = express();
app.use(express.json());

// Global crash handlers
process.on('uncaughtException', (err) => console.error('Uncaught Exception:', err));
process.on('unhandledRejection', (reason) => console.error('Unhandled Rejection:', reason));

// 1. GET /webhook -> Verification Handshake for Meta
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

// 2. POST /webhook -> Incoming Messages from WhatsApp
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
          const reply = await processWithOpenAIAndSwiggy(text);
          await sendWhatsAppMessage(from, reply);
        }
      }
    }
  } catch (error) {
    console.error('❌ Webhook processing error:', error);
  }
});

// Helper: Handle Swiggy MCP via JSON-RPC POST call & OpenAI
async function processWithOpenAIAndSwiggy(userMessage) {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) {
    return "OpenAI API Key is missing in Render environment variables.";
  }

  try {
    let tools = [];
    try {
      const mcpRes = await fetch('https://mcp.swiggy.com/food', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Accept': 'application/json' },
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: Date.now(),
          method: 'tools/list',
          params: {}
        })
      });

      if (mcpRes.ok) {
        const mcpData = await mcpRes.json();
        tools = (mcpData.result?.tools || []).map(t => ({
          type: 'function',
          function: {
            name: t.name,
            description: t.description,
            parameters: t.inputSchema
          }
        }));
      }
    } catch (mcpErr) {
      console.warn('⚠️ Swiggy MCP fetch failed, skipping tools:', mcpErr.message);
    }

    const openaiRes = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${apiKey}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        model: 'gpt-4o',
        messages: [
          { role: 'system', content: 'You are a helpful Swiggy food ordering assistant on WhatsApp.' },
          { role: 'user', content: userMessage }
        ],
        tools: tools.length > 0 ? tools : undefined
      })
    });

    const aiData = await openaiRes.json();
    if (aiData.error) {
      throw new Error(`OpenAI API error: ${aiData.error.message}`);
    }

    const responseMessage = aiData.choices[0].message;

    if (responseMessage.tool_calls && responseMessage.tool_calls.length > 0) {
      const toolCall = responseMessage.tool_calls[0];
      console.log(`🛠️ Executing Swiggy Tool: ${toolCall.function.name}`);

      const toolExecRes = await fetch('https://mcp.swiggy.com/food', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
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

      const toolResult = await toolExecRes.json();

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

// Helper: Send WhatsApp Reply via Meta Graph API
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
