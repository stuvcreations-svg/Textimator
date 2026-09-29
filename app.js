const express = require('express');
const fs = require('fs');
const path = require('path');

const publicDir = path.join(__dirname, 'public');
if (!fs.existsSync(publicDir)) {
  fs.mkdirSync(publicDir, { recursive: true });
}

const app = express();
app.use(express.json());
app.use('/files', express.static(publicDir));

const port = process.env.PORT || 3000;
const verifyToken = process.env.VERIFY_TOKEN;
const waToken = process.env.WA_TOKEN;
const waPhoneId = process.env.WA_PHONE_ID;
const geminiApiKey = process.env.GEMINI_API_KEY;

const userSessions = new Map();

const getSystemInstruction = (contractorName) => `
You are Textimator, an estimating assistant for ${contractorName}. 
Your goal is to collect details for a 3-tier (Good/Better/Best) roof replacement quote.

TONE: Extremely brief, 1-2 short sentences per reply. Ask ONLY ONE question at a time.

REQUIRED DATA TO COLLECT:
1. Homeowner Name & Address
2. Roof area (sq ft) and pitch
3. 3-Tier Pricing (Good, Better, Best)
4. Shingle brands for each tier
5. Warranty lengths for each tier

JSON OUTPUT PROTOCOL:
Return ONLY a JSON object with two keys:
1. "customer_reply": Your brief text message back to the contractor.
2. "report_data": null (if still chatting), OR a full JSON object if they ask to generate the quote.

REPORT_DATA EXACT STRUCTURE (when generating):
{
  "meta": {
    "homeowner": "Name", "addressLine1": "Street", "addressLine2": "City",
    "areaSqFt": "1200", "pitch": "6/12", "company": "Textimator", "rep": "${contractorName}", "date": "Today", "verdict": "Full roof replacement required."
  },
  "findings": [
    { "title": "Damage", "severity": "HIGH", "problems": ["Observation 1"], "solutions": ["Fix 1"] }
  ],
  "options": [
    { "name": "GOOD", "listPrice": "10000", "shingle": "Brand X", "laborYears": "10", "mfrWarranty": "Limited" },
    { "name": "BETTER", "listPrice": "12000", "shingle": "Brand Y", "laborYears": "15", "mfrWarranty": "50-Year" },
    { "name": "BEST", "listPrice": "15000", "shingle": "Brand Z", "laborYears": "25", "mfrWarranty": "Lifetime" }
  ]
}
`;

async function downloadWhatsAppImage(mediaId) {
  try {
    const res = await fetch(`https://graph.facebook.com/v26.0/${mediaId}`, {
      headers: { 'Authorization': `Bearer ${waToken}` }
    });
    const data = await res.json();
    if (!data.url) throw new Error("No media URL returned by Meta");

    const imgRes = await fetch(data.url, {
      headers: { 'Authorization': `Bearer ${waToken}` }
    });
    const buffer = await imgRes.arrayBuffer();
    
    const fileName = `img_${mediaId}.jpg`;
    fs.writeFileSync(path.join(publicDir, fileName), Buffer.from(buffer));
    return fileName;
  } catch (err) {
    console.error("❌ Media download error:", err);
    return null;
  }
}

app.get('/', (req, res) => {
  const mode = req.query['hub.mode'];
  const challenge = req.query['hub.challenge'];
  const token = req.query['hub.verify_token'];

  if (mode === 'subscribe' && token === verifyToken) {
    res.status(200).send(challenge);
  } else {
    res.status(403).end();
  }
});

app.post('/', async (req, res) => {
  res.status(200).send('EVENT_RECEIVED');

  const value = req.body.entry?.[0]?.changes?.[0]?.value || req.body.value;
  const message = value?.messages?.[0];
  const contacts = value?.contacts?.[0];
  
  if (!message) return;

  const senderProfileName = contacts?.profile?.name || 'Contractor';
  const senderPhone = message.from;

  if (!userSessions.has(senderPhone)) {
    userSessions.set(senderPhone, {
      contractorName: senderProfileName,
      chat_history: "",
      images: [],
      quoteNumber: `Q-${Math.floor(100000 + Math.random() * 900000)}` 
    });
  }
  const session = userSessions.get(senderPhone);

  if (message.type === 'text') {
    session.chat_history += `\nContractor: ${message.text.body}`;
  } else if (message.type === 'image') {
    const savedFileName = await downloadWhatsAppImage(message.image.id);
    if (savedFileName) {
      session.images.push(savedFileName);
      session.chat_history += `\n[System Note: Contractor uploaded a photo saved as ${savedFileName}]`;
    }
  } else {
    return; 
  }

  try {
    const geminiUrl = `https://generativelanguage.googleapis.com/v1beta/models/gemini-3.8-flash:generateContent?key=${geminiApiKey}`;
    
    const geminiResponse = await fetch(geminiUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        system_instruction: { parts: [{ text: getSystemInstruction(session.contractorName) }] },
        contents: [
          {
            role: 'user',
            parts: [{ text: JSON.stringify({ chat_history: session.chat_history }) }]
          }
        ],
        generationConfig: { response_mime_type: 'application/json', temperature: 0.1 }
      })
    });

    const geminiData = await geminiResponse.json();
    let rawAiOutput = geminiData.candidates?.[0]?.content?.parts?.[0]?.text;
    if (!rawAiOutput) return;

    rawAiOutput = rawAiOutput.replace(/```json/g, '').replace(/```/g, '').trim();
    const parsed = JSON.parse(rawAiOutput);
    
    session.chat_history += `\nTextimator: ${parsed.customer_reply}`;

    if (parsed.report_data) {
      const host = req.get('host');
      const quoteNumber = session.quoteNumber;

      // Attach local images to the findings array sequentially
      if (parsed.report_data.findings && session.images.length > 0) {
        parsed.report_data.findings.forEach((f, index) => {
          if (session.images[index]) {
            f.photoSrc = `https://${host}/files/${session.images[index]}`;
          }
        });
      }

      const templatePath = path.join(__dirname, 'roof-quote-template.html');
      const tpl = fs.readFileSync(templatePath, 'utf8');
      
      // Inject the JSON directly into the script tag
      const finalHtml = tpl.replace(
        /(<script id="report-data" type="application\/json">)[\s\S]*?(<\/script>)/,
        (_, a, b) => a + JSON.stringify(parsed.report_data).replace(/<\//g, '<\\/') + b
      );

      const fileName = `Roof_Quote_${quoteNumber}.html`;
      fs.writeFileSync(path.join(publicDir, fileName), finalHtml, 'utf8');
      const fileUrl = `https://${host}/files/${fileName}`;

      await sendWhatsAppMessage(senderPhone, `Your 3-Tier Proposal is ready:\n${fileUrl}`);
      return;
    }

    await sendWhatsAppMessage(senderPhone, parsed.customer_reply);

  } catch (err) {
    console.error('❌ Processing error:', err);
  }
});

async function sendWhatsAppMessage(to, text) {
  try {
    await fetch(`https://graph.facebook.com/v26.0/${waPhoneId}/messages`, {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${waToken}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ messaging_product: 'whatsapp', recipient_type: 'individual', to, type: 'text', text: { body: text } })
    });
  } catch (err) {}
}

app.listen(port, () => console.log(`Server running on port ${port}`));
