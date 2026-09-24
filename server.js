import express from 'express';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { SSEClientTransport } from '@modelcontextprotocol/sdk/client/sse.js';
import OpenAI from 'openai';

const app = express();
app.use(express.json());
const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

// Helper: Connect to Swiggy MCP Server
async function getSwiggyMcpClient(userAccessToken) {
  const transport = new SSEClientTransport(
    new URL('https://mcp.swiggy.com/food'),
    {
      headers: userAccessToken ? { Authorization: `Bearer ${userAccessToken}` } : {}
    }
  );

  const client = new Client(
    { name: 'whatsapp-swiggy-agent', version: '1.0.0' },
    { capabilities: {} }
  );

  await client.connect(transport);
  return client;
}

// Helper: Handle WhatsApp message with LLM + Swiggy MCP
async function processMessageWithSwiggy(userMessage, userAccessToken) {
  const mcpClient = await getSwiggyMcpClient(userAccessToken);
  
  // Fetch available tools (e.g., search_restaurants, get_restaurant_menu, add_to_cart)
  const { tools } = await mcpClient.listTools();

  // Convert MCP tool schemas to OpenAI tool definitions
  const formattedTools = tools.map(t => ({
    type: 'function',
    function: {
      name: t.name,
      description: t.description,
      parameters: t.inputSchema
    }
  }));

  // Call OpenAI with Swiggy tools attached
  const completion = await openai.chat.completions.create({
    model: 'gpt-4o',
    messages: [
      { 
        role: 'system', 
        content: 'You are a helpful Swiggy food ordering assistant on WhatsApp. Keep responses concise, clear, and easy to read on mobile.' 
      },
      { role: 'user', content: userMessage }
    ],
    tools: formattedTools
  });

  const responseMessage = completion.choices[0].message;

  // Check if LLM decided to invoke a Swiggy MCP tool
  if (responseMessage.tool_calls && responseMessage.tool_calls.length > 0) {
    const toolCall = responseMessage.tool_calls[0];
    const toolName = toolCall.function.name;
    const toolArgs = JSON.parse(toolCall.function.arguments);

    console.log(`🛠️ Executing Swiggy MCP Tool: ${toolName}`, toolArgs);

    // Execute the tool against Swiggy's remote server
    const toolResult = await mcpClient.callTool({
      name: toolName,
      arguments: toolArgs
    });

    // Send tool output back to LLM for final natural text response
    const secondCompletion = await openai.chat.completions.create({
      model: 'gpt-4o',
      messages: [
        { role: 'user', content: userMessage },
        responseMessage,
        {
          role: 'tool',
          tool_call_id: toolCall.id,
          content: JSON.stringify(toolResult)
        }
      ]
    });

    return secondCompletion.choices[0].message.content;
  }

  return responseMessage.content;
}

// POST /webhook -> Triggered by incoming WhatsApp message
app.post('/webhook', async (req, res) => {
  const body = req.body;
  if (body.object === 'whatsapp_business_account') {
    const value = body.entry?.[0]?.changes?.[0]?.value;
    if (value?.messages?.[0]) {
      const from = value.messages[0].from;
      const text = value.messages[0].text?.body;

      console.log(`📩 Processing request for ${from}: "${text}"`);

      try {
        // Process message through LLM + Swiggy MCP Tools
        const replyText = await processMessageWithSwiggy(text, null);
        await sendWhatsAppMessage(from, replyText);
      } catch (err) {
        console.error('❌ Error in MCP processing:', err);
        await sendWhatsAppMessage(from, "Sorry, I had trouble reaching Swiggy right now.");
      }
    }
    return res.sendStatus(200);
  }
  return res.sendStatus(404);
});

async function sendWhatsAppMessage(to, messageText) {
  const url = `https://graph.facebook.com/v20.0/${process.env.PHONE_NUMBER_ID}/messages`;
  await fetch(url, {
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
}

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`🚀 Swiggy MCP Bot listening on port ${PORT}`));
