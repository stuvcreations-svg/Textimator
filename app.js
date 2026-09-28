const express = require('express');
const fs = require('fs');
const path = require('path');

const app = express();
app.use(express.json());

// Expose the public folder so images can be loaded in the browser
app.use('/files', express.static(path.join(__dirname, 'public')));

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
  // Note: roof_pictures is now handled securely outside of Gemini's state below
};

const getSystemInstruction = (contractorName) => `
You are an expert AI estimating assistant. You are chatting with a roofing contractor named ${contractorName} who is currently in the field.

Keep your tone natural and helpful. ADAPT to their conversational style and always address them by name appropriately. 

LANGUAGE RULE (CRITICAL):
- If ${contractorName} speaks to you in Spanish, you MUST reply to them in Spanish. 
- However, ALL data you extract into the "collected_data" JSON MUST be translated into professional English for the final report.

Your goal is to collect these 12 pieces of text information:
1. customer_name_and_address: Customer's name and property address.
2. building_stories: Single-story or multi-story.
3. scope_of_work: Localized repair or full roof replacement.
4. materials_current_and_new: Current roof material and specific new material to install.
5. root_cause: Root cause of the issue (e.g., wind/hail, age, active leak).
6. site_notes: Property access restrictions or specific site notes.
7. insurance_or_retail: Insurance claim or retail (out-of-pocket).
8. add_ons_and_contingencies: Add-ons or special conditions (skylights, rotten wood).
9. total_price: Total final price to quote the customer.
10. timeline: Estimated start date or lead time for the build.
11. payment_terms: Payment terms (e.g., 50% deposit, financing).
12. warranty_options: Workmanship or manufacturer warranty offered.

CONVERSATION RULES:
- Return ONLY valid raw JSON with keys: "collected_data", "customer_reply", and "is_complete".
- Extract any details they provide into "collected_data". 
- If the system notes that an image was uploaded, naturally acknowledge you received the photo in your "customer_reply".
- Ask conversational follow-up questions to gather the missing fields (1 or 2 at a time).

THE "SOFT-SKIP" LOGIC:
- If they seem finished or ask you to build the quote, check if any of the 12 fields are still null.
- If fields are missing, politely list what is missing and ask if they want to proceed without them. 
- If they say to proceed/skip, update the missing null fields in "collected_data" to "skipped", and set "is_complete": true.
`;

// Helper function to download and save WhatsApp media
async function downloadWhatsAppImage(mediaId) {
  try {
    // 1. Get the media URL from Meta
    const res = await fetch(`https://graph.facebook.com/v26.0/${mediaId}`, {
      headers: { 'Authorization': `Bearer ${waToken}` }
    });
    const data = await res.json();
    if (!data.url) throw new Error("No media URL returned by Meta");

    // 2. Download the binary file using the URL
    const imgRes = await fetch(data.url, {
      headers: { 'Authorization': `Bearer ${waToken}` }
    });
    const buffer = await imgRes.arrayBuffer();
    
    // 3. Save it to the public folder
    const fileName = `img_${mediaId}.jpg`;
    const publicDir = path.join(__dirname, 'public');
    if (!fs.existsSync(publicDir)) fs.mkdirSync(publicDir, { recursive: true });
    
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

  // Initialize session with a dedicated images array
  if (!userSessions.has(senderPhone)) {
    userSessions.set(senderPhone, {
      contractorName: senderProfileName,
      data: { ...DEFAULT_STATE },
      images: [], // Securely holds downloaded file names
      isComplete: false
    });
  }
  const session = userSessions.get(senderPhone);

  if (session.isComplete) {
    await sendWhatsAppMessage(senderPhone, `Tu estimación ya fue generada. / Your estimate is already generated!`);
    return;
  }

  // Handle Text vs Image routing
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
    // Ignore voice notes, documents, etc.
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
              parts: [{ text: JSON.stringify({ current_state: session.data, incoming_message: incomingText }) }]
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
    
    if (!rawAiOutput) {
      console.error("❌ Gemini empty output:", JSON.stringify(geminiData));
      return;
    }

    rawAiOutput = rawAiOutput.replace(/```json/g, '').replace(/```/g, '').trim();
    const parsed = JSON.parse(rawAiOutput);
    
    session.data = { ...session.data, ...parsed.collected_data };
    session.isComplete = Boolean(parsed.is_complete);

    if (session.isComplete) {
      const quoteNumber = `Q-${Math.floor(100000 + Math.random() * 900000)}`;
      const formatField = (val, fallback) => (val === 'skipped' || !val) ? fallback : val;
      const host = req.get('host');

      // Generate HTML img tags for all successfully downloaded photos
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
        
        // Inject the generated image tags into the template
        roof_pictures: imageHtmlBlock 
      };

      const companyDefaults = {
        company_name: "Stuv Creations",
        company_tagline: "Contractor Intake & Proposal Generation",
        company_phone: "(555) 555-0199",
        company_email: "estimates@stuvcreations.com",
        company_address: "Cape Coral, FL"
      };

      const merged = { ...companyDefaults, ...fullQuoteData };
      const templatePath = path.join(__dirname, 'roof-quote-template.html');
      const rawTemplate = fs.readFileSync(templatePath, 'utf8');
      
      const finalHtml = rawTemplate.replace(/{{([a-zA-Z0-9_]+)}}/g, (match, key) => (merged[key] !== undefined ? merged[key] : ''));

      const fileName = `Roof_Quote_${quoteNumber}.html`;
      fs.writeFileSync(path.join(__dirname, 'public', fileName), finalHtml, 'utf8');

      const fileUrl = `https://${host}/files/${fileName}`;

      await sendWhatsAppMessage(senderPhone, `The inspection report and proposal are ready:\n${fileUrl}`);
      await sendWhatsAppDocument(senderPhone, fileUrl, fileName, `Estimate Proposal ${quoteNumber}`);
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
