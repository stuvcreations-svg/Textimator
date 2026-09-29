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
// Default look of the report: auto (follows the customer's device), day, dark or blush.
// The customer can still switch it with the buttons on the page.
const REPORT_THEME = process.env.REPORT_THEME || 'auto';
const THEMES = ['auto', 'day', 'dark', 'blush'];
const THEME_ALIAS = { woman: 'blush', rose: 'blush', pink: 'blush', light: 'day' };
const themeOf = (v) => {
  const raw = String(v || '').toLowerCase().trim();
  const t = THEME_ALIAS[raw] || raw;
  return THEMES.includes(t) ? t : null;
};

const userSessions = new Map();

// 2. Data structure: the 12 fields the report needs
const DEFAULT_STATE = {
  customer_name_and_address: null,
  job_type: null,
  roof_area_sqft: null,
  building_stories: null,
  current_roof_and_condition: null,
  site_notes: null,
  good_option: null,
  better_option: null,
  best_option: null,
  repair_items_and_prices: null,
  repair_warranty: null,
  discount: null,
  add_ons_and_contingencies: null,
  timeline: null,
  measurement_report: null,
  report_theme: null // optional, never asked: day | dark | blush
};
// "repair" or "replacement" (default). The contractor chooses; the model only records it.
const jobTypeOf = (data) =>
  /repair/i.test(data.job_type || '') && !/replac/i.test(data.job_type || '') ? 'repair' : 'replacement';

// Fields that count toward the progress counter for this job type
function relevantKeys(data) {
  const skip = jobTypeOf(data) === 'repair'
    ? ['good_option', 'better_option', 'best_option']
    : ['repair_items_and_prices', 'repair_warranty'];
  skip.push('report_theme');
  return Object.keys(DEFAULT_STATE).filter((k) => !skip.includes(k));
}

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

YOUR MISSION: Collect the pieces of information below. Ask about the job type right after the customer name and address.
1. customer_name_and_address (REQUIRED - homeowner name plus the full property address with city, state and zip)
2. job_type (REQUIRED - exactly "replacement" for a full roof replacement, or "repair" for repairs only. Ask: "Is this a full replacement or a repair?")
3. roof_area_sqft (REQUIRED - total roof area in square feet, exactly as the contractor states it. Never estimate it)
4. building_stories (e.g., one story, garage attached)
5. current_roof_and_condition (e.g., 20-year-old shingles, worn through to the mat)
6. site_notes (e.g., leaks reported, access restrictions, dogs in yard)
FOR REPLACEMENT JOBS ONLY:
7. good_option (REQUIRED - the exact shingle brand AND product line, the price, the labor/material warranty in years, AND the manufacturer's warranty, e.g. "GAF Timberline HDZ, $20,000, 5-year labor warranty, GAF limited lifetime")
8. better_option (REQUIRED - same four details, BETTER tier)
9. best_option (REQUIRED - same four details, BEST tier)
FOR REPAIR JOBS ONLY:
10. repair_items_and_prices (REQUIRED - each repair the contractor will do with its price, or one total price for all the work, e.g. "replace 12 ridge shingles $650; reseal two pipe boots $300")
11. repair_warranty (workmanship warranty in years for the repairs. Use "skipped" if none)
FOR BOTH:
12. discount (e.g., 5% medical professional, applied to the whole price. Use "none" if there is none)
13. add_ons_and_contingencies (e.g., replace up to 20% damaged wood; payment terms if not standard, such as payment on completion or a different deposit)
14. timeline (e.g., Up to 7 days)
15. measurement_report (pitch, facets and linear feet, only if the contractor has a measurement report. Use "skipped" if not)

A replacement report always shows three tiers (Good, Better, Best). If the contractor gives only one price for a replacement, ask for the other two, one at a time.
For a repair, never ask about tiers or shingle warranties.
Never invent prices, measurements or warranty terms. Store exactly what the contractor says.
If they name only a brand ("GAF shingles"), ask which exact product line. If they give no manufacturer warranty for a tier, ask for it. Never guess either one.

report_theme (OPTIONAL. NEVER ask about it. Only if the contractor asks for a look for the report, store exactly "day", "dark" or "blush"; if they say "rose", "pink" or "woman", store "blush")

BEHAVIOR PROTOCOLS:
- RETURN FORMAT: Return ONLY valid raw JSON with keys: "collected_data", "customer_reply", and "is_complete".
- PROGRESSION: Naturally acknowledge their answer, extract it to "collected_data", and ask for the very next missing field on the list.
- PICTURE RULE: Check "photos_uploaded" in the user prompt. If it is 0, explicitly ask them to snap pictures of the roof (the report is built from the photos, so more is better). If > 0, acknowledge the photo naturally.
- REQUIRED FIELDS & SKIPPING: If they say "skip the rest" or "generate quote", check the REQUIRED fields (name and address, job type, roof area, and either the three options for a replacement or the repair items and prices for a repair) and that at least one photo is uploaded. If anything is missing, politely refuse and ask for it. If all are present, set "is_complete": true.
- POST-QUOTE EDITS: If they correct a detail AFTER the quote was generated (e.g., "Actually, change the Better price to $26k"), update the value, acknowledge the change briefly, and set "is_complete": true so the system rebuilds the report. This includes a request to change the report's look ("make it dark").
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
  // The contractor's answer decides the job type, not the model
  d.meta.theme = themeOf(session.data.report_theme) || themeOf(REPORT_THEME) || 'auto';
  d.meta.jobType = jobTypeOf(session.data);
  d.meta.product = d.meta.jobType === 'repair' ? 'Roof repair' : 'Shingle roof replacement';
  if (d.meta.jobType === 'repair') d.options = [];
  else delete d.repair;

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
  // Cover background: the builder picks one of the contractor's photos (widest shot of the shingles).
  // If it is already used by a finding or the overview, the template reuses it without copying the data.
  const usedIds = new Set(
    [...(d.findings || []).map((f) => photoNumber(f.photoId)), d.readingSet && photoNumber(d.readingSet.photoId)].filter(Boolean)
  );
  const coverId = photoNumber(d.meta.coverPhotoId);
  delete d.meta.coverPhotoSrc;
  if (coverId && srcById[coverId]) {
    if (!usedIds.has(coverId)) d.meta.coverPhotoSrc = srcById[coverId];
  } else {
    delete d.meta.coverPhotoId; // the template falls back to the first finding's photo
  }
  const distinct = new Set((d.findings || []).map((f) => photoNumber(f.photoId))).size;
  d.flags = Array.isArray(d.flags) ? d.flags : [];
  if (session.images.length < 3) {
    d.flags.push(`NOTE: Only ${session.images.length} photo(s) received. Send more close-ups (flashing, vents, edges) for a fuller report.`);
  }
  if ((d.findings || []).length > distinct) {
    d.flags.push('NOTE: Some findings share a photo. More photos would let each finding have its own.');
  }
  return d;
}

function missingInputs(d) {
  const m = [];
  const M = d.meta || {};
  ['homeowner', 'addressLine1', 'addressLine2', 'areaSqFt'].forEach((k) => { if (!M[k]) m.push(`meta.${k}`); });
  if (!(d.findings || []).length) m.push('findings');
  if (M.jobType === 'repair') {
    const r = d.repair || {};
    const items = r.items || [];
    if (!items.length) m.push('repair.items');
    const priced = r.totalPrice != null || (items.length && items.every((x) => x.price != null));
    if (!priced) m.push('repair.price');
  } else {
    if ((d.options || []).length !== 3) m.push('options');
    (d.options || []).forEach((o, i) =>
      ['shingle', 'mfrWarranty', 'laborYears', 'listPrice'].forEach((k) => {
        if (o[k] == null || o[k] === '') m.push(`options[${i}].${k}`);
      })
    );
  }
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
    if (k === 'repair.items') return 'the repair items';
    if (k === 'repair.price') return 'the price for the repairs';
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
    const keys = relevantKeys(session.data);
    const filledFields = keys.filter((k) => session.data[k] !== null && session.data[k] !== 'skipped').length;
    const progressPct = Math.round((filledFields / keys.length) * 100);

    replyText += `\n\n📊 ${progressPct}% | ${filledFields}/${keys.length}`;

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
