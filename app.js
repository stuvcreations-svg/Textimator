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
  scope_of_work: null,
  materials_current_and_new: null,
  root_cause: null,
  site_notes: null,
  insurance_or_retail: null,
  add_ons_and_contingencies: null,
  total_price: null,
  timeline: null,
  payment_terms: null,
  warranty_options: null
};

// Extreme brevity, 1 question at a time, explicit photo requests
const getSystemInstruction = (contractorName) => `
You are an AI estimating assistant for a roofing contractor named ${contractorName}.

TONE & PACING (CRITICAL):
- Act like you are sending a quick SMS text message. Be EXTREMELY brief, friendly, and efficient.
- Max 1 to 2 short sentences per reply. Do not ramble.
- You MUST ask ONLY ONE question at a time. Never bombard them with multiple questions.

LANGUAGE RULE:
- If ${contractorName} speaks in Spanish, reply in Spanish. 
- ALL data extracted into the "collected_data" JSON MUST be translated into professional English.

GOAL: Collect these 12 pieces of text information:
1. customer_name_and_address (REQUIRED)
2. building_stories
3. scope_of_work (REQUIRED)
4. materials_current_and_new
5. root_cause
6. site_notes
7. insurance_or_retail
8. add_ons_and_contingencies
9. total_price (REQUIRED)
10. timeline
11. payment_terms
12. warranty_options

PICTURE RULE:
- Pay attention to "photos_uploaded" in the prompt data. If it is 0, you must explicitly ask them to upload photos of the roof at some point during the chat.

CONVERSATION RULES:
- Return ONLY valid raw JSON with keys: "collected_data", "customer_reply", and "is_complete".
- Extract any details they provide into "collected_data". 
- POST-QUOTE EDITS: If they correct a detail AFTER the quote was generated, update the value, acknowledge the change briefly, and set "is_complete": true so the system rebuilds the file.
- GENERATE QUOTE: If they ask to skip or generate the quote, check the 3 REQUIRED fields. If any are missing, politely refuse and ask for the missing ones. If they are present, set "is_complete": true.
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
    console.log(`💬 Text from ${senderProfileName}: ${incomingText}`);
  } else if (message.type === 'image') {
    console.log(`📸 Image received from ${senderProfileName}. Downloading...`);
    const savedFileName = await downloadWhatsAppImage(message.image.id);
    
    if (savedFileName) {
      session.images.push(savedFileName);
      const caption = message.image.caption ? ` Caption: "${message.image.caption}"` : "";
      incomingText = `[System Note: The contractor just uploaded a roof photo.${caption}]`;
    } else {
      incomingText = `[System Note: The contractor tried to upload a photo, but the download failed.]`;
    }
  } else {
    return; 
  }

  try {
    const geminiUrl = `https://generativelanguage.googleapis.com/v1beta/models/gemini-3.8-flash:generateContent?key=${geminiApiKey}`;
    let geminiData = null;
    let attempt = 0;
    const maxAttempts = 3;

    while (attempt < maxAttempts) {
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

      geminiData = await geminiResponse.json();

      if (geminiData.error && geminiData.error.code === 503) {
        attempt++;
        await new Promise(resolve => setTimeout(resolve, 2000));
      } else {
        break;
      }
    }

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
        ? session.images.map(img => `<img src="https://${host}/files/${img}" style="width:100%; max-width:250px; border-radius:8px; margin-bottom:10px; display:block;" alt="Roof condition photo"/>`).join('')
        : 'No photos logged';

      const fullQuoteData = {
        quote_number: quoteNumber,
        quote_date: new Date().toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' }),
        quote_valid_until: new Date(Date.now() + 30 * 86400000).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' }),
        
        customer_name_and_address: formatField(session.data.customer_name_and_address, 'Client Details Pending'),
        building_stories: formatField(session.data.building_stories, 'Not specified'),
        scope_of_work: formatField(session.data.scope_of_work, 'Pending evaluation'),
        materials_current_and_new: formatField(session.data.materials_current_and_new, 'TBD upon inspection'),
        root_cause: formatField(session.data.root_cause, 'Not specified'),
        site_notes: formatField(session.data.site_notes, 'None'),
        insurance_or_retail: formatField(session.data.insurance_or_retail, 'Standard Retail'),
        add_ons_and_contingencies: formatField(session.data.add_ons_and_contingencies, 'None specified'),
        total_price: formatField(session.data.total_price, 'TBD after physical inspection'),
        timeline: formatField(session.data.timeline, 'TBD'),
        payment_terms: formatField(session.data.payment_terms, 'Standard terms apply'),
        warranty_options: formatField(session.data.warranty_options, 'Standard workmanship warranty'),
        
        roof_pictures: imageHtmlBlock 
      };

const companyDefaults = {
        company_name: "Textimator",
        company_tagline: "Contractor Intake & Proposal Generation",
        company_phone: "(555) 555-0199", // Update with your actual business number
        company_email: "estimates@textimator.com",
        company_address: "Cape Coral, FL"
      };

      const merged = { ...companyDefaults, ...fullQuoteData };
      const templatePath = path.join(__dirname, 'roof-quote-template.html');
      const rawTemplate = fs.readFileSync(templatePath, 'utf8');
      
      const finalHtml = rawTemplate.replace(/{{([a-zA-Z0-9_]+)}}/g, (match, key) => (merged[key] !== undefined ? merged[key] : ''));

      const fileName = `Roof_Quote_${quoteNumber}.html`;
      fs.writeFileSync(path.join(publicDir, fileName), finalHtml, 'utf8');

      const fileUrl = `https://${host}/files/${fileName}`;

      await sendWhatsAppMessage(senderPhone, `The inspection report and proposal are ready:\n${fileUrl}`);
      await sendWhatsAppDocument(senderPhone, fileUrl, fileName, `Estimate Proposal ${quoteNumber}`);
      
      session.isComplete = false;
      return;
    }

    let replyText = parsed.customer_reply;
    const filledFields = Object.values(session.data).filter(val => val !== null && val !== 'skipped').length;
    const progressPct = Math.round((filledFields / 12) * 100);
    
    replyText += `\n\n📊 ${progressPct}% | ${filledFields}/12`;

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

async function sendWhatsAppDocument(to, fileUrl, fileName, caption) {
  try {
    await fetch(`https://graph.facebook.com/v26.0/${waPhoneId}/messages`, {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${waToken}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        messaging_product: 'whatsapp',
        recipient_type: 'individual',
        to,
        type: 'document',
        document: { link: fileUrl, filename: fileName, caption }
      })
    });
  } catch (err) {}
}

app.listen(port, () => console.log(`Server running on port ${port}`));
