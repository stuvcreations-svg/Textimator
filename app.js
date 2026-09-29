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

const DEFAULT_STATE = {
  customer_name_and_address: null,
  building_stories: null,
  insurance_or_retail: null,
  root_cause: null,
  scope_of_work: null,
  materials_current_and_new: null,
  site_notes: null,
  add_ons_and_contingencies: null,
  total_price: null,
  timeline: null,
  payment_terms: null,
  warranty_options: null
};

const getSystemInstruction = (contractorName) => `
You are Textimator, a high-end AI estimating assistant. You are chatting with a roofing contractor named ${contractorName} who is currently in the field.

TONE & PACING (CRITICAL RULES):
- Act like you are sending a quick SMS text message. Be EXTREMELY brief, friendly, and efficient.
- Maximum 1 to 2 short sentences per reply.
- YOU MUST ASK ONLY ONE QUESTION AT A TIME. 

LANGUAGE RULE:
- If ${contractorName} speaks in Spanish, you MUST reply in Spanish. 
- ALL data extracted into the "collected_data" JSON MUST be translated into professional English for the final PDF report.

YOUR MISSION: Collect these 12 pieces of information:
1. customer_name_and_address (REQUIRED)
2. building_stories 
3. insurance_or_retail
4. root_cause 
5. scope_of_work (REQUIRED)
6. materials_current_and_new
7. site_notes 
8. add_ons_and_contingencies 
9. total_price (REQUIRED)
10. timeline 
11. payment_terms 
12. warranty_options

BEHAVIOR PROTOCOLS:
- RETURN FORMAT: Return ONLY valid raw JSON with keys: "collected_data", "customer_reply", and "is_complete".
- PICTURE RULE: Check "photos_uploaded". If 0, explicitly ask for a photo.
- REQUIRED FIELDS & SKIPPING: If they say "skip the rest" or "generate quote", check the 3 REQUIRED fields. If missing, politely ask for them. If present, set "is_complete": true.
- POST-QUOTE EDITS: If they correct a detail later, update the value, acknowledge it, and set "is_complete": true to rebuild the PDF.
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
  let incomingText = "";

  if (!userSessions.has(senderPhone)) {
    userSessions.set(senderPhone, {
      contractorName: senderProfileName,
      data: { ...DEFAULT_STATE },
      images: [], 
      isComplete: false,
      quoteNumber: `Q-${Math.floor(100000 + Math.random() * 900000)}` 
    });
  }
  const session = userSessions.get(senderPhone);

  if (message.type === 'text') {
    incomingText = message.text.body;
  } else if (message.type === 'image') {
    const savedFileName = await downloadWhatsAppImage(message.image.id);
    if (savedFileName) {
      session.images.push(savedFileName);
      incomingText = `[System Note: The contractor uploaded a roof photo.]`;
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
            parts: [{ text: JSON.stringify({ 
              current_state: session.data, 
              photos_uploaded: session.images.length,
              incoming_message: incomingText 
            }) }]
          }
        ],
        generationConfig: {
          response_mime_type: 'application/json',
          temperature: 0.1
        }
      })
    });

    const geminiData = await geminiResponse.json();
    let rawAiOutput = geminiData.candidates?.[0]?.content?.parts?.[0]?.text;
    if (!rawAiOutput) return;

    rawAiOutput = rawAiOutput.replace(/```json/g, '').replace(/```/g, '').trim();
    const parsed = JSON.parse(rawAiOutput);
    
    session.data = { ...session.data, ...parsed.collected_data };
    session.isComplete = Boolean(parsed.is_complete);

    if (session.isComplete) {
      const formatField = (val, fallback) => (val === 'skipped' || !val) ? fallback : val;
      const host = req.get('host');
      const quoteNumber = session.quoteNumber;

      let imageHtmlBlock = session.images.length > 0 
        ? session.images.map(img => `<img src="https://${host}/files/${img}" alt="Roof condition photo"/>`).join('')
        : '<p>No photos logged for this inspection.</p>';

      const fullQuoteData = {
        quote_number: quoteNumber,
        quote_date: new Date().toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' }),
        quote_valid_until: new Date(Date.now() + 30 * 86400000).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' }),
        
        customer_name_and_address: formatField(session.data.customer_name_and_address, 'Client Details Pending'),
        building_stories: formatField(session.data.building_stories, 'Not specified'),
        insurance_or_retail: formatField(session.data.insurance_or_retail, 'Standard Retail'),
        root_cause: formatField(session.data.root_cause, 'Not specified'),
        scope_of_work: formatField(session.data.scope_of_work, 'Pending evaluation'),
        materials_current_and_new: formatField(session.data.materials_current_and_new, 'TBD upon inspection'),
        site_notes: formatField(session.data.site_notes, 'None'),
        add_ons_and_contingencies: formatField(session.data.add_ons_and_contingencies, 'None specified'),
        total_price: formatField(session.data.total_price, 'TBD'),
        timeline: formatField(session.data.timeline, 'TBD'),
        payment_terms: formatField(session.data.payment_terms, 'Standard terms apply'),
        warranty_options: formatField(session.data.warranty_options, 'Standard workmanship warranty'),
        
        roof_pictures: imageHtmlBlock 
      };

      const merged = { 
        company_name: "Textimator",
        company_phone: "(555) 555-0199",
        company_email: "estimates@textimator.com",
        company_address: "Cape Coral, FL",
        ...fullQuoteData 
      };
      
      const templatePath = path.join(__dirname, 'roof-quote-template.html');
      const rawTemplate = fs.readFileSync(templatePath, 'utf8');
      const finalHtml = rawTemplate.replace(/{{([a-zA-Z0-9_]+)}}/g, (match, key) => (merged[key] !== undefined ? merged[key] : ''));

      const fileName = `Roof_Quote_${quoteNumber}.html`;
      fs.writeFileSync(path.join(publicDir, fileName), finalHtml, 'utf8');
      const fileUrl = `https://${host}/files/${fileName}`;

      await sendWhatsAppMessage(senderPhone, `The inspection report and proposal are ready:\n${fileUrl}`);
      session.isComplete = false;
      return;
    }

    let replyText = parsed.customer_reply;
    const filledFields = Object.values(session.data).filter(val => val !== null && val !== 'skipped').length;
    replyText += `\n\n📊 ${Math.round((filledFields / 12) * 100)}% | ${filledFields}/12`;
    await sendWhatsAppMessage(senderPhone, replyText);

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
