const express = require('express');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const publicDir = process.env.PUBLIC_DIR || path.join(__dirname, 'public');
if (!fs.existsSync(publicDir)) fs.mkdirSync(publicDir, { recursive: true });

const TEMPLATE_PATH = path.join(__dirname, 'roof-quote-template.html');
const PROMPT_PATH = path.join(__dirname, 'WHATSAPP_TO_JSON_PROMPT.md');

// Fail loudly at boot if the wrong template or a missing file is deployed.
try {
  const tpl = fs.readFileSync(TEMPLATE_PATH, 'utf8');
  if (!tpl.includes('id="report-data"')) console.error('❌ roof-quote-template.html is the OLD placeholder template. Replace it with the new data-driven template.');
  if (!fs.existsSync(PROMPT_PATH)) console.error('❌ WHATSAPP_TO_JSON_PROMPT.md is missing next to app.js.');
} catch (err) {
  console.error('❌ Could not read roof-quote-template.html:', err.message);
}

const app = express();
app.use(express.json());
app.use('/files', express.static(publicDir)); // file names are random, so links can't be guessed

const port = process.env.PORT || 3000;
const verifyToken = process.env.VERIFY_TOKEN;
const waToken = process.env.WA_TOKEN;
const waPhoneId = process.env.WA_PHONE_ID;
const geminiApiKey = process.env.GEMINI_API_KEY;
const GEMINI_MODEL = process.env.GEMINI_MODEL || 'gemini-3.8-flash';
const COMPANY_NAME = process.env.COMPANY_NAME || '';
const COMPANY_ADDRESS = process.env.COMPANY_ADDRESS || '';
const REP_NAME = process.env.REP_NAME || '';
const PHOTO_WAIT_MS = Number(process.env.PHOTO_WAIT_MS || 6000); // wait for the last photo before replying

// Default look: auto (customer's device), day, dark or blush. The customer can still switch on the page.
const REPORT_THEME = process.env.REPORT_THEME || 'auto';
const THEMES = ['auto', 'day', 'dark', 'blush'];
const THEME_ALIAS = { woman: 'blush', rose: 'blush', pink: 'blush', light: 'day' };
const themeOf = (v) => {
  const raw = String(v || '').toLowerCase().trim();
  const t = THEME_ALIAS[raw] || raw;
  return THEMES.includes(t) ? t : null;
};

// Saved contractor profiles live in DATA_DIR. On Render, point DATA_DIR (and PUBLIC_DIR) at a Persistent Disk,
// otherwise they are wiped on every deploy.
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data');
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
const PROFILE_FILE = path.join(DATA_DIR, 'profiles.json');
let PROFILES = {};
try { PROFILES = JSON.parse(fs.readFileSync(PROFILE_FILE, 'utf8')); } catch (e) { PROFILES = {}; }
const getProfile = (phone) => PROFILES[phone] || null;
function saveProfile(phone, p) {
  PROFILES[phone] = p;
  try { fs.writeFileSync(PROFILE_FILE, JSON.stringify(PROFILES, null, 2)); } catch (e) { console.error('❌ Could not save profile:', e.message); }
}

// =============================================================================
// 1. CONVERSATION TEXT. Edit the words here; buttons are max 20 characters.
// =============================================================================
const TXT = {
  en: {
    hello: (n) => `Hi ${n}! 👋 Send me the roof photos whenever you're ready (one wide shot plus a few close-ups of damage), then tell me who the customer is and the property address.`,
    photoTip: '📸 Send roof photos when you can: a wide shot plus close-ups of damage.',
    gotPhotos: (n) => `📸 Got ${n} photo${n === 1 ? '' : 's'}.`,
    qAddr: "Who's the customer, and what's the property address?",
    qType: 'Is this a full replacement or a repair?',
    qSource: 'Is this a retail or an insurance job?',
    qClaim: "What's the claim number?",
    qArea: 'About how many sq ft is the roof?',
    qPriceRep: "What's the price for the Good, Better and Best? Like: 20k / 25k / 30k (one or two is fine)",
    qPriceRpr: 'What are the repairs and their prices? Like: flashing $300, 12 shingles $650. Or one total.',
    qExtras: 'Anything else? (shingles, warranties, discount, timeline, payment terms) Type it all in one message, or tap below.',
    qChange: 'Sure, what should I change? Just type it.',
    needAddr: 'I need the customer name and address to go on.',
    needPhoto: 'I need at least one roof photo to write the report. Send one when you can 📸',
    needThis: 'I need this one to go on.',
    confirmHead: "Here's what I have:",
    blank: (list) => `Still blank: ${list}. The report will say "to be confirmed".`,
    moreClose: 'Tip: more close-ups (flashing, vents, edges) make a fuller report.',
    building: 'On it, building your report… ⏳',
    ready: (url) => `✅ Your report is ready:\n${url}`,
    notes: 'Notes for you (not in the report):',
    hiccup: 'Sorry, I hit a snag. Please try that again.',
    voice: "I can't listen to voice notes yet. Please type it.",
    editHint: 'Tell me what to change, or tap New quote.',
    replacement: 'Replacement', repair: 'Repair', retail: 'Retail', insurance: 'Insurance',
    lblCustomer: '👤', lblJob: '🏠', lblPrices: '💵', lblDiscount: '🏷️', lblPhotos: '📸',
    photosWord: (n) => `${n} photo${n === 1 ? '' : 's'}`,
    areaWord: 'sq ft', storiesWord: 'story', insuranceWord: 'Insurance',
    tierWords: ['Good', 'Better', 'Best'],
    blankArea: 'roof area', blankPrices: 'prices', blankShingles: 'shingles', blankYears: 'workmanship warranty', blankMfr: 'manufacturer warranty',
    qExtrasProfile: 'Any discount, or anything special for this job? Type it, or tap below.',
    qAdd: 'What should I add? Type it all in one message.',
    heard: (t) => `🎤 "${t}"`,
    voiceFail: "I couldn't make that out. Please try again, or type it.",
    okay: '👍 No problem. Type "setup" any time.',
    offerSetup: '💡 Want me to remember your company and your usual shingles and warranties? It takes a minute.',
    setupIntro: 'Quick setup, so I never ask these again. You can skip any question.',
    sCompany: "What's your company name?",
    sRep: 'What name should show on reports?',
    sShingles: 'What are your usual shingles for Good / Better / Best?',
    sYears: 'Usual workmanship warranty in years? Like: 10 / 15 / 25',
    sMfr: 'Manufacturer warranty for each? Like: limited lifetime / 50-year / limited lifetime',
    sPay: 'How do you usually get paid?',
    sTheme: 'Which look do you like for your reports?',
    setupDone: '✅ Saved! I will use these on every quote. Type "setup" any time to change them.',
    btn: { add: 'Add details', payStandard: 'Deposit + stages', payPoc: 'On completion', themeAuto: 'Auto', themeDark: 'Dark', themeBlush: 'Blush', setupNow: 'Set up now', notNow: 'Not now', replacement: 'Replacement', repair: 'Repair', retail: 'Retail', insurance: 'Insurance', skip: 'Skip', nothing: 'Nothing else', build: 'Build report', change: 'Change something', newq: 'New quote', edit: 'Make a change' }
  },
  es: {
    hello: (n) => `¡Hola ${n}! 👋 Envíame las fotos del techo cuando quieras (una general y algunas de cerca de los daños), y luego dime quién es el cliente y la dirección.`,
    photoTip: '📸 Envía fotos del techo cuando puedas: una general y otras de cerca de los daños.',
    gotPhotos: (n) => `📸 Recibí ${n} foto${n === 1 ? '' : 's'}.`,
    qAddr: '¿Quién es el cliente y cuál es la dirección de la propiedad?',
    qType: '¿Es un reemplazo completo o una reparación?',
    qSource: '¿Es un trabajo particular o de seguro?',
    qClaim: '¿Cuál es el número de reclamo?',
    qArea: '¿Cuántos pies cuadrados tiene el techo, más o menos?',
    qPriceRep: '¿Cuál es el precio para Bueno, Mejor y Óptimo? Ej.: 20k / 25k / 30k (con uno o dos basta)',
    qPriceRpr: '¿Qué reparaciones harás y cuánto cuesta cada una? Ej.: flashing $300, 12 tejas $650. O un total.',
    qExtras: '¿Algo más? (tejas, garantías, descuento, plazo, forma de pago) Escríbelo todo en un mensaje, o toca abajo.',
    qChange: 'Claro, ¿qué cambio? Escríbelo.',
    needAddr: 'Necesito el nombre y la dirección del cliente para seguir.',
    needPhoto: 'Necesito al menos una foto del techo para escribir el informe. Envía una cuando puedas 📸',
    needThis: 'Necesito este dato para seguir.',
    confirmHead: 'Esto es lo que tengo:',
    blank: (list) => `Falta: ${list}. El informe dirá "por confirmar".`,
    moreClose: 'Consejo: más fotos de cerca (flashing, ventilas, bordes) hacen un informe más completo.',
    building: 'Listo, preparando tu informe… ⏳',
    ready: (url) => `✅ Tu informe está listo:\n${url}`,
    notes: 'Notas para ti (no salen en el informe):',
    hiccup: 'Perdón, tuve un problema. Inténtalo de nuevo.',
    voice: 'Todavía no puedo escuchar notas de voz. Escríbelo, por favor.',
    editHint: 'Dime qué cambiar, o toca Nueva cotización.',
    replacement: 'Reemplazo', repair: 'Reparación', retail: 'Particular', insurance: 'Seguro',
    lblCustomer: '👤', lblJob: '🏠', lblPrices: '💵', lblDiscount: '🏷️', lblPhotos: '📸',
    photosWord: (n) => `${n} foto${n === 1 ? '' : 's'}`,
    areaWord: 'pies²', storiesWord: 'piso', insuranceWord: 'Seguro',
    tierWords: ['Bueno', 'Mejor', 'Óptimo'],
    blankArea: 'área del techo', blankPrices: 'precios', blankShingles: 'tejas', blankYears: 'garantía de mano de obra', blankMfr: 'garantía del fabricante',
    qExtrasProfile: '¿Algún descuento o algo especial para este trabajo? Escríbelo, o toca abajo.',
    qAdd: '¿Qué debo agregar? Escríbelo todo en un mensaje.',
    heard: (t) => `🎤 "${t}"`,
    voiceFail: 'No pude entenderlo. Inténtalo de nuevo, o escríbelo.',
    okay: '👍 Sin problema. Escribe "setup" cuando quieras.',
    offerSetup: '💡 ¿Quieres que recuerde tu empresa y tus tejas y garantías habituales? Toma un minuto.',
    setupIntro: 'Configuración rápida, para no volver a preguntarte esto. Puedes omitir cualquier pregunta.',
    sCompany: '¿Cómo se llama tu empresa?',
    sRep: '¿Qué nombre debe aparecer en los informes?',
    sShingles: '¿Cuáles son tus tejas habituales para Bueno / Mejor / Óptimo?',
    sYears: '¿Garantía habitual de mano de obra en años? Ej.: 10 / 15 / 25',
    sMfr: '¿Garantía del fabricante de cada una? Ej.: de por vida limitada / 50 años / de por vida limitada',
    sPay: '¿Cómo sueles cobrar?',
    sTheme: '¿Qué estilo prefieres para tus informes?',
    setupDone: '✅ ¡Guardado! Lo usaré en cada cotización. Escribe "setup" cuando quieras cambiarlo.',
    btn: { add: 'Agregar datos', payStandard: 'Depósito + etapas', payPoc: 'Al terminar', themeAuto: 'Auto', themeDark: 'Oscuro', themeBlush: 'Rosado', setupNow: 'Configurar ahora', notNow: 'Ahora no', replacement: 'Reemplazo', repair: 'Reparación', retail: 'Particular', insurance: 'Seguro', skip: 'Omitir', nothing: 'Nada más', build: 'Crear informe', change: 'Cambiar algo', newq: 'Nueva cotización', edit: 'Hacer un cambio' }
  }
};
const tx = (s, key, ...args) => {
  const v = (TXT[s.lang] || TXT.en)[key];
  return typeof v === 'function' ? v(...args) : v;
};
const btn = (s, key) => (TXT[s.lang] || TXT.en).btn[key];
const firstName = (n) => String(n || 'there').split(' ')[0];

// =============================================================================
// 2. WHATSAPP SENDING (text and tap buttons)
// =============================================================================
const GRAPH = () => `https://graph.facebook.com/v26.0/${waPhoneId}/messages`;

async function waPost(body, label) {
  try {
    const res = await fetch(GRAPH(), {
      method: 'POST',
      headers: { Authorization: `Bearer ${waToken}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ messaging_product: 'whatsapp', recipient_type: 'individual', ...body })
    });
    const result = await res.json();
    if (result.error) {
      console.error(`❌ Meta API Error (${label}):`, JSON.stringify(result.error));
      return false;
    }
    return true;
  } catch (err) {
    console.error(`❌ WhatsApp ${label} error:`, err);
    return false;
  }
}

const sendText = (to, text) => waPost({ to, type: 'text', text: { body: text } }, 'text');

// Up to 3 tap buttons. If WhatsApp refuses buttons, fall back to plain text with the options listed.
async function sendButtons(to, text, buttons) {
  const ok = await waPost({
    to,
    type: 'interactive',
    interactive: {
      type: 'button',
      body: { text: text.slice(0, 1024) },
      action: { buttons: buttons.slice(0, 3).map((b) => ({ type: 'reply', reply: { id: b.id, title: b.title.slice(0, 20) } })) }
    }
  }, 'buttons');
  if (!ok) await sendText(to, `${text}\n\n${buttons.map((b) => `• ${b.title}`).join('\n')}`);
}

const sendDocument = (to, fileUrl, fileName, caption) =>
  waPost({ to, type: 'document', document: { link: fileUrl, filename: fileName, caption } }, 'document');

async function downloadWhatsAppImage(mediaId) {
  try {
    const res = await fetch(`https://graph.facebook.com/v26.0/${mediaId}`, { headers: { Authorization: `Bearer ${waToken}` } });
    const data = await res.json();
    if (!data.url) throw new Error('No media URL returned by Meta');
    const imgRes = await fetch(data.url, { headers: { Authorization: `Bearer ${waToken}` } });
    const buffer = await imgRes.arrayBuffer();
    const fileName = `img_${mediaId}.jpg`;
    fs.writeFileSync(path.join(publicDir, fileName), Buffer.from(buffer));
    return fileName;
  } catch (err) {
    console.error('❌ Media download error:', err);
    return null;
  }
}

// =============================================================================
// 3. GEMINI: only used to READ what the contractor typed (and to write the findings)
// =============================================================================
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
    if (data.error && data.error.code === 503) await sleep(2000);
    else break;
  }
  if (data && data.error) console.error('❌ Gemini error:', JSON.stringify(data.error));
  return data;
}
const parseJsonText = (raw) => JSON.parse(raw.replace(/```json/g, '').replace(/```/g, '').trim());
const geminiText = (data) => data?.candidates?.[0]?.content?.parts?.[0]?.text;

const EXTRACT_PROMPT = `
You read ONE short WhatsApp message from a roofing contractor and extract job details from it. Return ONLY valid JSON:
{"updates": { ... }, "intent": "answer" | "skip" | "build" | "new_quote", "language": "en" | "es"}

RULES:
- Put into "updates" ONLY what the message actually states. Never guess, never invent, never fill in typical values.
- Translate every text value into professional English. "language" is the language the contractor wrote in.
- "awaiting" tells you which question the contractor is answering. A bare answer belongs to that question.
- intent "skip": they decline or don't know ("skip", "no", "none", "I don't know", "n/a") with nothing else useful. intent "build": they ask to generate/send/finish ("generate", "that's all, build it"). intent "new_quote": they want to start a different job. Otherwise "answer".

FIELDS (all optional):
customer_name_and_address: string, name plus address exactly as given
job_type: "replacement" (full roof replacement / tear-off) or "repair"
lead_source: "retail" or "insurance"; claim_number: string
roof_area_sqft: number (1 roofing "square" = 100 sq ft)
building_stories, current_roof_and_condition, site_notes: strings
pitch: string like "6/12" only if stated
tiers: {"good":{"shingle","price","labor_years","mfr_warranty"},"better":{...},"best":{...}}
  price = number ("15k" = 15000); labor_years = number; shingle = brand and product line exactly as written; mfr_warranty = e.g. "limited lifetime" or "50-year".
  Good/Better/Best = 1st/2nd/3rd in the order given. One price with no tier named goes in "good"; two unnamed prices go in "good" and "better". If one value is given for all tiers or "respectively", put the right value in each tier.
  When "awaiting" starts with "setup_", the contractor is describing their USUAL shingles and warranties: use the same tiers fields.
repair: {"items":[{"name","price"}], "total_price": number, "labor_years": number}
discount: {"pct": number, "name": string} or "none"
payment: {"mode":"standard"|"on_completion"|"deposit_balance","deposit":number,"deposit_pct":number}. "POC", "pay when done", "no deposit" = on_completion.
timeline_days: number (upper bound in days; "3 weeks" = 21); wood_pct: number (damaged wood allowance)
report_theme: "day" | "dark" | "blush"
extra_notes: anything relevant that fits nowhere else
`;

const toNum = (v) => {
  if (v == null || v === '') return null;
  if (typeof v === 'number') return Number.isFinite(v) ? v : null;
  let str = String(v).toLowerCase().replace(/[$,\s]/g, '');
  let mult = 1;
  if (str.endsWith('k')) { mult = 1000; str = str.slice(0, -1); }
  const n = Number(str);
  return Number.isFinite(n) ? n * mult : null;
};

function cleanUpdates(u) {
  if (!u || typeof u !== 'object') return {};
  const out = JSON.parse(JSON.stringify(u));
  ['roof_area_sqft', 'timeline_days', 'wood_pct'].forEach((k) => { if (k in out) out[k] = toNum(out[k]); });
  if (out.tiers) {
    ['good', 'better', 'best'].forEach((k) => {
      const t = out.tiers[k];
      if (!t || typeof t !== 'object') { delete out.tiers[k]; return; }
      t.price = toNum(t.price); t.labor_years = toNum(t.labor_years);
    });
  }
  if (out.repair) {
    out.repair.total_price = toNum(out.repair.total_price);
    out.repair.labor_years = toNum(out.repair.labor_years);
    if (Array.isArray(out.repair.items)) out.repair.items = out.repair.items.map((i) => ({ name: String(i.name || '').trim(), price: toNum(i.price) })).filter((i) => i.name);
    if (!out.repair.items || !out.repair.items.length) delete out.repair.items;
  }
  if (out.discount && typeof out.discount === 'object') {
    out.discount.pct = toNum(out.discount.pct);
    if (out.discount.pct == null) delete out.discount;
  }
  if (out.payment) { out.payment.deposit = toNum(out.payment.deposit); out.payment.deposit_pct = toNum(out.payment.deposit_pct); }
  if (out.job_type) out.job_type = /repair/i.test(out.job_type) && !/replac/i.test(out.job_type) ? 'repair' : 'replacement';
  if (out.lead_source) out.lead_source = /insur/i.test(out.lead_source) ? 'insurance' : 'retail';
  if (out.report_theme) out.report_theme = themeOf(out.report_theme) || undefined;
  return out;
}

// Copies non-empty values into the job data. Returns true if anything changed.
function merge(target, src) {
  let changed = false;
  for (const k of Object.keys(src || {})) {
    const v = src[k];
    if (v == null || v === '' || v === undefined) continue;
    if (v && typeof v === 'object' && !Array.isArray(v) && target[k] && typeof target[k] === 'object' && !Array.isArray(target[k])) {
      if (merge(target[k], v)) changed = true;
    } else if (JSON.stringify(target[k]) !== JSON.stringify(v)) {
      target[k] = v;
      changed = true;
    }
  }
  return changed;
}

async function extract(s, text) {
  const filled = JSON.parse(JSON.stringify(s.data));
  const data = await callGemini({
    system: EXTRACT_PROMPT,
    parts: [{ text: JSON.stringify({ awaiting: s.awaiting, already_known: filled, message: text }) }]
  });
  const raw = geminiText(data);
  if (!raw) throw new Error('Extraction returned nothing');
  const parsed = parseJsonText(raw);
  return { updates: cleanUpdates(parsed.updates), intent: parsed.intent || 'answer', language: parsed.language };
}

// =============================================================================
// 4. JOB DATA AND SESSIONS
// =============================================================================
function freshData(profile) {
  const d = {
    customer_name_and_address: null, job_type: null, lead_source: null, claim_number: null,
    roof_area_sqft: null, building_stories: null, current_roof_and_condition: null, site_notes: null, pitch: null,
    tiers: { good: {}, better: {}, best: {} },
    repair: { items: null, total_price: null, labor_years: null },
    discount: null,
    payment: { mode: null, deposit: null, deposit_pct: null },
    timeline_days: null, wood_pct: null, report_theme: null, extra_notes: null
  };
  if (profile) {
    ['good', 'better', 'best'].forEach((k) => {
      const t = (profile.tiers || {})[k] || {};
      if (t.shingle) d.tiers[k].shingle = t.shingle;
      if (t.labor_years != null) d.tiers[k].labor_years = t.labor_years;
      if (t.mfr_warranty) d.tiers[k].mfr_warranty = t.mfr_warranty;
    });
    if (profile.payment && profile.payment.mode) d.payment = { ...d.payment, ...profile.payment };
    if (profile.timeline_days != null) d.timeline_days = profile.timeline_days;
    if (profile.wood_pct != null) d.wood_pct = profile.wood_pct;
    if (profile.theme) d.report_theme = profile.theme;
  }
  return d;
}

const userSessions = new Map();
function getSession(phone, name) {
  if (!userSessions.has(phone)) userSessions.set(phone, newSession(name, 'en', getProfile(phone)));
  return userSessions.get(phone);
}
function newSession(name, lang, profile) {
  return {
    contractorName: name, lang: lang || 'en', stage: 'new', // new | collect | confirm | changing | setup | building | done
    profile: profile || null, data: freshData(profile), images: [], skipped: new Set(), tries: {}, awaiting: null, extrasDone: false, photoTipSent: false,
    report: null, photoTimer: null, quoteNumber: `Q-${Math.floor(100000 + Math.random() * 900000)}`, queue: Promise.resolve()
  };
}

const isRepair = (s) => s.data.job_type === 'repair';
const tierPrices = (s) => ['good', 'better', 'best'].map((k) => s.data.tiers[k].price);
const pricesComplete = (s) => (isRepair(s)
  ? Boolean((s.data.repair.items && s.data.repair.items.length) || s.data.repair.total_price != null)
  : tierPrices(s).some((p) => p != null));
const activeTierKeys = (s) => {
  const keys = ['good', 'better', 'best'].filter((k) => s.data.tiers[k].price != null);
  return keys.length ? keys : ['good'];
};

// =============================================================================
// 5. THE QUESTIONS, IN ORDER
// =============================================================================
function nextQuestion(s) {
  const d = s.data;
  if (!d.customer_name_and_address) return 'addr';
  if (!d.job_type) return 'type';
  if (!d.lead_source && !s.skipped.has('source')) return 'source';
  if (d.lead_source === 'insurance' && !d.claim_number && !s.skipped.has('claim')) return 'claim';
  if (!d.roof_area_sqft && !s.skipped.has('area')) return 'area';
  if (!pricesComplete(s) && !s.skipped.has('price')) return 'price';
  if (!s.extrasDone) return 'extras';
  return 'confirm';
}

const money = (n) => '$' + Number(n).toLocaleString('en-US');

function blanks(s) {
  const d = s.data; const out = [];
  if (!d.roof_area_sqft) out.push(tx(s, 'blankArea'));
  if (!pricesComplete(s)) out.push(tx(s, 'blankPrices'));
  if (!isRepair(s)) {
    const ts = ['good', 'better', 'best'].map((k) => d.tiers[k]).filter((t) => t.price != null);
    if (ts.some((t) => !t.shingle)) out.push(tx(s, 'blankShingles'));
    if (ts.some((t) => t.labor_years == null)) out.push(tx(s, 'blankYears'));
    if (ts.some((t) => !t.mfr_warranty)) out.push(tx(s, 'blankMfr'));
  }
  return out;
}

function summary(s) {
  const d = s.data; const lines = [tx(s, 'confirmHead'), `${tx(s, 'lblCustomer')} ${d.customer_name_and_address}`];
  const job = [isRepair(s) ? tx(s, 'repair') : tx(s, 'replacement')];
  if (d.lead_source === 'insurance') job.push(tx(s, 'insuranceWord') + (d.claim_number ? ` ${d.claim_number}` : ''));
  if (d.roof_area_sqft) job.push(`${Number(d.roof_area_sqft).toLocaleString('en-US')} ${tx(s, 'areaWord')}`);
  if (d.building_stories) job.push(d.building_stories);
  lines.push(`${tx(s, 'lblJob')} ${job.join(' · ')}`);
  if (isRepair(s)) {
    const r = d.repair;
    if (r.items && r.items.length) lines.push(`${tx(s, 'lblPrices')} ` + r.items.map((i) => `${i.name}${i.price != null ? ' ' + money(i.price) : ''}`).join(' · '));
    if (r.total_price != null) lines.push(`${tx(s, 'lblPrices')} Total ${money(r.total_price)}`);
  } else if (tierPrices(s).some((p) => p != null)) {
    lines.push(`${tx(s, 'lblPrices')} ` + tx(s, 'tierWords').map((w, i) => (tierPrices(s)[i] != null ? `${w} ${money(tierPrices(s)[i])}` : null)).filter(Boolean).join(' · '));
  }
  if (d.discount && d.discount !== 'none') lines.push(`${tx(s, 'lblDiscount')} ${d.discount.pct}% ${d.discount.name || ''}`.trim());
  lines.push(`${tx(s, 'lblPhotos')} ${tx(s, 'photosWord', s.images.length)}`);
  const b = blanks(s);
  if (b.length) lines.push('', tx(s, 'blank', b.join(', ')));
  if (s.images.length > 0 && s.images.length < 3) lines.push('', tx(s, 'moreClose'));
  return lines.join('\n');
}

// Sends the next question (or the summary). Everything the contractor already told us is skipped.
async function advance(s, to) {
  const q = nextQuestion(s);
  s.awaiting = q;
  const tip = !s.photoTipSent && s.images.length === 0 ? `\n\n${tx(s, 'photoTip')}` : '';
  if (tip) s.photoTipSent = true;
  const skipBtn = { id: 'skip', title: btn(s, 'skip') };

  switch (q) {
    case 'addr': return sendText(to, tx(s, 'qAddr') + tip);
    case 'type': return sendButtons(to, tx(s, 'qType') + tip, [{ id: 'type:replacement', title: btn(s, 'replacement') }, { id: 'type:repair', title: btn(s, 'repair') }]);
    case 'source': return sendButtons(to, tx(s, 'qSource'), [{ id: 'src:retail', title: btn(s, 'retail') }, { id: 'src:insurance', title: btn(s, 'insurance') }]);
    case 'claim': return sendButtons(to, tx(s, 'qClaim'), [skipBtn]);
    case 'area': return sendButtons(to, tx(s, 'qArea') + tip, [skipBtn]);
    case 'price':
      return sendButtons(to, isRepair(s) ? tx(s, 'qPriceRpr') : tx(s, 'qPriceRep'), [skipBtn]);
    case 'extras': {
      const known = s.profile && s.profile.tiers && s.profile.tiers.good && s.profile.tiers.good.shingle;
      return sendButtons(to, tx(s, known ? 'qExtrasProfile' : 'qExtras'), [{ id: 'extras:none', title: btn(s, 'nothing') }]);
    }
    default: return showConfirm(s, to);
  }
}

async function showConfirm(s, to) {
  if (s.images.length === 0) {
    s.awaiting = 'photo';
    return sendText(to, tx(s, 'needPhoto'));
  }
  s.stage = 'confirm';
  s.awaiting = 'confirm';
  const confirmBtns = [{ id: 'build', title: btn(s, 'build') }];
  if (blanks(s).length) confirmBtns.push({ id: 'add', title: btn(s, 'add') });
  confirmBtns.push({ id: 'change', title: btn(s, 'change') });
  return sendButtons(to, summary(s), confirmBtns);
}

// =============================================================================
// 6. BUILDING THE REPORT
// =============================================================================
function getBuilderPrompt() {
  const md = fs.readFileSync(PROMPT_PATH, 'utf8');
  return (
    'The input below is a structured intake summary from the contractor (JSON), plus the roof photos. ' +
    'Treat it as the conversation described in the rules. The app sets prices, options, discount, payment terms and job type itself from the intake, ' +
    'so your job is the wording: names, address, condition, findings, themes, priorities, captions and the cover photo.\n\n' +
    md.split('## PROMPT')[1].trim()
  );
}

const photoNumber = (id) => String(id == null ? '' : id).replace(/\D/g, '');
const MAKERS = ['Owens Corning', 'CertainTeed', 'GAF', 'Atlas', 'IKO', 'Malarkey', 'Tamko', 'DaVinci', 'Boral'];
const makerOf = (shingle) => MAKERS.find((m) => String(shingle || '').toLowerCase().startsWith(m.toLowerCase())) || '';
const mfrShort = (w) => (/lifetime/i.test(w) ? 'Lifetime' : (String(w).match(/(\d+)/) ? `${String(w).match(/(\d+)/)[1]} yrs` : String(w)));

async function buildReportData(s) {
  const intake = { ...s.data, photos: s.images.map((i) => ({ id: i.id, caption: i.caption || '' })) };
  const parts = [{ text: 'INTAKE DATA (from the contractor):\n' + JSON.stringify(intake, null, 2) }];
  if (s.report) {
    parts.push({ text: 'PREVIOUS REPORT JSON (already sent to the customer). Keep findings, photo choices and wording exactly as they are. Change ONLY what the intake data now says differently:\n' + JSON.stringify(s.report) });
  }
  for (const img of s.images) {
    parts.push({ text: `Photo ID: ${img.id}${img.caption ? ` | Contractor caption: ${img.caption}` : ''}` });
    parts.push({ inline_data: { mime_type: 'image/jpeg', data: fs.readFileSync(path.join(publicDir, img.file)).toString('base64') } });
  }
  parts.push({ text: 'Return only the JSON.' });
  const data = await callGemini({ system: getBuilderPrompt(), parts, temperature: 0.2 });
  const raw = geminiText(data);
  if (!raw) throw new Error('Report builder returned nothing');
  return parseJsonText(raw);
}

// The app (not the model) sets every price, warranty, discount and term, straight from what the contractor said.
function applyIntake(d, s) {
  const D = s.data;
  d.meta = d.meta || {};
  const P = s.profile || {};
  d.meta.company = P.company || COMPANY_NAME || s.contractorName;
  d.meta.companyAddress = P.companyAddress || COMPANY_ADDRESS;
  d.meta.rep = P.rep || REP_NAME;
  d.meta.date = new Date().toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric' });
  d.meta.dateLabel = d.meta.dateLabel || 'Report date';
  d.meta.theme = themeOf(D.report_theme) || themeOf(REPORT_THEME) || 'auto';
  d.meta.jobType = isRepair(s) ? 'repair' : 'replacement';
  d.meta.product = isRepair(s) ? 'Roof repair' : 'Shingle roof replacement';
  d.meta.areaSqFt = D.roof_area_sqft || '';
  d.meta.pitch = D.pitch || null;
  d.meta.leadSource = D.lead_source || 'retail';
  d.meta.claimNumber = D.lead_source === 'insurance' ? D.claim_number || '' : '';
  d.discount = D.discount && D.discount !== 'none' ? { pct: D.discount.pct, name: String(D.discount.name || '').toLowerCase() } : null;
  d.terms = {
    paymentMode: D.payment.mode || (isRepair(s) ? 'on_completion' : 'standard'),
    deposit: D.payment.deposit != null ? D.payment.deposit : 1000,
    depositPct: D.payment.deposit_pct != null ? D.payment.deposit_pct : null,
    validityDays: 30,
    timelineDays: D.timeline_days != null ? D.timeline_days : (isRepair(s) ? null : 7),
    woodPct: D.wood_pct != null ? D.wood_pct : 20
  };
  if (isRepair(s)) {
    const src = D.repair.items || [];
    const fromModel = (d.repair && d.repair.items) || [];
    d.repair = {
      items: src.map((it, i) => ({ name: it.name, detail: '', refs: (fromModel.length === src.length && fromModel[i] && fromModel[i].refs) || '', price: it.price })),
      totalPrice: D.repair.total_price, laborYears: D.repair.labor_years
    };
    d.options = [];
    delete d.scopeRefs;
  } else {
    d.options = activeTierKeys(s).map((k) => {
      const t = D.tiers[k];
      return {
        name: k.charAt(0).toUpperCase() + k.slice(1),
        shingle: t.shingle || null, listPrice: t.price != null ? t.price : null, laborYears: t.labor_years != null ? t.labor_years : null,
        mfrWarranty: t.mfr_warranty ? `${makerOf(t.shingle) ? makerOf(t.shingle) + ' ' : ''}${String(t.mfr_warranty).toLowerCase().replace(/ ?manufacturer warranty| ?warranty/g, '')} manufacturer warranty` : null,
        mfrShort: t.mfr_warranty ? mfrShort(t.mfr_warranty) : null
      };
    });
    delete d.repair;
  }
  return d;
}

function embedPhotos(d, s) {
  const srcById = {};
  for (const img of s.images) {
    try { srcById[photoNumber(img.id)] = `data:image/jpeg;base64,${fs.readFileSync(path.join(publicDir, img.file)).toString('base64')}`; }
    catch (err) { console.error('❌ Could not read photo', img.file, err.message); }
  }
  (d.findings || []).forEach((f) => { f.photoSrc = srcById[photoNumber(f.photoId)] || ''; });
  if (d.readingSet && d.readingSet.photoId) d.readingSet.photoSrc = srcById[photoNumber(d.readingSet.photoId)] || '';
  const used = new Set([...(d.findings || []).map((f) => photoNumber(f.photoId)), d.readingSet && photoNumber(d.readingSet.photoId)].filter(Boolean));
  const coverId = photoNumber(d.meta.coverPhotoId);
  delete d.meta.coverPhotoSrc;
  if (coverId && srcById[coverId]) { if (!used.has(coverId)) d.meta.coverPhotoSrc = srcById[coverId]; }
  else delete d.meta.coverPhotoId;
  d.flags = Array.isArray(d.flags) ? d.flags : [];
  const distinct = new Set((d.findings || []).map((f) => photoNumber(f.photoId))).size;
  if ((d.findings || []).length > distinct) d.flags.push('NOTE: Some findings share a photo. More photos would let each finding have its own.');
  return d;
}

function renderQuoteHtml(d) {
  const tpl = fs.readFileSync(TEMPLATE_PATH, 'utf8');
  const re = /(<script id="report-data" type="application\/json">)[\s\S]*?(<\/script>)/;
  if (!re.test(tpl)) throw new Error('Template has no report-data block (old template deployed?)');
  return tpl.replace(re, (_, a, b) => a + JSON.stringify(d).replace(/<\//g, '<\\/') + b);
}

async function doBuild(s, to, host) {
  if (!s.data.customer_name_and_address) { s.awaiting = 'addr'; return sendText(to, tx(s, 'needAddr')); }
  if (s.images.length === 0) { s.awaiting = 'photo'; return sendText(to, tx(s, 'needPhoto')); }
  s.stage = 'building';
  await sendText(to, tx(s, 'building'));
  try {
    const d = embedPhotos(applyIntake(await buildReportData(s), s), s);
    if (!(d.findings || []).length) throw new Error('No findings written');
    const b = blanks(s);
    if (b.length) d.flags.push(`DRAFT: still blank: ${b.join(', ')}.`);
    s.report = JSON.parse(JSON.stringify(d, (k, v) => (k === 'photoSrc' || k === 'coverPhotoSrc' ? undefined : v)));
    const fileName = `Roof_Quote_${crypto.randomBytes(8).toString('hex')}.html`;
    fs.writeFileSync(path.join(publicDir, fileName), renderQuoteHtml(d), 'utf8');
    const url = `https://${host}/files/${fileName}`;
    s.stage = 'done'; s.awaiting = null;
    await sendButtons(to, tx(s, 'ready', url), [{ id: 'change', title: btn(s, 'edit') }, { id: 'newquote', title: btn(s, 'newq') }]);
    await sendDocument(to, url, fileName, `Estimate Proposal ${s.quoteNumber}`);
    if (d.flags.length) await sendText(to, `${tx(s, 'notes')}\n- ${d.flags.join('\n- ')}`);
    const pr = getProfile(to);
    if (!pr || !pr.offered) {
      saveProfile(to, { ...(pr || {}), offered: true });
      await sendButtons(to, tx(s, 'offerSetup'), [{ id: 'setup', title: btn(s, 'setupNow') }, { id: 'setup:later', title: btn(s, 'notNow') }]);
    }
  } catch (err) {
    console.error('❌ Report build error:', err);
    s.stage = 'confirm';
    await sendText(to, tx(s, 'hiccup'));
  }
}

// =============================================================================
// 7. HANDLING WHAT THE CONTRACTOR SENDS
// =============================================================================
const SKIP_RE = /^(skip|omitir|saltar|no|none|nothing|nope|n\/a|nada|ninguno|no sé|no se|i don'?t know|idk|dont know)\.?$/i;
const BUILD_RE = /^(generate|build|done|send it|create|genera|generar|listo|crear)( it| report| quote)?\.?$/i;
const NEW_RE = /^(new quote|new|start over|reset|nueva cotizaci[oó]n|nueva|empezar de nuevo)\.?$/i;
const SETUP_RE = /^(setup|set up|settings|profile|my settings|configurar|ajustes|perfil)$/i;
const GREET_RE = /^(hi|hello|hey|hola|start|empezar|buenas|buenos d[ií]as)\b[\s!.,]*$/i;

async function startOver(s, to, phone) {
  const fresh = newSession(s.contractorName, s.lang, getProfile(phone));
  fresh.stage = 'collect';
  fresh.queue = s.queue;
  userSessions.set(phone, fresh);
  await sendText(to, tx(fresh, 'hello', firstName(fresh.contractorName)));
}

async function skipCurrent(s, to) {
  switch (s.awaiting) {
    case 'source': s.data.lead_source = 'retail'; break;
    case 'extras': s.extrasDone = true; break;
    case 'claim': case 'area': case 'price': s.skipped.add(s.awaiting); break;
    case 'addr': case 'type': return sendText(to, tx(s, 'needThis'));
    default: break;
  }
  return advance(s, to);
}

async function onButton(s, to, id, host, phone) {
  if (id === 'setup') return startSetup(s, to);
  if (id === 'setup:later') return sendText(to, tx(s, 'okay'));
  if (s.stage === 'setup') return setupButton(s, to, id);
  if (id === 'add') { s.stage = 'changing'; s.awaiting = 'change'; return sendText(to, tx(s, 'qAdd')); }
  if (id === 'newquote') return startOver(s, to, phone);
  if (id === 'build') return doBuild(s, to, host);
  if (id === 'change') { s.stage = 'changing'; s.awaiting = 'change'; return sendText(to, tx(s, 'qChange')); }
  if (id === 'skip') return skipCurrent(s, to);
  if (id === 'extras:none') { s.extrasDone = true; return advance(s, to); }
  if (id === 'type:replacement' || id === 'type:repair') s.data.job_type = id.split(':')[1];
  if (id === 'src:retail' || id === 'src:insurance') s.data.lead_source = id.split(':')[1];
  if (s.stage === 'done') return null;
  return advance(s, to);
}

async function onText(s, to, text, host, phone) {
  if (s.stage === 'building') return; // a report is being written; ignore chatter until it is sent
  const low = text.trim().toLowerCase();

  if (NEW_RE.test(low)) return startOver(s, to, phone);
  if (SETUP_RE.test(low)) return startSetup(s, to);
  if (s.stage === 'setup') return setupText(s, to, text);
  if (s.stage === 'new') {
    s.stage = 'collect';
    if (GREET_RE.test(low)) { await sendText(to, tx(s, 'hello', firstName(s.contractorName))); return; }
  }
  if (s.stage === 'collect' && SKIP_RE.test(low)) return skipCurrent(s, to);
  if (s.stage === 'collect' && BUILD_RE.test(low)) return showConfirm(s, to);
  if (s.stage === 'confirm' && BUILD_RE.test(low)) return doBuild(s, to, host);

  // Quick path for a bare number when we asked for the area (no AI call needed)
  if (s.awaiting === 'area' && /^[\d,.\s]+(sq\s?ft|sf|ft2|pies)?$/i.test(low)) {
    const n = toNum(low.replace(/(sq\s?ft|sf|ft2|pies)/i, ''));
    if (n) { s.data.roof_area_sqft = n; return advance(s, to); }
  }

  // A plain typed answer to a single simple question counts even if the AI reader misses it
  if (s.awaiting === 'claim' && text.trim().length <= 40 && !SKIP_RE.test(low)) { s.data.claim_number = text.trim(); return advance(s, to); }

  const ex = await extract(s, text);
  if (ex.language === 'es' || ex.language === 'en') { if (text.trim().split(/\s+/).length >= 2) s.lang = ex.language; }
  if (ex.intent === 'new_quote') return startOver(s, to, phone);
  const changed = merge(s.data, ex.updates);
  if (s.awaiting === 'addr' && !s.data.customer_name_and_address && text.trim().length >= 6) s.data.customer_name_and_address = text.trim();

  if (s.stage === 'done') {
    if (!changed) return sendText(to, tx(s, 'editHint'));
    return doBuild(s, to, host); // rebuild with the change; the findings stay the same
  }
  if (s.stage === 'confirm' || s.stage === 'changing') {
    s.stage = 'confirm';
    return showConfirm(s, to);
  }

  if (ex.intent === 'skip' && !changed) return skipCurrent(s, to);
  if (ex.intent === 'build' && !changed) return showConfirm(s, to);

  if (s.awaiting === 'extras') s.extrasDone = true;
  if (s.awaiting === 'price') {
    s.tries.price = (s.tries.price || 0) + 1;
    if (!pricesComplete(s) && s.tries.price >= 3) s.skipped.add('price');
  }
  return advance(s, to);
}

async function onImage(s, to, message) {
  const file = await downloadWhatsAppImage(message.image.id);
  if (!file) return sendText(to, tx(s, 'hiccup'));
  s.images.push({ id: String(s.images.length + 1), file, caption: message.image.caption || '' });
  if (s.stage === 'new') s.stage = 'collect';
  if (s.photoTimer) clearTimeout(s.photoTimer);
  // One reply for a whole batch of photos, sent a few seconds after the last one
  s.photoTimer = setTimeout(() => {
    s.photoTimer = null;
    s.queue = s.queue.then(() => photosSettled(s, to)).catch((e) => console.error('❌ photo reply error:', e));
  }, PHOTO_WAIT_MS);
}

async function photosSettled(s, to) {
  if (s.stage === 'building') return;
  const ack = tx(s, 'gotPhotos', s.images.length);
  if (s.stage === 'done') { s.report = null; return doBuild(s, to, s.host); } // new photos: rewrite the findings
  if (s.awaiting && s.awaiting !== 'photo' && s.awaiting !== 'confirm') return sendText(to, ack);
  if (s.awaiting === 'confirm') return sendText(to, ack);
  await sendText(to, ack);
  return advance(s, to);
}

// ----- One-time setup: company, usual shingles and warranties, how you get paid, look of the reports -----
const SETUP_ORDER = ['setup_company', 'setup_rep', 'setup_shingles', 'setup_years', 'setup_mfr', 'setup_pay', 'setup_theme'];

async function startSetup(s, to) {
  s.prevStage = s.stage === 'setup' ? s.prevStage : s.stage;
  s.stage = 'setup';
  s.draft = JSON.parse(JSON.stringify(s.profile || {}));
  s.draft.tiers = s.draft.tiers || { good: {}, better: {}, best: {} };
  s.awaiting = SETUP_ORDER[0];
  await sendText(to, tx(s, 'setupIntro'));
  return askSetup(s, to);
}

function askSetup(s, to) {
  const skip = { id: 'skip', title: btn(s, 'skip') };
  switch (s.awaiting) {
    case 'setup_company': return sendButtons(to, tx(s, 'sCompany'), [skip]);
    case 'setup_rep': return sendButtons(to, tx(s, 'sRep'), [skip]);
    case 'setup_shingles': return sendButtons(to, tx(s, 'sShingles'), [skip]);
    case 'setup_years': return sendButtons(to, tx(s, 'sYears'), [skip]);
    case 'setup_mfr': return sendButtons(to, tx(s, 'sMfr'), [skip]);
    case 'setup_pay': return sendButtons(to, tx(s, 'sPay'), [{ id: 'pay:standard', title: btn(s, 'payStandard') }, { id: 'pay:poc', title: btn(s, 'payPoc') }, skip]);
    default: return sendButtons(to, tx(s, 'sTheme'), [{ id: 'theme:auto', title: btn(s, 'themeAuto') }, { id: 'theme:dark', title: btn(s, 'themeDark') }, { id: 'theme:blush', title: btn(s, 'themeBlush') }]);
  }
}

async function setupNext(s, to) {
  const i = SETUP_ORDER.indexOf(s.awaiting);
  if (i + 1 >= SETUP_ORDER.length) return finishSetup(s, to);
  s.awaiting = SETUP_ORDER[i + 1];
  return askSetup(s, to);
}

async function setupText(s, to, text) {
  const t = text.trim();
  if (SKIP_RE.test(t.toLowerCase())) return setupNext(s, to);
  if (s.awaiting === 'setup_company') { s.draft.company = t.slice(0, 80); return setupNext(s, to); }
  if (s.awaiting === 'setup_rep') { s.draft.rep = t.slice(0, 60); return setupNext(s, to); }
  if (['setup_shingles', 'setup_years', 'setup_mfr'].includes(s.awaiting)) {
    const ex = await extract(s, text);
    const tiers = ex.updates.tiers || {};
    Object.keys(tiers).forEach((k) => { if (tiers[k]) delete tiers[k].price; });
    merge(s.draft.tiers, tiers);
    return setupNext(s, to);
  }
  if (s.awaiting === 'setup_pay') { s.draft.payment = { mode: /complet|poc|done|termin/i.test(t) ? 'on_completion' : 'standard' }; return setupNext(s, to); }
  const th = themeOf(t);
  if (th) s.draft.theme = th;
  return setupNext(s, to);
}

async function setupButton(s, to, id) {
  if (id === 'skip') return setupNext(s, to);
  if (id.startsWith('pay:')) s.draft.payment = { mode: id === 'pay:poc' ? 'on_completion' : 'standard' };
  if (id.startsWith('theme:')) s.draft.theme = id.split(':')[1];
  return setupNext(s, to);
}

async function finishSetup(s, to) {
  const profile = { ...s.draft, offered: true };
  saveProfile(to, profile);
  s.profile = profile;
  // Fill any blanks in the current job from the new defaults (typed values stay)
  const defaults = freshData(profile);
  ['good', 'better', 'best'].forEach((k) => {
    ['shingle', 'labor_years', 'mfr_warranty'].forEach((f) => { if (s.data.tiers[k][f] == null && defaults.tiers[k][f] != null) s.data.tiers[k][f] = defaults.tiers[k][f]; });
  });
  if (!s.data.payment.mode && defaults.payment.mode) s.data.payment = defaults.payment;
  if (!s.data.report_theme && defaults.report_theme) s.data.report_theme = defaults.report_theme;
  s.stage = !s.prevStage || s.prevStage === 'new' ? 'collect' : s.prevStage;
  s.awaiting = null;
  await sendText(to, tx(s, 'setupDone'));
  if (s.stage === 'collect' && s.data.customer_name_and_address) return advance(s, to);
  return null;
}

// ----- Voice notes: Gemini turns the audio into text, then it is handled like a typed message -----
async function fetchMedia(mediaId) {
  const res = await fetch(`https://graph.facebook.com/v26.0/${mediaId}`, { headers: { Authorization: `Bearer ${waToken}` } });
  const data = await res.json();
  if (!data.url) throw new Error('No media URL returned by Meta');
  const r = await fetch(data.url, { headers: { Authorization: `Bearer ${waToken}` } });
  return { buffer: Buffer.from(await r.arrayBuffer()), mime: data.mime_type || 'audio/ogg' };
}

async function transcribe(media) {
  const data = await callGemini({
    system: 'You transcribe a short voice note from a roofing contractor. Return ONLY JSON: {"text": "<verbatim transcript>"}. Keep the original language. If you cannot make out any speech, return {"text": ""}.',
    parts: [{ inline_data: { mime_type: media.mime.split(';')[0], data: media.buffer.toString('base64') } }, { text: 'Transcribe this voice note.' }],
    temperature: 0
  });
  const raw = geminiText(data);
  if (!raw) return '';
  try { return String(parseJsonText(raw).text || '').trim(); } catch (e) { return ''; }
}

async function onAudio(s, to, message, host, phone) {
  let text = '';
  try { text = await transcribe(await fetchMedia(message.audio.id)); } catch (err) { console.error('❌ Audio error:', err); }
  if (!text) return sendText(to, tx(s, 'voiceFail'));
  await sendText(to, tx(s, 'heard', text));
  return onText(s, to, text, host, phone);
}

// =============================================================================
// 8. WEBHOOK
// =============================================================================
app.get('/', (req, res) => {
  if (req.query['hub.mode'] === 'subscribe' && req.query['hub.verify_token'] === verifyToken) res.status(200).send(req.query['hub.challenge']);
  else res.status(403).end();
});

app.post('/', async (req, res) => {
  res.status(200).send('EVENT_RECEIVED');
  const value = req.body.entry?.[0]?.changes?.[0]?.value || req.body.value;
  const message = value?.messages?.[0];
  if (!message) return;

  const phone = message.from;
  const name = value?.contacts?.[0]?.profile?.name || 'Contractor';
  const host = req.get('host');
  let s = getSession(phone, name);
  s.host = host;

  // One message at a time per contractor, in order
  s.queue = s.queue.then(async () => {
    s = userSessions.get(phone) || s;
    s.host = host;
    try {
      if (message.type === 'text') {
        console.log(`💬 Text from ${name}: ${message.text.body}`);
        await onText(s, phone, message.text.body, host, phone);
      } else if (message.type === 'interactive') {
        const r = message.interactive?.button_reply || message.interactive?.list_reply;
        console.log(`🔘 Button from ${name}: ${r?.id}`);
        if (s.stage === 'new') s.stage = 'collect';
        await onButton(s, phone, r?.id, host, phone);
      } else if (message.type === 'image') {
        console.log(`📸 Image from ${name}`);
        await onImage(s, phone, message);
      } else if (message.type === 'audio') {
        console.log(`🎤 Voice note from ${name}`);
        await onAudio(s, phone, message, host, phone);
      } else {
        await sendText(phone, tx(s, 'voice'));
      }
    } catch (err) {
      console.error('❌ Processing error:', err);
      await sendText(phone, tx(s, 'hiccup'));
    }
  }).catch((e) => console.error('❌ Queue error:', e));
});

app.listen(port, () => console.log(`Server running on port ${port}`));
