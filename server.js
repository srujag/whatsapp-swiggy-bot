import express from 'express';
import OpenAI from 'openai';

const app = express();
app.use(express.json());

const openai = process.env.OPENAI_API_KEY ? new OpenAI({ apiKey: process.env.OPENAI_API_KEY }) : null;

// Helper: Call Swiggy MCP Streamable HTTP endpoint directly
async function callSwiggyMcp(method, params = {}, token = null) {
  const headers = {
    'Content-Type': 'application/json',
    'Accept': 'application/json'
  };
  if (token) {
    headers['Authorization'] = `Bearer ${token}`;
  }

  const response = await fetch('https://mcp.swiggy.com/food', {
    method: 'POST',
    headers: headers,
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: Date.now(),
      method: method,
      params: params
    })
  });

  if (!response.ok) {
    throw new Error(`Swiggy MCP HTTP ${response.status}: ${response.statusText}`);
  }

  const data = await response.json();
  if (data.error) {
    throw new Error(`Swiggy MCP RPC Error: ${data.error.message}`);
  }

  return data.result;
}

async function handleUserQuery(userMessage, userToken = null) {
  if (!openai) {
    return "OpenAI API Key is missing in environment variables.";
  }

  try {
    // 1. Fetch tool catalogue via JSON-RPC POST request
    const toolsResult = await callSwiggyMcp('tools/list', {}, userToken);
    const tools = toolsResult?.tools || [];

    const formattedTools = tools.map(t => ({
      type: 'function',
      function: {
        name: t.name,
        description: t.description,
        parameters: t.inputSchema
      }
    }));

    // 2. Pass prompt and available tools to GPT-4o
    const completion = await openai.chat.completions.create({
      model: 'gpt-4o',
      messages: [
        { role: 'system', content: 'You are a helpful Swiggy food ordering assistant on WhatsApp.' },
        { role: 'user', content: userMessage }
      ],
      tools: formattedTools.length > 0 ? formattedTools : undefined
    });

    const responseMessage = completion.choices[0].message;

    // 3. Execute tool if requested by OpenAI
    if (responseMessage.tool_calls && responseMessage.tool_calls.length > 0) {
      const toolCall = responseMessage.tool_calls[0];
      console.log(`🛠️ Executing Swiggy Tool: ${toolCall.function.name}`);

      const toolResult = await callSwiggyMcp('tools/call', {
        name: toolCall.function.name,
        arguments: JSON.parse(toolCall.function.arguments)
      }, userToken);

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
    console.error('⚠️ Swiggy MCP Execution Error:', err.message);
    
    // Fallback response if Swiggy OAuth is required
    if (err.message.includes('401') || err.message.includes('Unauthorized')) {
      return `To search restaurants or order on Swiggy, please log in first: https://mcp.swiggy.com/auth/authorize`;
    }
    
    return `Got your message: "${userMessage}". (Swiggy response: ${err.message})`;
  }
}
