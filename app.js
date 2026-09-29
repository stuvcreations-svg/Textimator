const express = require('express');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

// 1. Build the public directory immediately when the server boots
const publicDir = path.join(__dirname, 'public');
if (!fs.existsSync(publicDir)) {
  fs.mkdirSync(publicDir, { recursive: true });
}

const TEMPLATE_PATH = path.join(__dirname, 'roof-quote-template.html');
const PROMPT_PATH = path.join(__dirname, 'WHATSAPP_TO_JSON_PROMPT.md');

// Fail loudly at boot if the wrong template or a missing file is deployed.
// (The old {{placeholder}} template will NOT work with this app.)
try {
  const tpl = fs.readFileSync(TEMPLATE_PATH, 'utf8');
  if (!tpl.includes('id="report-data"')) {
    console.error('❌ roof-quote-template.html is the OLD placeholder template. Replace it with the new data-driven template.');
  }
  if (!fs.existsSync(PROMPT_PATH)) {
    console.error('❌ WHATSAPP_TO_JSON_PROMPT.md is missing next to app.js.');
  }
} catch (err) {
  console.error('❌ Could not read roof-quote-template.html:', err.message);
}

const app = express();
app.use(express.json());

// Quote files are served from here. File names are random, so links can't be guessed.
app.use('/files', express.static(publicDir));

const port = process.env.PORT || 3000;
const verifyToken = process.env.VERIFY_TOKEN;
const waToken = process.env.WA_TOKEN;
const waPhoneId = process.env.WA_PHONE_ID;
const geminiApiKey = process.env.GEMINI_API_KEY;
const GEMINI_MODEL = process.env.GEMINI_MODEL || 'gemini-3.8-flash';

// Printed on the report. Set these in your environment.
const COMPANY_NAME = process.env.COMPANY_NAME || '';       // e.g. "Top Elite Roofing"
const COMPANY_ADDRESS = process.env.COMPANY_ADDRESS || ''; // optional
const REP_NAME = process.env.REP_NAME || '';               // optional

const userSessions = new Map();

// 2. Data structure: the 12 fields the report needs
const DEFAULT_STATE = {
  customer_name_and_address: null,
  roof_area_sqft: null,
  building_stories: null,
  current_roof_and_condition: null,
  site_notes: null,
  good_option: null,
  better_option: null,
  best_option: null,
  discount: null,
  add_ons_and_contingencies: null,
  timeline: null,
  measurement_report: null
};
const TOTAL_FIELDS = Object.keys(DEFAULT_STATE).length;

// ==========================================
// 3. AI SYSTEM INSTRUCTIONS (TONE & RULES)
// ==========================================
const getSystemInstruction = (contractorName) => `
You are Textimator, a high-end AI estimating assistant. You are chatting with a roofing contractor named ${contractorName} who is currently in the field.

TONE & PACING (CRITICAL RULES):
- Act like you are sending a quick SMS text message. Be EXTREMELY brief, friendly, and efficient.
- Maximum 1 to 2 short sentences per reply. Do not ramble or use robotic customer-service talk.
- YOU MUST ASK ONLY ONE QUESTION AT A TIME. Never bombard them with a list of missing items.

LANGUAGE RULE:
- If ${contractorName} speaks in Spanish, you MUST reply in Spanish.
- However, ALL data extracted into the "collected_data" JSON MUST be translated into professional English for the final report.

YOUR MISSION: Collect these 12 pieces of information:
1. customer_name_and_address (REQUIRED - homeowner name plus the full property address with city, state and zip)
2. roof_area_sqft (REQUIRED - total roof area in square feet, exactly as the contractor states it. Never estimate it)
3. building_stories (e.g., one story, garage attached)
4. current_roof_and_condition (e.g., 20-year-old shingles, worn through to the mat)
5. site_notes (e.g., leaks reported, access restrictions, dogs in yard)
6. good_option (REQUIRED - shingle brand and line, price, labor/material warranty years)
7. better_option (REQUIRED - same details, BETTER tier)
8. best_option (REQUIRED - same details, BEST tier)
9. discount (e.g., 5% medical professional, applied to every tier. Use "none" if there is none)
10. add_ons_and_contingencies (e.g., replace up to 20% damaged wood; any change to standard terms such as deposit)
11. timeline (e.g., Up to 7 days)
12. measurement_report (pitch, facets and linear feet, only if the contractor has a measurement report. Use "skipped" if not)

The report always shows three tiers (Good, Better, Best). If the contractor gives only one price, ask for the other two, one at a time.
Never invent prices, measurements or warranty terms. Store exactly what the contractor says.

BEHAVIOR PROTOCOLS:
- RETURN FORMAT: Return ONLY valid raw JSON with keys: "collected_data", "customer_reply", and "is_complete".
- PROGRESSION: Naturally acknowledge their answer, extract it to "collected_data", and ask for the very next missing field on the list.
- PICTURE RULE: Check "photos_uploaded" in the user prompt. If it is 0, explicitly ask them to snap pictures of the roof (the report is built from the photos, so more is better). If > 0, acknowledge the photo naturally.
- REQUIRED FIELDS & SKIPPING: If they say "skip the rest" or "generate quote", check the 5 REQUIRED fields (1, 2, 6, 7, 8) and that at least one photo is uploaded. If anything is missing, politely refuse and ask for it. If all are present, set "is_complete": true.
- POST-QUOTE EDITS: If they correct a detail AFTER the quote was generated (e.g., "Actually, change the Better price to $26k"), update the value, acknowledge the change briefly, and set "is_complete": true so the system rebuilds the report.
`;
// ==========================================

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// One place for every Gemini call, with the 503 retry you already had
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
  if (data && data.error) console.error('❌ Gemini error:', JSON.stringify(data.error));
  return data;
}

const parseJsonText = (raw) => JSON.parse(raw.replace(/```json/g, '').replace(/```/g, '').trim());

// ---- Report building -------------------------------------------------------

// Reads the extraction rules from WHATSAPP_TO_JSON_PROMPT.md (everything after "## PROMPT")
function getBuilderPrompt() {
  const md = fs.readFileSync(PROMPT_PATH, 'utf8');
  return (
    'The input below is a structured intake summary from the contractor, plus the roof photos. ' +
    'Treat it as the conversation described in the rules.\n\n' +
    md.split('## PROMPT')[1].trim()
  );
}

const photoNumber = (id) => String(id == null ? '' : id).replace(/\D/g, '');

async function buildReportData(session) {
  const parts = [
    { text: 'INTAKE DATA (collected from the contractor by chat):\n' + JSON.stringify(session.data, null, 2) }
  ];
  // On an edit, keep the findings and wording the customer already saw; change only what the contractor corrected.
  if (session.report) {
    parts.push({
      text:
        'PREVIOUS REPORT JSON (already sent to the customer). Keep findings, photo choices and wording exactly as they are. ' +
        'Change ONLY what differs from the intake data above:\n' + JSON.stringify(session.report)
    });
  }
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
  const raw = data?.candidates?.[0]?.content?.parts?.[0]?.text;
  if (!raw) throw new Error('Report builder returned nothing');
  return parseJsonText(raw);
}

function finalizeReportData(d, session) {
  d.meta = d.meta || {};
  d.meta.company = COMPANY_NAME || session.contractorName;
  d.meta.companyAddress = COMPANY_ADDRESS;
  d.meta.rep = REP_NAME;
  d.meta.date = new Date().toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric' });
  d.meta.dateLabel = d.meta.dateLabel || 'Report date';

  // Embed each photo INSIDE the report file (data URI), so the report is self-contained
  // and photos always show, wherever and however the file is opened.
  const srcById = {};
  for (const img of session.images) {
    try {
      const b64 = fs.readFileSync(path.join(publicDir, img.file)).toString('base64');
      srcById[photoNumber(img.id)] = `data:image/jpeg;base64,${b64}`;
    } catch (err) {
      console.error('❌ Could not read photo', img.file, err.message);
    }
  }
  (d.findings || []).forEach((f) => { f.photoSrc = srcById[photoNumber(f.photoId)] || ''; });
  if (d.readingSet && d.readingSet.photoId) {
    d.readingSet.photoSrc = srcById[photoNumber(d.readingSet.photoId)] || '';
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
  const names = { listPrice: 'price', laborYears: 'warranty years', mfrWarranty: 'manufacturer warranty', shingle: 'shingle' };
  const out = list.map((k) => {
    const t = k.match(/options\[(\d)\]\.(\w+)/);
    if (t) return `${tier[t[1]]} option ${names[t[2]] || t[2]}`;
    if (k === 'options') return 'the Good, Better and Best options';
    if (k === 'meta.homeowner') return 'homeowner name';
    if (k === 'meta.addressLine1' || k === 'meta.addressLine2') return 'full property address (street, city, state, zip)';
    if (k === 'meta.areaSqFt') return 'roof area in sq ft';
    if (k === 'findings') return 'roof photos';
    return k;
  });
  return out.filter((v, i, a) => a.indexOf(v) === i);
}

function renderQuoteHtml(d) {
  const tpl = fs.readFileSync(TEMPLATE_PATH, 'utf8');
  const re = /(<script id="report-data" type="application\/json">)[\s\S]*?(<\/script>)/;
  if (!re.test(tpl)) throw new Error('Template has no report-data block (old template deployed?)');
  return tpl.replace(re, (_, a, b) => a + JSON.stringify(d).replace(/<\//g, '<\\/') + b);
}

// ---- WhatsApp media --------------------------------------------------------

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
  let incomingText = "";

  if (!userSessions.has(senderPhone)) {
    userSessions.set(senderPhone, {
      contractorName: senderProfileName,
      data: { ...DEFAULT_STATE },
      images: [], // [{ id, file, caption }]
      report: null, // last report JSON sent, kept so edits don't rewrite the findings
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

    const rawAiOutput = geminiData?.candidates?.[0]?.content?.parts?.[0]?.text;
    if (!rawAiOutput) {
      await sendWhatsAppMessage(senderPhone, "Sorry, I hit a hiccup. Please send that again.");
      return;
    }

    const parsed = parseJsonText(rawAiOutput);
    session.data = { ...session.data, ...parsed.collected_data };
    session.isComplete = Boolean(parsed.is_complete);

    if (session.isComplete) {
      session.isComplete = false; // reset so they can keep editing this quote

      if (session.images.length === 0) {
        await sendWhatsAppMessage(senderPhone, 'I need at least one roof photo before I can build the report. Please send one.');
        return;
      }

      await sendWhatsAppMessage(senderPhone, 'Building your report, one moment...');

      let reportData;
      try {
        reportData = finalizeReportData(await buildReportData(session), session);
      } catch (err) {
        console.error('❌ Report build error:', err);
        await sendWhatsAppMessage(senderPhone, 'Sorry, I could not build the report. Please say "generate" again.');
        return;
      }

      const missing = missingInputs(reportData);
      if (missing.length) {
        await sendWhatsAppMessage(senderPhone, `Almost there. I still need: ${humanizeMissing(missing).join('; ')}.`);
        return;
      }

      // Save the version we sent (without the heavy embedded photos) so edits keep the same findings
      session.report = JSON.parse(JSON.stringify(reportData, (k, v) => (k === 'photoSrc' ? undefined : v)));

      // Random file name: the file contains customer details and must not be guessable
      const host = req.get('host');
      const fileName = `Roof_Quote_${crypto.randomBytes(8).toString('hex')}.html`;
      fs.writeFileSync(path.join(publicDir, fileName), renderQuoteHtml(reportData), 'utf8');
      const fileUrl = `https://${host}/files/${fileName}`;

      await sendWhatsAppMessage(senderPhone, `The inspection report and proposal are ready:\n${fileUrl}`);
      await sendWhatsAppDocument(senderPhone, fileUrl, fileName, `Estimate Proposal ${session.quoteNumber}`);

      if (Array.isArray(reportData.flags) && reportData.flags.length) {
        await sendWhatsAppMessage(senderPhone, `Notes for you (not in the report):\n- ${reportData.flags.join('\n- ')}`);
      }
      return;
    }

    // Mathematical Progress Tracker
    let replyText = parsed.customer_reply;
    const filledFields = Object.values(session.data).filter((val) => val !== null && val !== 'skipped').length;
    const progressPct = Math.round((filledFields / TOTAL_FIELDS) * 100);

    replyText += `\n\n📊 ${progressPct}% | ${filledFields}/${TOTAL_FIELDS}`;

    await sendWhatsAppMessage(senderPhone, replyText);
  } catch (err) {
    console.error('❌ Processing error:', err);
    await sendWhatsAppMessage(senderPhone, "Sorry, I hit a hiccup. Please send that again.");
  }
});

async function sendWhatsAppMessage(to, text) {
  try {
    const response = await fetch(`https://graph.facebook.com/v26.0/${waPhoneId}/messages`, {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${waToken}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ messaging_product: 'whatsapp', recipient_type: 'individual', to, type: 'text', text: { body: text } })
    });
    const result = await response.json();
    if (result.error) console.error('❌ Meta API Error (Text):', JSON.stringify(result.error));
  } catch (err) {
    console.error('❌ WhatsApp text error:', err);
  }
}

async function sendWhatsAppDocument(to, fileUrl, fileName, caption) {
  try {
    const response = await fetch(`https://graph.facebook.com/v26.0/${waPhoneId}/messages`, {
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
    const result = await response.json();
    if (result.error) console.error('❌ Meta API Error (Doc):', JSON.stringify(result.error));
  } catch (err) {
    console.error('❌ WhatsApp doc error:', err);
  }
}

app.listen(port, () => console.log(`Server running on port ${port}`));
