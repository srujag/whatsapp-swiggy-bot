import express from 'express';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { SSEClientTransport } from '@modelcontextprotocol/sdk/client/sse.js';
import OpenAI from 'openai';

const app = express();
app.use(express.json());

// Initialize OpenAI instance safely
const openai = process.env.OPENAI_API_KEY ? new OpenAI({ apiKey: process.env.OPENAI_API_KEY }) : null;

// 1. GET /webhook -> Meta Handshake Verification
app.get('/webhook', (req, res) => {
  const mode = req.query['hub.mode'];
  const token = req.query['hub.verify_token'];
  const challenge = req.query['hub.challenge'];

  if (mode === 'subscribe' && token === process.env.WEBHOOK_VERIFY_TOKEN) {
    console.log('✅ Webhook verified successfully!');
    return res.status(200).send(challenge);
  }
  return res.sendStatus(403);
});

// 2. POST /webhook -> Receives incoming WhatsApp messages
app.post('/webhook', async (req, res) => {
  // MUST send 200 OK immediately back to Meta to prevent duplicate delivery or retries
  res.sendStatus(200);

  try {
    const body = req.body;
    if (body.object === 'whatsapp_business_account') {
      const value = body.entry?.[0]?.changes?.[0]?.value;
      if (value?.messages?.[0]) {
        const from = value.messages[0].from;
        const text = value.messages[0].text?.body;

        // CRITICAL LOG: This will now ALWAYS show up first!
        console.log(`📩 Incoming message from ${from}: "${text}"`);

        // Process message through Swiggy / OpenAI
        if (text) {
          const reply = await handleUserQuery(text);
          await sendWhatsAppMessage(from, reply);
        }
      }
    }
  } catch (error) {
    console.error('❌ Error processing webhook payload:', error);
  }
});

// Helper: Interacts with OpenAI and Swiggy MCP Server
async function handleUserQuery(userMessage) {
  if (!openai) {
    return "OpenAI API Key is missing in environment variables.";
  }

  let mcpClient = null;
  try {
    // Attempt connection to Swiggy MCP
    const transport = new SSEClientTransport(new URL('https://mcp.swiggy.com/food'));
    mcpClient = new Client({ name: 'whatsapp-swiggy-bot', version: '1.0.0' });
    await mcpClient.connect(transport);

    const { tools } = await mcpClient.listTools();
    const formattedTools = tools.map(t => ({
      type: 'function',
      function: {
        name: t.name,
        description: t.description,
        parameters: t.inputSchema
      }
    }));

    const completion = await openai.chat.completions.create({
      model: 'gpt-4o',
      messages: [
        { role: 'system', content: 'You are a helpful Swiggy assistant on WhatsApp.' },
        { role: 'user', content: userMessage }
      ],
      tools: formattedTools.length > 0 ? formattedTools : undefined
    });

    const responseMessage = completion.choices[0].message;

    // Handle tool execution if LLM decides to call a Swiggy MCP tool
    if (responseMessage.tool_calls && responseMessage.tool_calls.length > 0) {
      const toolCall = responseMessage.tool_calls[0];
      console.log(`🛠️ Executing Swiggy Tool: ${toolCall.function.name}`);

      const toolResult = await mcpClient.callTool({
        name: toolCall.function.name,
        arguments: JSON.parse(toolCall.function.arguments)
      });

      const secondCompletion = await openai.chat.completions.create({
        model: 'gpt-4o',
        messages: [
          { role: 'user', content: userMessage },
          responseMessage,
          { role: 'tool', tool_call_id: toolCall.id, content: JSON.stringify(toolResult) }
        ]
      });

      return secondCompletion.choices[0].message.content;
    }

    return responseMessage.content;
  } catch (err) {
    console.error('⚠️ Swiggy MCP / OpenAI execution error:', err.message);
    return `Got your request: "${userMessage}". (Note: Swiggy MCP server connection failed: ${err.message})`;
  }
}

// Helper: Reply back to WhatsApp
async function sendWhatsAppMessage(to, messageText) {
  const url = `https://graph.facebook.com/v20.0/${process.env.PHONE_NUMBER_ID}/messages`;
  try {
    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${process.env.WHATSAPP_TOKEN}`,
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
    const data = await response.json();
    console.log('📤 WhatsApp Send Status:', data);
  } catch (err) {
    console.error('❌ Failed to send WhatsApp message:', err);
  }
}

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`🚀 Webhook server active on port ${PORT}`));
