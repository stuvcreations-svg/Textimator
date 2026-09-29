const express = require('express');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

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
const GEMINI_MODEL = process.env.GEMINI_MODEL || 'gemini-3.8-flash';

// Company details printed on the report (set these in your environment)
const COMPANY_NAME = process.env.COMPANY_NAME || '';       
const COMPANY_ADDRESS = process.env.COMPANY_ADDRESS || ''; 
const REP_NAME = process.env.REP_NAME || '';               

const userSessions = new Map();

// What the bot collects from the contractor. Everything here is free text;
// the second Gemini call turns it into the structured report JSON.
const DEFAULT_STATE = {
  homeowner_name_and_address: null,
  roof_area_sqft: null,
  building_stories: null,
  current_roof_and_condition: null,
  site_notes: null,
  good_option: null,
  better_option: null,
  best_option: null,
  discount: null,
  timeline: null,
  measurement_report: null
};
const TOTAL_FIELDS = Object.keys(DEFAULT_STATE).length;

const getSystemInstruction = (contractorName) => `
You are an AI estimating assistant for a roofing contractor named ${contractorName}.

TONE & PACING (CRITICAL):
- Act like you are sending a quick SMS text message. Be EXTREMELY brief, friendly, and efficient.
- Max 1 to 2 short sentences per reply. Do not ramble.
- You MUST ask ONLY ONE question at a time. Never bombard them with multiple questions.

LANGUAGE RULE:
- If ${contractorName} speaks in Spanish, reply in Spanish.
- ALL data extracted into the "collected_data" JSON MUST be translated into professional English.

GOAL: Collect these 11 pieces of text information:
1. homeowner_name_and_address (REQUIRED): homeowner's name and the full property address with city, state and zip.
2. roof_area_sqft (REQUIRED): roof area in square feet, as the contractor states it. Never estimate it.
3. building_stories: e.g. "one story, garage attached".
4. current_roof_and_condition: the existing roof material and what the contractor saw on the roof.
5. site_notes: leaks reported by the homeowner, access, anything unusual.
6. good_option (REQUIRED): shingle brand and line, price, and labor/material warranty years for the GOOD tier.
7. better_option (REQUIRED): same details for the BETTER tier.
8. best_option (REQUIRED): same details for the BEST tier.
9. discount: any discount to apply to every tier (e.g. "5% medical professional"). Use "none" if there is none.
10. timeline: how long the job takes.
11. measurement_report: pitch, facets and linear feet only if the contractor has a measurement report. Use "skipped" if not.

The report always shows three tiers (Good, Better, Best). If the contractor gives only one price, ask for the other two.
Never invent prices or measurements. Store exactly what the contractor says.

PICTURE RULE:
- Pay attention to "photos_uploaded" in the prompt data. If it is 0, you must explicitly ask them to upload photos of the roof at some point during the chat. At least one photo is required before the report can be built.

CONVERSATION RULES:
- Return ONLY valid raw JSON with keys: "collected_data", "customer_reply", and "is_complete".
- Extract any details they provide into "collected_data".
- POST-QUOTE EDITS: If they correct a detail AFTER the quote was generated, update the value, acknowledge the change briefly, and set "is_complete": true so the system rebuilds the file.
- GENERATE QUOTE: If they ask to skip or generate the quote, check the REQUIRED fields (1, 2, 6, 7, 8). If any are missing, politely refuse and ask for the missing ones. If they are present, set "is_complete": true.
`;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function callGemini({ system, parts, temperature = 0.1 }) {
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent?key=${geminiApiKey}`;
  let data = null;
  for (let attempt = 0; attempt < 3; attempt++) {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        system_instruction: { parts: [{ text: system }] },
        contents: [{ role: 'user', parts }],
        generationConfig: { response_mime_type: 'application/json', temperature }
      })
    });
    data = await res.json();
    if (data.error && data.error.code === 503) {
      await sleep(2000);
    } else {
      break;
    }
  }
  return data;
}

const parseJsonText = (raw) => {
  const cleaned = raw.replace(/```(?:json)?/gi, '').trim();
  return JSON.parse(cleaned);
};

// ---- Report building -------------------------------------------------------

function getBuilderPrompt() {
  const md = fs.readFileSync(path.join(__dirname, 'WHATSAPP_TO_JSON_PROMPT.md'), 'utf8');
  return (
    'The input below is a structured intake summary from the contractor, plus the roof photos. ' +
    'Treat it as the conversation described in the rules.\n\n' +
    md.split('## PROMPT')[1].trim()
  );
}

async function buildReportData(session) {
  const parts = [
    {
      text:
        'INTAKE DATA (collected from the contractor by chat):\n' +
        JSON.stringify(session.data, null, 2)
    }
  ];
  for (const img of session.images) {
    parts.push({ text: `Photo ID: ${img.id}${img.caption ? ` | Contractor caption: ${img.caption}` : ''}` });
    parts.push({
      inline_data: {
        mime_type: 'image/jpeg',
        data: fs.readFileSync(path.join(publicDir, img.file)).toString('base64')
      }
    });
  }
  parts.push({ text: 'Return only the JSON.' });

  const data = await callGemini({ system: getBuilderPrompt(), parts, temperature: 0.2 });
  const raw = data.candidates?.[0]?.content?.parts?.[0]?.text;
  
  if (!raw) {
    console.error('🚨 Gemini Report Builder API Failure:', JSON.stringify(data, null, 2));
    throw new Error('Report builder returned nothing: ' + (data.error?.message || 'Unknown API Error'));
  }
  
  try {
    return parseJsonText(raw);
  } catch (parseErr) {
    console.error('🚨 JSON Parse Error. Raw model output was:\n', raw);
    throw parseErr;
  }
}

function finalizeReportData(d, session, host) {
  d.meta = d.meta || {};
  d.meta.company = COMPANY_NAME || session.contractorName;
  d.meta.companyAddress = COMPANY_ADDRESS;
  d.meta.rep = REP_NAME;
  d.meta.date = new Date().toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric' });
  d.meta.dateLabel = d.meta.dateLabel || 'Report date';

  const urlById = Object.fromEntries(session.images.map((i) => [String(i.id), `https://${host}/files/${i.file}`]));
  (d.findings || []).forEach((f) => { f.photoSrc = urlById[String(f.photoId)] || ''; });
  if (d.readingSet && d.readingSet.photoId) {
    d.readingSet.photoSrc = urlById[String(d.readingSet.photoId)] || '';
  }
  return d;
}

function missingInputs(d) {
  const m = [];
  const M = d.meta || {};
  ['homeowner', 'addressLine1', 'addressLine2', 'areaSqFt'].forEach((k) => { if (!M[k]) m.push(`meta.${k}`); });
  if (!(d.findings || []).length) m.push('findings');
  if ((d.options || []).length !== 3) m.push('options');
  (d.options || []).forEach((o, i) =>
    ['shingle', 'mfrWarranty', 'laborYears', 'listPrice'].forEach((k) => {
      if (o[k] == null || o[k] === '') m.push(`options[${i}].${k}`);
    })
  );
  return m;
}

function humanizeMissing(list) {
  const tier = ['Good', 'Better', 'Best'];
  return list.map((k) => {
    const t = k.match(/options\[(\d)\]\.(\w+)/);
    if (t) return `${tier[t[1]]} option: ${t[2].replace('listPrice', 'price').replace('laborYears', 'warranty years').replace('mfrWarranty', 'manufacturer warranty')}`;
    if (k === 'meta.homeowner') return 'homeowner name';
    if (k === 'meta.addressLine1' || k === 'meta.addressLine2') return 'property address (street, city, state, zip)';
    if (k === 'meta.areaSqFt') return 'roof area in sq ft';
    if (k === 'findings') return 'roof photos';
    return k;
  }).filter((v, i, a) => a.indexOf(v) === i);
}

function renderQuoteHtml(d) {
  const tpl = fs.readFileSync(path.join(__dirname, 'roof-quote-template.html'), 'utf8');
  return tpl.replace(
    /(<script id="report-data" type="application\/json">)[\s\S]*?(<\/script>)/,
    (_, a, b) => a + JSON.stringify(d).replace(/<\//g, '<\\/') + b
  );
}

// ---- WhatsApp media --------------------------------------------------------

async function downloadWhatsAppImage(mediaId) {
  try {
    const res = await fetch(`[https://graph.facebook.com/v26.0/$](https://graph.facebook.com/v26.0/$){mediaId}`, {
      headers: { 'Authorization': `Bearer ${waToken}` }
    });
    const data = await res.json();
    if (!data.url) throw new Error('No media URL returned by Meta');

    const imgRes = await fetch(data.url, {
      headers: { 'Authorization': `Bearer ${waToken}` }
    });
    
    if (!imgRes.ok) throw new Error(`Meta media fetch failed: ${imgRes.statusText}`);
    
    const buffer = await imgRes.arrayBuffer();
    const fileName = `img_${mediaId}.jpg`;
    fs.writeFileSync(path.join(publicDir, fileName), Buffer.from(buffer));
    return fileName;
  } catch (err) {
    console.error('❌ Media download error:', err.message);
    return null;
  }
}

// ---- Webhook ---------------------------------------------------------------

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
  let incomingText = '';

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
      const id = String(session.images.length + 1);
      const caption = message.image.caption || '';
      session.images.push({ id, file: savedFileName, caption });
      incomingText = `[System Note: The contractor just uploaded roof photo #${id}.${caption ? ` Caption: "${caption}"` : ''}]`;
    } else {
      incomingText = `[System Note: The contractor tried to upload a photo, but the download failed.]`;
    }
  } else {
    return;
  }

  try {
    const geminiData = await callGemini({
      system: getSystemInstruction(session.contractorName),
      parts: [{
        text: JSON.stringify({
          current_state: session.data,
          photos_uploaded: session.images.length,
          incoming_message: incomingText
        })
      }]
    });

    let rawAiOutput = geminiData.candidates?.[0]?.content?.parts?.[0]?.text;
    
    // Safety check 1: Did Gemini fail entirely?
    if (!rawAiOutput) {
      console.error('🚨 Gemini Intake API Failure:', JSON.stringify(geminiData, null, 2));
      return;
    }

    let parsed;
    // Safety check 2: Did Gemini return bad formatting?
    try {
      parsed = parseJsonText(rawAiOutput);
    } catch (parseErr) {
      console.error('🚨 Gemini Intake Output was not valid JSON. Raw output:', rawAiOutput);
      return;
    }

    session.data = { ...session.data, ...parsed.collected_data };
    session.isComplete = Boolean(parsed.is_complete);

    if (session.isComplete) {
      session.isComplete = false;

      if (session.images.length === 0) {
        await sendWhatsAppMessage(senderPhone, 'I need at least one roof photo before I can build the report. Please send one.');
        return;
      }

      await sendWhatsAppMessage(senderPhone, 'Building your report, one moment...');

      let reportData;
      try {
        reportData = finalizeReportData(await buildReportData(session), session, req.get('host'));
      } catch (err) {
        console.error('❌ Report build error:', err);
        await sendWhatsAppMessage(senderPhone, "Sorry, I couldn't build the report. Please send \"generate\" again.");
        return;
      }

      const missing = missingInputs(reportData);
      if (missing.length) {
        await sendWhatsAppMessage(senderPhone, `Almost there. I still need: ${humanizeMissing(missing).join('; ')}.`);
        return;
      }

      const fileName = `Roof_Quote_${crypto.randomBytes(8).toString('hex')}.html`;
      fs.writeFileSync(path.join(publicDir, fileName), renderQuoteHtml(reportData), 'utf8');
      const fileUrl = `https://${req.get('host')}/files/${fileName}`;

      await sendWhatsAppMessage(senderPhone, `The inspection report and proposal are ready:\n${fileUrl}`);
      await sendWhatsAppDocument(senderPhone, fileUrl, fileName, `Estimate Proposal ${session.quoteNumber}`);

      if (Array.isArray(reportData.flags) && reportData.flags.length) {
        await sendWhatsAppMessage(senderPhone, `Notes for you (not in the report):\n- ${reportData.flags.join('\n- ')}`);
      }
      return;
    }

    let replyText = parsed.customer_reply;
    const filledFields = Object.values(session.data).filter((val) => val !== null && val !== 'skipped').length;
    const progressPct = Math.round((filledFields / TOTAL_FIELDS) * 100);

    replyText += `\n\n📊 ${progressPct}% | ${filledFields}/${TOTAL_FIELDS}`;

    await sendWhatsAppMessage(senderPhone, replyText);
  } catch (err) {
    console.error('❌ Processing error:', err);
  }
});

async function sendWhatsAppMessage(to, text) {
  try {
    const res = await fetch(`[https://graph.facebook.com/v26.0/$](https://graph.facebook.com/v26.0/$){waPhoneId}/messages`, {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${waToken}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ messaging_product: 'whatsapp', recipient_type: 'individual', to, type: 'text', text: { body: text } })
    });
    if (!res.ok) {
      const err = await res.json();
      console.error('❌ WhatsApp Message Failed:', JSON.stringify(err, null, 2));
    }
  } catch (err) {
    console.error('❌ WhatsApp Network Error:', err.message);
  }
}

async function sendWhatsAppDocument(to, fileUrl, fileName, caption) {
  try {
    const res = await fetch(`[https://graph.facebook.com/v26.0/$](https://graph.facebook.com/v26.0/$){waPhoneId}/messages`, {
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
    if (!res.ok) {
      const err = await res.json();
      console.error('❌ WhatsApp Document Failed:', JSON.stringify(err, null, 2));
    }
  } catch (err) {
    console.error('❌ WhatsApp Network Error:', err.message);
  }
}

app.listen(port, () => console.log(`Server running on port ${port}`));
