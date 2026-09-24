import express from 'express';

const app = express();
app.use(express.json());

// GET /webhook - Meta Handshake Verification
app.get('/webhook', (req, res) => {
  const mode = req.query['hub.mode'];
  const token = req.query['hub.verify_token'];
  const challenge = req.query['hub.challenge'];

  if (mode === 'subscribe' && token === process.env.WEBHOOK_VERIFY_TOKEN) {
    console.log('✅ Webhook verified!');
    return res.status(200).send(challenge);
  }
  return res.sendStatus(403);
});

// POST /webhook - Receiver for incoming WhatsApp messages
app.post('/webhook', async (req, res) => {
  const body = req.body;

  if (body.object === 'whatsapp_business_account') {
    const value = body.entry?.[0]?.changes?.[0]?.value;

    if (value?.messages?.[0]) {
      const from = value.messages[0].from;
      const text = value.messages[0].text?.body;

      console.log(`📩 Received: "${text}" from ${from}`);
      await sendWhatsAppMessage(from, `Got your message: "${text}". Processing...`);
    }
    return res.sendStatus(200);
  }
  return res.sendStatus(404);
});

async function sendWhatsAppMessage(to, message) {
  const url = `https://graph.facebook.com/v20.0/${process.env.PHONE_NUMBER_ID}/messages`;
  try {
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
        text: { body: message }
      }),
    });
  } catch (err) {
    console.error('❌ Send error:', err);
  }
}

const PORT = process.env.PORT || 10000;
app.listen(PORT, () => console.log(`🚀 Server on port ${PORT}`));
