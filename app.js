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
// The raw body is kept so WhatsApp's signature can be checked against it.
app.use(express.json({ verify: (req, res, buf) => { req.rawBody = buf; } }));
app.use('/files', express.static(publicDir)); // file names are random, so links can't be guessed

const port = process.env.PORT || 3000;
const verifyToken = process.env.VERIFY_TOKEN;
const waToken = process.env.WA_TOKEN;
const waPhoneId = process.env.WA_PHONE_ID;
const geminiApiKey = process.env.GEMINI_API_KEY;
const GEMINI_MODEL = process.env.GEMINI_MODEL || 'gemini-3.8-flash';
// Automated tests only: gives every new phone this company name so tests can skip enrollment. Never set it in production.
const AUTO_ENROLL = process.env.AUTO_ENROLL_COMPANY || '';
// Better = Good + this %, and Best = Better + this %. The contractor only ever enters the Good price.
const TIER_STEP_PCT = Number(process.env.TIER_STEP_PCT || 10);
// The setup offer waits a few seconds so it lands AFTER the report file (WhatsApp delivers attachments a little later than text).
const OFFER_DELAY_MS = Number(process.env.OFFER_DELAY_MS || 8000);
const PHOTO_WAIT_MS = Number(process.env.PHOTO_WAIT_MS || 6000); // wait for the last photo before replying

// Default look: day (unless changed), or dark, blush, or auto (follows the customer's device). The customer can still switch on the page.
const REPORT_THEME = process.env.REPORT_THEME || 'day';
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

const LOGO_DIR = path.join(DATA_DIR, 'logos');
if (!fs.existsSync(LOGO_DIR)) fs.mkdirSync(LOGO_DIR, { recursive: true });

// Every report gets a secret token so the customer's "Accept" can be matched to the right quote and contractor.
const QUOTES_FILE = path.join(DATA_DIR, 'quotes.json');
let QUOTES = {};
try { QUOTES = JSON.parse(fs.readFileSync(QUOTES_FILE, 'utf8')); } catch (e) { QUOTES = {}; }
function saveQuotes() {
  try { fs.writeFileSync(QUOTES_FILE, JSON.stringify(QUOTES)); } catch (e) { console.error('❌ Could not save quotes:', e.message); }
}

// =============================================================================
// 1. CONVERSATION TEXT. Edit the words here; buttons are max 20 characters.
// =============================================================================
const TXT = {
  en: {
    hello: (n) => `Hi ${n}! 👋 Send me the roof photos whenever you're ready (one wide shot plus a few close-ups of damage), then tell me who the customer is and the property address. Got a roof measurement report? Send the PDF too.`,
    photoTip: '📸 Send roof photos when you can: a wide shot plus close-ups of damage.',
    gotPhotos: (n) => `📸 Got ${n} photo${n === 1 ? '' : 's'}.`,
    qAddr: "Who's the customer, and what's the property address?",
    qType: 'Is this a full replacement or a repair?',
    qSource: 'Is this a retail or an insurance job?',
    qClaim: "What's the claim number?",
    qArea: 'About how many sq ft is the roof? Or send the measurement report (PDF).',
    qPriceRep: (pct) => `What's the price for the Good option? I'll add ${pct}% for Better, and another ${pct}% for Best.`,
    formulaNote: (pct) => `Better = Good + ${pct}%, Best = Better + ${pct}%`,
    needPriceRep: 'I need a price to build the quote. Type a number, like 20k. (0 is fine.)',
    needPriceRpr: 'I need a price to build the quote. Type one total, or the repairs with prices, like: flashing $300, vents $200. (0 is fine.)',
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
    acceptedMsg: (name, no, addr, opt, when) => `✅ ${name} accepted Quote ${no} for ${addr}.\n${opt}\nSigned by typing their name on ${when}.`,
    pendingHead: '📬 While you were away:',
    confirmCaption: (no, name) => `Acceptance confirmation ${no} · ${name}`,
    notesHead: 'Before you send this report:',
    notesPhotos: '📸 Photos not used',
    notesCheck: '⚠️ Please check',
    notesBlank: '📝 Left blank (the report says "to be confirmed")',
    notesMore: (n) => `…and ${n} more`,
    photoWord: 'Photo',
    hiccup: 'Sorry, I hit a snag. Please try that again.',
    onlyThese: 'I can read typed messages, photos and PDF reports.',
    editHint: 'Tell me what to change, or tap New quote.',
    replacement: 'Replacement', repair: 'Repair', retail: 'Retail', insurance: 'Insurance',
    lblCustomer: '👤', lblJob: '🏠', lblPrices: '💵', lblDiscount: '🏷️', lblPhotos: '📸',
    photosWord: (n) => `${n} photo${n === 1 ? '' : 's'}`,
    areaWord: 'sq ft', storiesWord: 'story', insuranceWord: 'Insurance',
    tierWords: ['Good', 'Better', 'Best'],
    blankArea: 'roof area', blankPrices: 'prices', blankShingles: 'shingles', blankYears: 'workmanship warranty', blankMfr: 'manufacturer warranty',
    qExtrasProfile: 'Any discount, or anything special for this job? Type it, or tap below.',
    qAdd: 'What should I add? Type it all in one message.',
    okay: '👍 No problem. Type "setup" any time.',
    offerSetup: '💡 Want me to remember your usual shingles, warranties, payment terms and branding (phone, license, color)? It takes a minute.',
    setupIntro: 'Quick setup, so I never ask these again. You can skip any question.',
    sCompany: "What's your company name?",
    sRep: 'What name should show on reports?',
    sShingles: 'What are your usual shingles for Good / Better / Best?',
    sYears: 'Usual workmanship warranty in years? Like: 10 / 15 / 25',
    sMfr: 'Manufacturer warranty for each? Like: limited lifetime / 50-year / limited lifetime',
    sPay: 'How do you usually get paid?',
    sTheme: 'Which look do you like for your reports?',
    setupDone: '✅ Saved! I will use these on every quote. Type "setup" any time to change them.',
    readingMeasure: '📐 Reading your measurement report…',
    measureOk: (line) => `📐 Got it: ${line}. I'll use these figures in the report.`,
    notMeasure: "That doesn't look like a roof measurement report. I can read GAF QuickMeasure, EagleView and similar PDFs.",
    measureFail: "I couldn't read that file. Please send the measurement report as a PDF again, or just type the roof area.",
    pdfOnly: 'I can only read PDF reports. Please send the measurement report as a PDF.',
    lblMeasure: '📐', facetsWord: 'facets',
    qCondition: 'How would you rate the condition of the shingle field?',
    lblCondition: '🔎',
    condWords: { serviceable: 'Serviceable', monitor: 'Monitor', end_of_life: 'End of life' },
    blankCondition: 'shingle condition',
    enrollWelcome: "Welcome! 👋 I'm Textimator. First, a one-minute setup so every report carries your company name and logo.",
    needCompany: 'I need your company name to put on your reports. What is it?',
    qLogo: (name) => `Nice to meet you, ${name}! Now send your logo as an image. No logo? Tap below and I'll make a clean header from your name.`,
    enrollDone: (name, logo) => `✅ Done! ${name}${logo ? ' and your logo' : ''} will appear on every report you create. Type "my quotes" any time to see your past reports.`,
    myQuotesHead: 'Your latest reports:',
    myQuotesNone: "You haven't created any reports yet.",
    qAccepted: '✅ accepted', qSent: '⏳ waiting',
    qStories: 'How many stories is the house?',
    qLeaks: 'Has the homeowner reported any leaks?',
    nudge: '👆 Tap one of the buttons, or type your answer.',
    lblPay: '💳', lblTime: '⏱', lblWarranty: '🛡', lblShingle: '🧱', lblLeaks: '💧',
    payCompletion: 'Pay on completion', payDepositBalance: 'Deposit + balance', payStages: 'Deposit + stages',
    upTo: (n) => `Up to ${n} days`, workmanship: 'Workmanship', yrsWord: 'yrs',
    leaksYes: 'Leaks reported', leaksNo: 'No leaks reported', leaksUnknown: 'Leaks: not sure',
    sBrand: 'Want to add your phone number, license number and logo? Customers will see them on the report.',
    sPhone: 'What phone number can customers call or WhatsApp?',
    sLicense: "What's your license number?",
    sColor: 'Brand color? Tap one, or type a code like #1A5FB4.',
    sLogo: 'Send your logo as an image.',
    btn: { noLogo: 'No logo', serviceable: 'Serviceable', monitor: 'Monitor', endOfLife: 'End of life', addBrand: 'Add branding', blue: 'Blue', green: 'Green', story1: '1 story', story2: '2 stories', yes: 'Yes', no: 'No', unsure: 'Not sure', add: 'Add details', payStandard: 'Deposit + stages', payPoc: 'On completion', themeDay: 'Day', themeDark: 'Dark', themeBlush: 'Blush', setupNow: 'Set up now', notNow: 'Not now', replacement: 'Replacement', repair: 'Repair', retail: 'Retail', insurance: 'Insurance', skip: 'Skip', nothing: 'Nothing else', build: 'Build report', change: 'Change something', newq: 'New quote', edit: 'Make a change' }
  },
  es: {
    hello: (n) => `¡Hola ${n}! 👋 Envíame las fotos del techo cuando quieras (una general y algunas de cerca de los daños), y luego dime quién es el cliente y la dirección. ¿Tienes un informe de medición del techo? Envía el PDF también.`,
    photoTip: '📸 Envía fotos del techo cuando puedas: una general y otras de cerca de los daños.',
    gotPhotos: (n) => `📸 Recibí ${n} foto${n === 1 ? '' : 's'}.`,
    qAddr: '¿Quién es el cliente y cuál es la dirección de la propiedad?',
    qType: '¿Es un reemplazo completo o una reparación?',
    qSource: '¿Es un trabajo particular o de seguro?',
    qClaim: '¿Cuál es el número de reclamo?',
    qArea: '¿Cuántos pies cuadrados tiene el techo, más o menos? O envía el informe de medición (PDF).',
    qPriceRep: (pct) => `¿Cuál es el precio de la opción Bueno? Sumaré ${pct}% para Mejor, y otro ${pct}% para Óptimo.`,
    formulaNote: (pct) => `Mejor = Bueno + ${pct}%, Óptimo = Mejor + ${pct}%`,
    needPriceRep: 'Necesito un precio para armar la cotización. Escribe un número, como 20k. (0 está bien.)',
    needPriceRpr: 'Necesito un precio para armar la cotización. Escribe un total, o las reparaciones con su precio, así: flashing $300, ventilas $200. (0 está bien.)',
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
    acceptedMsg: (name, no, addr, opt, when) => `✅ ${name} aceptó la cotización ${no} para ${addr}.\n${opt}\nFirmó escribiendo su nombre el ${when}.`,
    pendingHead: '📬 Mientras no estabas:',
    confirmCaption: (no, name) => `Confirmación de aceptación ${no} · ${name}`,
    notesHead: 'Antes de enviar este informe:',
    notesPhotos: '📸 Fotos que no se usaron',
    notesCheck: '⚠️ Por favor revisa',
    notesBlank: '📝 Quedó en blanco (el informe dirá "por confirmar")',
    notesMore: (n) => `…y ${n} más`,
    photoWord: 'Foto',
    hiccup: 'Perdón, tuve un problema. Inténtalo de nuevo.',
    onlyThese: 'Puedo leer mensajes escritos, fotos e informes en PDF.',
    editHint: 'Dime qué cambiar, o toca Nueva cotización.',
    replacement: 'Reemplazo', repair: 'Reparación', retail: 'Particular', insurance: 'Seguro',
    lblCustomer: '👤', lblJob: '🏠', lblPrices: '💵', lblDiscount: '🏷️', lblPhotos: '📸',
    photosWord: (n) => `${n} foto${n === 1 ? '' : 's'}`,
    areaWord: 'pies²', storiesWord: 'piso', insuranceWord: 'Seguro',
    tierWords: ['Bueno', 'Mejor', 'Óptimo'],
    blankArea: 'área del techo', blankPrices: 'precios', blankShingles: 'tejas', blankYears: 'garantía de mano de obra', blankMfr: 'garantía del fabricante',
    qExtrasProfile: '¿Algún descuento o algo especial para este trabajo? Escríbelo, o toca abajo.',
    qAdd: '¿Qué debo agregar? Escríbelo todo en un mensaje.',
    okay: '👍 Sin problema. Escribe "setup" cuando quieras.',
    offerSetup: '💡 ¿Quieres que recuerde tus tejas, garantías, forma de pago y marca habituales (teléfono, licencia, color)? Toma un minuto.',
    setupIntro: 'Configuración rápida, para no volver a preguntarte esto. Puedes omitir cualquier pregunta.',
    sCompany: '¿Cómo se llama tu empresa?',
    sRep: '¿Qué nombre debe aparecer en los informes?',
    sShingles: '¿Cuáles son tus tejas habituales para Bueno / Mejor / Óptimo?',
    sYears: '¿Garantía habitual de mano de obra en años? Ej.: 10 / 15 / 25',
    sMfr: '¿Garantía del fabricante de cada una? Ej.: de por vida limitada / 50 años / de por vida limitada',
    sPay: '¿Cómo sueles cobrar?',
    sTheme: '¿Qué estilo prefieres para tus informes?',
    setupDone: '✅ ¡Guardado! Lo usaré en cada cotización. Escribe "setup" cuando quieras cambiarlo.',
    readingMeasure: '📐 Leyendo tu informe de medición…',
    measureOk: (line) => `📐 Listo: ${line}. Usaré estas medidas en el informe.`,
    notMeasure: 'Eso no parece un informe de medición de techo. Puedo leer PDFs de GAF QuickMeasure, EagleView y similares.',
    measureFail: 'No pude leer ese archivo. Envía el informe de medición en PDF otra vez, o escribe el área del techo.',
    pdfOnly: 'Solo puedo leer informes en PDF. Envía el informe de medición como PDF.',
    lblMeasure: '📐', facetsWord: 'facetas',
    qCondition: '¿Cómo calificas el estado de las tejas?',
    lblCondition: '🔎',
    condWords: { serviceable: 'Aceptable', monitor: 'Vigilar', end_of_life: 'Fin de vida' },
    blankCondition: 'estado de las tejas',
    enrollWelcome: '¡Bienvenido! 👋 Soy Textimator. Primero, una configuración de un minuto para que cada informe lleve el nombre y el logo de tu empresa.',
    needCompany: 'Necesito el nombre de tu empresa para ponerlo en tus informes. ¿Cómo se llama?',
    qLogo: (name) => `¡Mucho gusto, ${name}! Ahora envía tu logo como imagen. ¿No tienes logo? Toca abajo y haré un encabezado limpio con tu nombre.`,
    enrollDone: (name, logo) => `✅ ¡Listo! ${name}${logo ? ' y tu logo' : ''} aparecerán en cada informe que crees. Escribe "mis cotizaciones" cuando quieras ver tus informes anteriores.`,
    myQuotesHead: 'Tus últimos informes:',
    myQuotesNone: 'Todavía no has creado informes.',
    qAccepted: '✅ aceptado', qSent: '⏳ en espera',
    qStories: '¿Cuántos pisos tiene la casa?',
    qLeaks: '¿El dueño ha reportado goteras?',
    nudge: '👆 Toca uno de los botones, o escribe tu respuesta.',
    lblPay: '💳', lblTime: '⏱', lblWarranty: '🛡', lblShingle: '🧱', lblLeaks: '💧',
    payCompletion: 'Pago al terminar', payDepositBalance: 'Depósito + saldo', payStages: 'Depósito + etapas',
    upTo: (n) => `Hasta ${n} días`, workmanship: 'Mano de obra', yrsWord: 'años',
    leaksYes: 'Hay goteras', leaksNo: 'Sin goteras', leaksUnknown: 'Goteras: no sé',
    sBrand: '¿Quieres agregar tu teléfono, número de licencia y logo? Los clientes los verán en el informe.',
    sPhone: '¿Qué número pueden llamar o escribir por WhatsApp los clientes?',
    sLicense: '¿Cuál es tu número de licencia?',
    sColor: '¿Color de tu marca? Toca uno, o escribe un código como #1A5FB4.',
    sLogo: 'Envía tu logo como imagen.',
    btn: { noLogo: 'Sin logo', serviceable: 'Aceptable', monitor: 'Vigilar', endOfLife: 'Fin de vida', addBrand: 'Agregar marca', blue: 'Azul', green: 'Verde', story1: '1 piso', story2: '2 pisos', yes: 'Sí', no: 'No', unsure: 'No sé', add: 'Agregar datos', payStandard: 'Depósito + etapas', payPoc: 'Al terminar', themeDay: 'Día', themeDark: 'Oscuro', themeBlush: 'Rosado', setupNow: 'Configurar ahora', notNow: 'Ahora no', replacement: 'Reemplazo', repair: 'Reparación', retail: 'Particular', insurance: 'Seguro', skip: 'Omitir', nothing: 'Nada más', build: 'Crear informe', change: 'Cambiar algo', newq: 'Nueva cotización', edit: 'Hacer un cambio' }
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

// ---- Signature check: Meta signs every webhook call with the App Secret. Calls without a valid signature are ignored. ----
const WA_APP_SECRET = process.env.WA_APP_SECRET || '';
if (!WA_APP_SECRET) console.error('⚠️ WA_APP_SECRET is not set, so incoming WhatsApp calls are NOT verified. Anyone who knows your URL could send fake messages. Set it in your environment.');
function validSignature(req) {
  if (!WA_APP_SECRET) return true;
  const header = String(req.get('x-hub-signature-256') || '');
  if (!header.startsWith('sha256=') || !req.rawBody) return false;
  const expected = crypto.createHmac('sha256', WA_APP_SECRET).update(req.rawBody).digest('hex');
  const given = header.slice(7);
  return given.length === expected.length && crypto.timingSafeEqual(Buffer.from(given), Buffer.from(expected));
}

// ---- WhatsApp's 24-hour rule: free-form messages only work within 24 hours of the contractor's last message. ----
// Outside that window an approved template is required, so we track the window, use a template when it is closed,
// and hold the message until the contractor next writes if no template is configured.
const WINDOW_MS = 23.5 * 60 * 60 * 1000; // a little under 24h, to be safe
const TEMPLATE_ACCEPTED = process.env.WA_TEMPLATE_ACCEPTED || '';
const TEMPLATE_LANG = process.env.WA_TEMPLATE_LANG || 'en_US';
const TEMPLATE_LANG_ES = process.env.WA_TEMPLATE_LANG_ES || 'es';
if (!TEMPLATE_ACCEPTED) console.error('ℹ️ WA_TEMPLATE_ACCEPTED is not set: an acceptance that arrives after 24h will wait until the contractor next messages the bot.');

const WINDOWS_FILE = path.join(DATA_DIR, 'windows.json');
const PENDING_FILE = path.join(DATA_DIR, 'pending.json');
let WINDOWS = {}; let PENDING = {};
try { WINDOWS = JSON.parse(fs.readFileSync(WINDOWS_FILE, 'utf8')); } catch (e) { WINDOWS = {}; }
try { PENDING = JSON.parse(fs.readFileSync(PENDING_FILE, 'utf8')); } catch (e) { PENDING = {}; }
let windowsTimer = null;
function touchWindow(phone) {
  WINDOWS[phone] = Date.now();
  if (windowsTimer) return;
  windowsTimer = setTimeout(() => {
    windowsTimer = null;
    try { fs.writeFileSync(WINDOWS_FILE, JSON.stringify(WINDOWS)); } catch (e) { console.error('❌ Could not save windows:', e.message); }
  }, 30000);
}
const windowOpen = (phone) => Boolean(WINDOWS[phone]) && Date.now() - WINDOWS[phone] < WINDOW_MS;
function savePending() {
  try { fs.writeFileSync(PENDING_FILE, JSON.stringify(PENDING)); } catch (e) { console.error('❌ Could not save pending notices:', e.message); }
}
function queuePending(phone, text, doc) {
  PENDING[phone] = [...(PENDING[phone] || []), { text: text || '', doc: doc || null, at: Date.now() }].slice(-20);
  savePending();
}
function takePending(phone) {
  const list = PENDING[phone] || [];
  if (list.length) { delete PENDING[phone]; savePending(); }
  return list;
}
const sendTemplate = (to, name, lang, params) => waPost({
  to, type: 'template',
  template: { name, language: { code: lang }, components: [{ type: 'body', parameters: params.map((t) => ({ type: 'text', text: t })) }] }
}, 'template');
const tplText = (v) => String(v == null ? '' : v).replace(/[\n\r\t]+/g, ' ').replace(/ {2,}/g, ' ').trim().slice(0, 120) || '—';

// Tells a contractor something they did not just ask for. Returns how it was delivered: sent, template or queued.
// A document (the acceptance PDF) can only be sent inside the window, so outside it, it waits for the contractor's next message.
async function notifyContractor(phone, text, tpl, doc) {
  if (windowOpen(phone) && (await sendText(phone, text))) {
    if (doc) await sendDocument(phone, doc.url, doc.filename, doc.caption);
    return 'sent';
  }
  if (tpl && TEMPLATE_ACCEPTED && (await sendTemplate(phone, TEMPLATE_ACCEPTED, tpl.lang === 'es' ? TEMPLATE_LANG_ES : TEMPLATE_LANG, tpl.params.map(tplText)))) {
    if (doc) queuePending(phone, '', doc);
    return 'template';
  }
  queuePending(phone, text, doc);
  return 'queued';
}

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
- A price or amount of 0 is a valid answer: return 0, never null. "Free", "no charge" or "courtesy" means a price of 0.
- A bare number is NEVER a price unless awaiting is "price", and never an area unless awaiting is "area". When in doubt, leave it out.
- intent "skip": they decline or don't know ("skip", "no", "none", "I don't know", "n/a") with nothing else useful. intent "build": they ask to generate/send/finish ("generate", "that's all, build it"). intent "new_quote": they want to start a different job. Otherwise "answer".

FIELDS (all optional):
customer_name_and_address: string, name plus address exactly as given
job_type: "replacement" (full roof replacement / tear-off) or "repair"
lead_source: "retail" or "insurance"; claim_number: string
roof_area_sqft: number (1 roofing "square" = 100 sq ft)
building_stories, current_roof_and_condition, site_notes: strings
leaks: "yes", "no" or "unknown" (has the homeowner reported leaks)
condition: "serviceable", "monitor" or "end_of_life" ONLY if the contractor explicitly rates the shingle field (e.g. "roof is shot" = end_of_life, "still fine" = serviceable, "aging" = monitor)
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
  if (out.leaks) out.leaks = /^(y|s[ií]\b|yes|true)/i.test(out.leaks) ? 'yes' : /^(n|none|false)/i.test(out.leaks) ? 'no' : 'unknown';
  if (out.condition) out.condition = ['serviceable', 'monitor', 'end_of_life'].includes(out.condition) ? out.condition : undefined;
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
    leaks: null, condition: null, roof_area_sqft: null, building_stories: null, current_roof_and_condition: null, site_notes: null, pitch: null,
    tiers: { good: {}, better: {}, best: {} },
    repair: { items: null, total_price: null, labor_years: null },
    discount: null,
    payment: { mode: null, deposit: null, deposit_pct: null },
    timeline_days: null, wood_pct: null, report_theme: null, extra_notes: null, measurement: null
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
    report: null, photoTimer: null, quoteNo: null, queue: Promise.resolve()
  };
}

const isRepair = (s) => s.data.job_type === 'repair';
// Prices the contractor typed are kept as they are; the rest follow the formula (rounded to whole dollars).
function tierPrices(s) {
  const t = s.data.tiers;
  const step = 1 + TIER_STEP_PCT / 100;
  const good = t.good.price != null ? t.good.price : null;
  const better = t.better.price != null ? t.better.price : (good != null ? Math.round(good * step) : null);
  const best = t.best.price != null ? t.best.price : (better != null ? Math.round(better * step) : null);
  return [good, better, best];
}
const priceByFormula = (s) => s.data.tiers.good.price != null && (s.data.tiers.better.price == null || s.data.tiers.best.price == null);
const pricesComplete = (s) => (isRepair(s)
  ? Boolean((s.data.repair.items && s.data.repair.items.length) || s.data.repair.total_price != null)
  : tierPrices(s).some((p) => p != null));
const activeTierKeys = (s) => (tierPrices(s).some((p) => p != null) ? ['good', 'better', 'best'] : ['good']);

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
  if (!d.building_stories && !s.skipped.has('stories')) return 'stories';
  if (!d.leaks && !s.skipped.has('leaks')) return 'leaks';
  if (!d.condition && !s.skipped.has('condition')) return 'condition';
  if (!pricesComplete(s)) return 'price'; // the price is required (0 counts as a price)
  if (!s.extrasDone) return 'extras';
  return 'confirm';
}

const money = (n) => '$' + Number(n).toLocaleString('en-US');

function blanks(s) {
  const d = s.data; const out = [];
  if (!d.roof_area_sqft) out.push(tx(s, 'blankArea'));
  if (!pricesComplete(s)) out.push(tx(s, 'blankPrices'));
  if (!d.condition) out.push(tx(s, 'blankCondition'));
  if (!isRepair(s)) {
    const ts = activeTierKeys(s).map((k) => d.tiers[k]);
    if (ts.some((t) => !t.shingle)) out.push(tx(s, 'blankShingles'));
    if (ts.some((t) => t.labor_years == null)) out.push(tx(s, 'blankYears'));
    if (ts.some((t) => !t.mfr_warranty)) out.push(tx(s, 'blankMfr'));
  }
  return out;
}

function measureLine(s) {
  const m = s.data.measurement;
  if (!m) return '';
  const st = m.structures || [];
  const facets = st.reduce((a, x) => a + (x.facets || 0), 0);
  const pitch = (st.find((x) => x.pitch) || {}).pitch;
  return [m.source || 'Measurement report', m.total_area_sqft ? `${Number(m.total_area_sqft).toLocaleString('en-US')} ${tx(s, 'areaWord')}` : '', facets ? `${facets} ${tx(s, 'facetsWord')}` : '', pitch || ''].filter(Boolean).join(' · ');
}

function extraLines(s) {
  const d = s.data; const out = [];
  if (d.measurement) out.push(`${tx(s, 'lblMeasure')} ${measureLine(s)}`);
  if (d.condition) out.push(`${tx(s, 'lblCondition')} ${tx(s, 'condWords')[d.condition]}`);
  if (d.leaks) out.push(`${tx(s, 'lblLeaks')} ${tx(s, d.leaks === 'yes' ? 'leaksYes' : d.leaks === 'no' ? 'leaksNo' : 'leaksUnknown')}`);
  const shingles = [...new Set(['good', 'better', 'best'].map((k) => d.tiers[k].shingle).filter(Boolean))];
  if (!isRepair(s) && shingles.length) out.push(`${tx(s, 'lblShingle')} ${shingles.join(' / ')}`);
  const yrs = (isRepair(s) ? [d.repair.labor_years] : ['good', 'better', 'best'].map((k) => d.tiers[k].labor_years)).filter((v) => v != null);
  if (yrs.length) out.push(`${tx(s, 'lblWarranty')} ${tx(s, 'workmanship')} ${yrs.join(' / ')} ${tx(s, 'yrsWord')}`);
  const pm = d.payment && d.payment.mode;
  if (pm) out.push(`${tx(s, 'lblPay')} ${pm === 'on_completion' ? tx(s, 'payCompletion') : pm === 'deposit_balance' ? tx(s, 'payDepositBalance') : tx(s, 'payStages')}`);
  if (d.timeline_days != null) out.push(`${tx(s, 'lblTime')} ${tx(s, 'upTo', d.timeline_days)}`);
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
    if (priceByFormula(s)) lines.push(`    ${tx(s, 'formulaNote', TIER_STEP_PCT)}`);
  }
  if (d.discount && d.discount !== 'none') lines.push(`${tx(s, 'lblDiscount')} ${d.discount.pct}% ${d.discount.name || ''}`.trim());
  extraLines(s).forEach((l) => lines.push(l));
  lines.push(`${tx(s, 'lblPhotos')} ${tx(s, 'photosWord', s.images.length)}`);
  const b = blanks(s);
  if (b.length) lines.push('', tx(s, 'blank', b.join(', ')));
  if (s.images.length > 0 && s.images.length < 3) lines.push('', tx(s, 'moreClose'));
  return lines.join('\n');
}

// Turns the model's raw flags and the app's own blanks into ONE short message, grouped by what the contractor must do.
// The app lists blanks itself, once, so the model's own "MISSING" / "DRAFT" lines are dropped.
function buildNotes(s, flags) {
  const excluded = []; const check = [];
  for (const raw of flags || []) {
    const m = String(raw).match(/^([A-Za-z ]+):\s*([\s\S]*)$/);
    const kind = m ? m[1].trim().toUpperCase() : 'CHECK';
    const text = (m ? m[2] : String(raw)).trim();
    if (kind === 'MISSING' || kind === 'DRAFT' || kind === 'NOTE') continue;
    if (kind === 'EXCLUDED') {
      const e = text.match(/^(\S+)\s*([\s\S]*)$/);
      excluded.push({ id: e ? e[1] : '?', why: ((e && e[2]) || '').replace(/\s+/g, ' ').slice(0, 150) });
    } else check.push(text.replace(/\s+/g, ' ').slice(0, 220));
  }
  const cap = (arr, fn) => { const shown = arr.slice(0, 3).map(fn); if (arr.length > 3) shown.push(`• ${tx(s, 'notesMore', arr.length - 3)}`); return shown.join('\n'); };
  const blank = blanks(s);
  const parts = [];
  if (excluded.length) parts.push(`${tx(s, 'notesPhotos')}\n${cap(excluded, (x) => `• ${tx(s, 'photoWord')} ${x.id}${x.why ? `: ${x.why}` : ''}`)}`);
  if (check.length) parts.push(`${tx(s, 'notesCheck')}\n${cap(check, (x) => `• ${x}`)}`);
  if (blank.length) parts.push(`${tx(s, 'notesBlank')}\n${blank.join(' · ')}`);
  return { text: parts.length ? `${tx(s, 'notesHead')}\n\n${parts.join('\n\n')}` : '', hasBlanks: blank.length > 0 };
}

// Sends the next question (or the summary). Everything the contractor already told us is skipped.
async function advance(s, to, forced) {
  const q = forced || nextQuestion(s);
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
    case 'stories': return sendButtons(to, tx(s, 'qStories'), [{ id: 'st:1', title: btn(s, 'story1') }, { id: 'st:2', title: btn(s, 'story2') }, skipBtn]);
    case 'leaks': return sendButtons(to, tx(s, 'qLeaks'), [{ id: 'lk:yes', title: btn(s, 'yes') }, { id: 'lk:no', title: btn(s, 'no') }, { id: 'lk:unknown', title: btn(s, 'unsure') }]);
    case 'condition': return sendButtons(to, tx(s, 'qCondition'), [{ id: 'cd:serviceable', title: btn(s, 'serviceable') }, { id: 'cd:monitor', title: btn(s, 'monitor') }, { id: 'cd:end_of_life', title: btn(s, 'endOfLife') }]);
    case 'price':
      return sendText(to, isRepair(s) ? tx(s, 'qPriceRpr') : tx(s, 'qPriceRep', TIER_STEP_PCT)); // no Skip button: the price is required
    case 'extras': {
      const known = s.profile && s.profile.tiers && s.profile.tiers.good && s.profile.tiers.good.shingle;
      return sendButtons(to, tx(s, known ? 'qExtrasProfile' : 'qExtras'), [{ id: 'extras:none', title: btn(s, 'nothing') }]);
    }
    default: return showConfirm(s, to);
  }
}

async function showConfirm(s, to) {
  const d = s.data;
  const missing = !d.customer_name_and_address ? 'addr' : !d.job_type ? 'type' : !pricesComplete(s) ? 'price' : null;
  if (missing) return advance(s, to, missing); // required answers come first, even if the contractor typed "generate"
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
function getBuilderPrompt(s) {
  const md = fs.readFileSync(PROMPT_PATH, 'utf8');
  return (
    'The input below is a structured intake summary from the contractor (JSON), plus the roof photos. ' +
    'Treat it as the conversation described in the rules. The app sets prices, options, discount, payment terms and job type itself from the intake, ' +
    'so your job is the wording: names, address, condition, findings, themes, priorities, captions and the cover photo.\n\n' +
    `Write every entry in \`flags\` in ${s && s.lang === 'es' ? 'Spanish' : 'English'}.\n\n` +
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
  const data = await callGemini({ system: getBuilderPrompt(s), parts, temperature: 0.2 });
  const raw = geminiText(data);
  if (!raw) throw new Error('Report builder returned nothing');
  return parseJsonText(raw);
}

// The app (not the model) sets every price, warranty, discount and term, straight from what the contractor said.
function applyIntake(d, s) {
  const D = s.data;
  d.meta = d.meta || {};
  const P = s.profile || {};
  d.meta.company = P.company || s.contractorName; // every report carries the name of the contractor who made it
  d.meta.companyAddress = P.companyAddress || '';
  d.meta.rep = P.rep || '';
  d.meta.reportNo = s.quoteNo || '';
  d.meta.date = new Date().toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric' });
  d.meta.dateLabel = d.meta.dateLabel || 'Report date';
  d.meta.theme = themeOf(D.report_theme) || themeOf(REPORT_THEME) || 'day';
  d.meta.jobType = isRepair(s) ? 'repair' : 'replacement';
  d.meta.product = isRepair(s) ? 'Roof repair' : 'Shingle roof replacement';
  d.meta.areaSqFt = D.roof_area_sqft || '';
  d.meta.pitch = D.pitch || null;
  d.verdict = d.verdict || {};
  if (D.condition) d.verdict.condition = D.condition; else delete d.verdict.condition; // the contractor decides; no rating means no meter
  d.meta.leadSource = D.lead_source || 'retail';
  d.meta.claimNumber = D.lead_source === 'insurance' ? D.claim_number || '' : '';
  let logo = '';
  try {
    const lf = P.logoFile && [path.join(LOGO_DIR, P.logoFile), path.join(publicDir, P.logoFile)].find((f) => fs.existsSync(f));
    if (lf) logo = `data:image/jpeg;base64,${fs.readFileSync(lf).toString('base64')}`;
  } catch (e) { logo = ''; }
  d.meta.brand = { phone: P.phone || '', whatsapp: P.phone || '', license: P.license || '', color: P.brandColor || '', logo };
  d.discount = D.discount && D.discount !== 'none' ? { pct: D.discount.pct, name: String(D.discount.name || 'customer').toLowerCase() } : null;
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
        shingle: t.shingle || null, listPrice: tierPrices(s)[['good', 'better', 'best'].indexOf(k)], laborYears: t.labor_years != null ? t.labor_years : null,
        mfrWarranty: t.mfr_warranty ? `${makerOf(t.shingle) ? makerOf(t.shingle) + ' ' : ''}${String(t.mfr_warranty).toLowerCase().replace(/ ?manufacturer warranty| ?warranty/g, '')} manufacturer warranty` : null,
        mfrShort: t.mfr_warranty ? mfrShort(t.mfr_warranty) : null
      };
    });
    delete d.repair;
  }
  // Anything about measurements, buildings, simulations or financing that the model wrote is thrown away:
  // these exist only when real data backs them, and the contractor uploaded no such data except a measurement report.
  ['measurements', 'measuredPage', 'simulation', 'financing', 'buildings', 'scope', 'compare', 'itemIntro', 'itemNote', 'priceBullets', 'priceSubtitle', 'priceLabel'].forEach((k) => { delete d[k]; });
  ['pitchNote', 'areaNote', 'roofBit', 'measureSource', 'measureDate', 'facets'].forEach((k) => { delete d.meta[k]; });
  (d.problemsTable || []).forEach((r) => { delete r.building; });
  (d.findings || []).forEach((f) => { delete f.building; });
  if (D.measurement) applyMeasurement(d, D.measurement);
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
  if (!pricesComplete(s)) return advance(s, to, 'price');
  if (!s.data.customer_name_and_address) { s.awaiting = 'addr'; return sendText(to, tx(s, 'needAddr')); }
  if (s.images.length === 0) { s.awaiting = 'photo'; return sendText(to, tx(s, 'needPhoto')); }
  s.stage = 'building';
  await sendText(to, tx(s, 'building'));
  try {
    const d = embedPhotos(applyIntake(await buildReportData(s), s), s);
    const token = crypto.randomBytes(12).toString('hex');
    d.meta.acceptToken = token;
    d.meta.acceptUrl = `https://${host}/accept`;
    // The first build of a quote takes the contractor's next number; edits and rebuilds keep it.
    if (!s.quoteNo) {
      const pr0 = getProfile(to) || {};
      const n = pr0.nextNumber || 1;
      saveProfile(to, { ...pr0, nextNumber: n + 1 });
      s.profile = getProfile(to);
      s.quoteNo = `Q-${String(n).padStart(4, '0')}`;
    }
    d.meta.reportNo = s.quoteNo;
    if (!(d.findings || []).length) throw new Error('No findings written');
    if (!s.data.condition) d.flags.push('NOTE: The shingle condition was not rated, so the condition meter is hidden.');
    const said = `${(d.verdict && d.verdict.headline) || ''} ${(d.verdict && d.verdict.paragraph) || ''}`;
    if (s.data.condition && s.data.condition !== 'end_of_life' && /end of (its )?life|worn through|beyond repair/i.test(said)) {
      d.flags.push(`CHECK: You rated the shingles "${s.data.condition === 'monitor' ? 'Monitor' : 'Serviceable'}", but the summary text sounds more severe. Read "The one thing to know" before sending.`);
    }
    const b = blanks(s);
    if (b.length) d.flags.push(`DRAFT: still blank: ${b.join(', ')}.`);
    s.report = JSON.parse(JSON.stringify(d, (k, v) => (k === 'photoSrc' || k === 'coverPhotoSrc' || k === 'logo' ? undefined : v)));
    const fileName = `Roof_Quote_${crypto.randomBytes(8).toString('hex')}.html`;
    fs.writeFileSync(path.join(publicDir, fileName), renderQuoteHtml(d), 'utf8');
    const url = `https://${host}/files/${fileName}`;
    const listPrices = (d.options || []).map((o) => o.listPrice).filter((v) => v != null);
    const rItems = (d.repair && d.repair.items) || [];
    const repairSum = d.repair && d.repair.totalPrice != null ? d.repair.totalPrice : (rItems.length && rItems.every((x) => x.price != null) ? rItems.reduce((t, x) => t + x.price, 0) : null);
    QUOTES[token] = { phone: to, lang: s.lang, quoteNumber: s.quoteNo, no: s.quoteNo, customer: d.meta.homeowner || '', address: d.meta.addressLine1 || '', price: listPrices.length ? Math.min(...listPrices) : repairSum, url, confirm: buildConfirm(d, s), created: Date.now() };
    saveQuotes();
    s.stage = 'done'; s.awaiting = null;
    const notes = buildNotes(s, d.flags);
    if (notes.text) {
      if (notes.hasBlanks) await sendButtons(to, notes.text, [{ id: 'add', title: btn(s, 'add') }]);
      else await sendText(to, notes.text);
    }
    await sendButtons(to, tx(s, 'ready', url), [{ id: 'change', title: btn(s, 'edit') }, { id: 'newquote', title: btn(s, 'newq') }]);
    await sendDocument(to, url, fileName, `Estimate Proposal ${s.quoteNo}`);
    const pr = getProfile(to);
    if (!pr || !pr.offered) {
      saveProfile(to, { ...(pr || {}), offered: true });
      setTimeout(() => {
        s.queue = s.queue.then(() => sendButtons(to, tx(s, 'offerSetup'), [{ id: 'setup', title: btn(s, 'setupNow') }, { id: 'setup:later', title: btn(s, 'notNow') }])).catch((e) => console.error('❌ offer error:', e));
      }, OFFER_DELAY_MS);
    }
  } catch (err) {
    console.error('❌ Report build error:', err);
    s.stage = 'confirm';
    await sendText(to, tx(s, 'hiccup'));
  }
}

// ----- Acceptance confirmation: what the customer agreed to, kept with the quote at the moment the report is built -----
const moneyC2 = (n) => '$' + Number(n).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const moneyC = (n) => {
  const v = Number(n);
  return '$' + (Number.isInteger(v) ? v.toLocaleString('en-US') : v.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 }));
};
const pdfSafe = (t) => String(t == null ? '' : t).replace(/[^\n\x20-\x7E\u00A0-\u00FF\u2013\u2014\u2018-\u201D\u2022\u20AC]/g, '?');
let pdfKitLib = null;
function pdfkit() {
  if (pdfKitLib === null) {
    try { pdfKitLib = require('pdfkit'); } catch (e) { console.error('ℹ️ pdfkit is not installed, so acceptance confirmations will not be created:', e.message); pdfKitLib = false; }
  }
  return pdfKitLib;
}

function scopeBullets(d) {
  const T = d.terms || {};
  if (d.meta && d.meta.jobType === 'repair') {
    const items = ((d.repair || {}).items || []).map((i) => `${i.name}${i.price != null ? ` (${moneyC(i.price)})` : ''}`);
    return [...items, 'Repairs fix the areas listed. They do not renew the rest of the roof.'];
  }
  const m = d.measurements;
  const ft = (n) => (n == null ? null : `${Number(n).toLocaleString('en-US')} ft`);
  const area = d.meta && Number(d.meta.areaSqFt) > 0 ? `${Number(d.meta.areaSqFt).toLocaleString('en-US')} sq ft` : 'the full roof';
  return [
    'Tear-off of all existing layers to the deck',
    `New shingles, ${area}`,
    `Damaged deck wood replaced as needed, up to ${T.woodPct != null ? T.woodPct : 20}%`,
    'Synthetic underlayment',
    m && ft(m.drip) ? `New drip edge, ${ft(m.drip)}` : 'New drip edge at every eave and rake',
    m && ft(m.valleys) ? `New valley lining, ${ft(m.valleys)}` : 'New valley lining',
    m && ft(m.step) ? `New step flashing, ${ft(m.step)}` : 'New flashing at walls and vents',
    m && (m.hips != null || m.ridges != null) ? `New hip and ridge caps, ${ft((m.hips || 0) + (m.ridges || 0))}` : 'New hip and ridge caps throughout',
    'New flashed boots at every pipe',
    'Manufacturer warranty on materials',
    ...(T.timelineDays ? [`Job complete in up to ${T.timelineDays} days`] : []),
    'Clean-up and magnetic nail sweep'
  ];
}

function buildConfirm(d, s) {
  const D = d.discount;
  const finalOf = (list) => (list == null ? null : (D ? Math.round(list * (1 - D.pct / 100)) : list));
  let options;
  if (d.meta.jobType === 'repair') {
    const items = (d.repair && d.repair.items) || [];
    const sum = d.repair && d.repair.totalPrice != null ? d.repair.totalPrice : (items.length && items.every((x) => x.price != null) ? items.reduce((t, x) => t + x.price, 0) : null);
    options = [{ name: 'Repair quote', list: sum, final: finalOf(sum), labor: d.repair ? d.repair.laborYears : null }];
  } else {
    options = (d.options || []).map((o) => ({ name: o.name, shingle: o.shingle, mfr: o.mfrWarranty, labor: o.laborYears, list: o.listPrice, final: finalOf(o.listPrice) }));
  }
  const b = d.meta.brand || {};
  return {
    company: d.meta.company, phone: b.phone || '', license: b.license || '', color: b.color || '', logoFile: (s.profile || {}).logoFile || '',
    homeowner: d.meta.homeowner, address: [d.meta.addressLine1, d.meta.addressLine2].filter(Boolean).join(', '), reportNo: d.meta.reportNo, reportDate: d.meta.date,
    jobType: d.meta.jobType, options, discount: D ? { pct: D.pct, name: D.name } : null, terms: d.terms, scope: scopeBullets(d)
  };
}

function payRows(final, t) {
  const p = Number(final);
  if (t.paymentMode === 'on_completion') return [['On completion, after final inspection', p]];
  if (t.paymentMode === 'deposit_balance') {
    const dep = Math.min(p, t.depositPct != null ? Math.round(p * t.depositPct / 100) : t.deposit);
    return [['At signing (deposit)', dep], ['On completion, after final inspection', +(p - dep).toFixed(2)]];
  }
  const dep = Math.min(p, t.deposit != null ? t.deposit : 1000);
  const bal = Math.max(0, p - dep);
  return [['At signing (deposit)', dep], ['Start of demolition (40% of the balance)', +(bal * 0.4).toFixed(2)], ['Material delivery (30%)', +(bal * 0.3).toFixed(2)], ['Materials installed (25%)', +(bal * 0.25).toFixed(2)], ['Final inspection (5%)', +(bal * 0.05).toFixed(2)]];
}

// One clean page: who accepted what, for how much, when, and on which terms.
function writeConfirmationPdf(file, c, acc, reportUrl, token, chosen) {
  return new Promise((resolve, reject) => {
    try {
      const PDFDocument = pdfkit();
      if (!PDFDocument) return reject(new Error('pdfkit is not installed'));
      const doc = new PDFDocument({ size: 'LETTER', margin: 54, info: { Title: pdfSafe(`Acceptance confirmation ${c.reportNo}`), Author: pdfSafe(c.company) } });
      const out = fs.createWriteStream(file);
      out.on('finish', resolve); out.on('error', reject);
      doc.pipe(out);
      const L = 54; const W = doc.page.width - 108;
      const accent = /^#[0-9a-f]{6}$/i.test(c.color || '') ? c.color : '#CE4E1B';
      const gray = '#687176'; const ink = '#111517'; const ruleC = '#DED7CC';
      const t = pdfSafe;
      const T = c.terms || {};
      let logo = false;
      const lp = c.logoFile ? path.join(LOGO_DIR, c.logoFile) : '';
      if (lp && fs.existsSync(lp)) { try { doc.image(lp, L, 54, { fit: [170, 44] }); logo = true; } catch (e) { logo = false; } }
      if (!logo) doc.font('Helvetica-Bold').fontSize(15).fillColor(ink).text(t(c.company).toUpperCase(), L, 60, { width: W * 0.65 });
      doc.font('Helvetica').fontSize(9).fillColor(gray).text(t([c.license ? `Lic. ${c.license}` : '', c.phone].filter(Boolean).join('   |   ')), L, 60, { width: W, align: 'right' });
      doc.rect(L, 102, 36, 3).fill(accent);
      doc.font('Helvetica').fontSize(25).fillColor(ink).text('Acceptance confirmation', L, 112);
      doc.font('Helvetica').fontSize(11).fillColor(gray).text(t(`Report ${c.reportNo}  |  ${c.address}`), L, doc.y + 2, { width: W });

      const section = (title) => {
        doc.moveDown(0.7);
        doc.font('Helvetica-Bold').fontSize(8.5).fillColor(gray).text(title.toUpperCase(), L, doc.y, { width: W, characterSpacing: 1 });
        doc.moveDown(0.2);
        const y = doc.y;
        doc.moveTo(L, y).lineTo(L + W, y).lineWidth(0.6).strokeColor(ruleC).stroke();
        doc.moveDown(0.35);
      };
      const kv = (k, v, bold) => {
        const y0 = doc.y;
        doc.font('Helvetica').fontSize(10).fillColor(gray).text(t(k), L, y0, { width: 125 });
        const y1 = doc.y;
        doc.font(bold ? 'Helvetica-Bold' : 'Helvetica').fontSize(10.5).fillColor(ink).text(t(v), L + 130, y0, { width: W - 130 });
        doc.y = Math.max(y1, doc.y) + 2;
      };
      const amt = (k, v, bold) => {
        const y0 = doc.y;
        doc.font(bold ? 'Helvetica-Bold' : 'Helvetica').fontSize(10.5).fillColor(ink).text(t(k), L, y0, { width: W - 130 });
        const y1 = doc.y;
        doc.text(t(v), L + W - 120, y0, { width: 120, align: 'right' });
        doc.y = Math.max(y1, doc.y) + 2;
      };

      const when = acc.localTime ? `${acc.localTime}${acc.tz ? ` (${acc.tz})` : ''}` : new Date(acc.when).toISOString().replace('T', ' ').slice(0, 16) + ' UTC';
      section('Accepted');
      kv('Accepted by', acc.name, true);
      kv('Accepted on', when);
      kv('Contractor', c.company);

      section('What was accepted');
      const o = chosen || {};
      kv('Option', o.name || acc.option, true);
      if (o.shingle) kv('Shingles', o.shingle);
      if (o.mfr) kv('Manufacturer warranty', String(o.mfr).replace(/ manufacturer warranty$/i, ''));
      if (o.labor != null) kv('Labor warranty', `${o.labor} years`);
      doc.moveDown(0.3);
      if (c.discount && o.list != null) {
        amt('List price', moneyC(o.list));
        amt(`${c.discount.name ? c.discount.name.charAt(0).toUpperCase() + c.discount.name.slice(1) + ' discount' : 'Discount'} (${c.discount.pct}%)`, `-${moneyC(o.list - o.final)}`);
      }
      amt('Price accepted', moneyC(acc.price != null ? acc.price : o.final), true);

      if (acc.price != null) {
        section('Payment');
        payRows(acc.price, T).forEach(([k, v]) => amt(k, moneyC2(v)));
      }

      section('Scope of work');
      const sc = c.scope || [];
      const half = Math.ceil(sc.length / 2);
      const top = doc.y; let bottom = top;
      [sc.slice(0, half), sc.slice(half)].forEach((col, k) => {
        doc.y = top;
        col.forEach((b) => { doc.font('Helvetica').fontSize(9.5).fillColor(ink).text(`\u2022  ${t(b)}`, L + 4 + k * (W / 2), doc.y, { width: W / 2 - 14 }); doc.moveDown(0.12); });
        bottom = Math.max(bottom, doc.y);
      });
      doc.y = bottom;

      section('Terms');
      const terms = [];
      if (T.timelineDays) terms.push(`The job is complete in up to ${T.timelineDays} days${c.jobType === 'repair' ? '' : ' from the start of demolition'}, weather permitting.`);
      terms.push('Nothing outside this scope is done without a written change order signed by the homeowner, with the price stated first.');
      if (c.jobType !== 'repair') terms.push(`Damaged wood beyond ${T.woodPct != null ? T.woodPct : 20}% of the deck is shown to the homeowner and priced in writing before it is replaced.`);
      terms.push(`The quoted price holds for ${T.validityDays || 30} days from ${c.reportDate}.`);
      terms.forEach((x) => { doc.font('Helvetica').fontSize(9.5).fillColor(ink).text(t(x), L, doc.y, { width: W }); doc.moveDown(0.15); });

      section('Acceptance record');
      doc.font('Helvetica').fontSize(10.5).fillColor(ink).text(t(`I agree to the scope of work, price and terms in report ${c.reportNo}.`), L, doc.y, { width: W });
      doc.moveDown(0.25);
      kv('Signed (typed name)', acc.name, true);
      kv('Date and time', when);
      kv('Confirmation ID', crypto.createHash('sha256').update(String(token)).digest('hex').slice(0, 10).toUpperCase());

      doc.moveDown(0.3);
      doc.font('Helvetica').fontSize(8.5).fillColor(gray).text(t(`Typed-name acceptance, recorded electronically. Keep this page with your copy of the full report.${reportUrl ? `\nFull report: ${reportUrl}` : ''}`), L, doc.y, { width: W, lineGap: 2 });
      doc.end();
    } catch (e) { reject(e); }
  });
}

// Prices typed on their own ("20k / 25k / 30k", "20/25/30", "28000") are read by code, not guessed by the AI
function parsePriceList(text, repair) {
  const t = text.trim();
  const tokens = t.match(/\$?\d[\d,]*(?:\.\d+)?\s*k?/gi);
  if (!tokens) return null;
  const rest = t.replace(/\$?\d[\d,]*(?:\.\d+)?\s*k?/gi, '').replace(/[\s\/,&;-]|and|y\b/gi, '');
  if (rest) return null;
  let nums = tokens.map((x) => toNum(x));
  if (nums.some((n) => n == null)) return null;
  if (!repair && nums.every((n) => n < 1000)) nums = nums.map((n) => n * 1000); // "20/25/30" means thousands
  return nums;
}

// Buttons we are waiting on: understand a typed version, or gently point back to the buttons. Never guess.
async function quickAnswer(s, to, low) {
  const words = low.split(/\s+/).filter(Boolean).length;
  const bare = /^[$\d][\d,.\s]*k?$/.test(low);
  const nudge = async () => { await sendText(to, tx(s, 'nudge')); await advance(s, to); return true; };
  const done = async () => { await advance(s, to); return true; };
  switch (s.awaiting) {
    case 'type':
      if (/repl|reempl|tear/.test(low)) { s.data.job_type = 'replacement'; return done(); }
      if (/repair|repar/.test(low)) { s.data.job_type = 'repair'; return done(); }
      return words <= 3 ? nudge() : false;
    case 'source':
      if (/insur|seguro/.test(low)) { s.data.lead_source = 'insurance'; return done(); }
      if (/retail|particular|private|cash|out of pocket/.test(low)) { s.data.lead_source = 'retail'; return done(); }
      return words <= 3 ? nudge() : false;
    case 'stories': {
      const m = low.match(/^(\d+|one|two|three|un|uno|dos|tres)\b/);
      const map = { one: 1, un: 1, uno: 1, two: 2, dos: 2, three: 3, tres: 3 };
      if (m) { const n = Number(m[1]) || map[m[1]]; s.data.building_stories = n === 1 ? '1 story' : `${n} stories`; return done(); }
      return words <= 3 ? nudge() : false;
    }
    case 'leaks':
      if (/^(yes|yeah|yep|si|sí)\b/.test(low)) { s.data.leaks = 'yes'; return done(); }
      if (/^(no|nope|none|nada)\b/.test(low)) { s.data.leaks = 'no'; return done(); }
      if (/(not sure|unknown|no s[eé]|don'?t know|idk)/.test(low)) { s.data.leaks = 'unknown'; return done(); }
      return words <= 3 ? nudge() : false;
    case 'condition':
      if (/serv|good|fine|ok\b|aceptable|bien/.test(low)) { s.data.condition = 'serviceable'; return done(); }
      if (/monitor|fair|aging|watch|vigil|regular/.test(low)) { s.data.condition = 'monitor'; return done(); }
      if (/end|shot|worn|dead|bad|fin de vida|mal/.test(low)) { s.data.condition = 'end_of_life'; return done(); }
      return words <= 3 ? nudge() : false;
    case 'extras':
      return bare ? nudge() : false;
    default:
      return false;
  }
}

// =============================================================================
// 7. HANDLING WHAT THE CONTRACTOR SENDS
// =============================================================================
const SKIP_RE = /^(skip|omitir|saltar|no|none|nothing|nope|n\/a|nada|ninguno|no sé|no se|i don'?t know|idk|dont know)\.?$/i;
const BUILD_RE = /^(generate|build|done|send it|create|genera|generar|listo|crear)( it| report| quote)?\.?$/i;
const NEW_RE = /^(new quote|new|start over|reset|nueva cotizaci[oó]n|nueva|empezar de nuevo)\.?$/i;
const MYQ_RE = /^(my quotes|quotes|history|my reports|mis cotizaciones|historial|mis informes)$/i;
const ENROLL_RE = /^(company|logo|my company|company name|empresa|mi empresa)$/i;
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
    case 'claim': case 'area': case 'stories': case 'leaks': case 'condition': s.skipped.add(s.awaiting); break;
    case 'price': return sendText(to, tx(s, isRepair(s) ? 'needPriceRpr' : 'needPriceRep'));
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
  const needs = { 'type:': 'type', 'src:': 'source', 'st:': 'stories', 'lk:': 'leaks', 'cd:': 'condition' };
  for (const [prefix, q] of Object.entries(needs)) if (id.startsWith(prefix) && s.awaiting !== q) return null; // an old button: ignore
  if (id.startsWith('cd:')) s.data.condition = id.slice(3);
  if (id === 'type:replacement' || id === 'type:repair') s.data.job_type = id.split(':')[1];
  if (id === 'st:1' || id === 'st:2') s.data.building_stories = id === 'st:1' ? '1 story' : '2 stories';
  if (id.startsWith('lk:')) s.data.leaks = id.split(':')[1];
  if (id === 'src:retail' || id === 'src:insurance') s.data.lead_source = id.split(':')[1];
  if (s.stage === 'done') return null;
  return advance(s, to);
}

async function onText(s, to, text, host, phone) {
  if (s.stage === 'building') return; // a report is being written; ignore chatter until it is sent
  const low = text.trim().toLowerCase();

  if (NEW_RE.test(low)) return startOver(s, to, phone);
  if (MYQ_RE.test(low)) return showMyQuotes(s, to);
  if (ENROLL_RE.test(low)) return startEnroll(s, to, true);
  if (SETUP_RE.test(low)) return startSetup(s, to);
  if (s.stage === 'setup') return setupText(s, to, text);
  if (s.stage === 'new') {
    s.stage = 'collect';
    if (GREET_RE.test(low)) { await sendText(to, tx(s, 'hello', firstName(s.contractorName))); return; }
  }
  if (s.stage === 'collect' && SKIP_RE.test(low) && !(s.awaiting === 'leaks' && /^(no|nope|none|nada)$/.test(low))) return skipCurrent(s, to);
  if (s.stage === 'collect' && BUILD_RE.test(low)) return showConfirm(s, to);
  if (s.stage === 'confirm' && BUILD_RE.test(low)) return doBuild(s, to, host);

  // Quick path for a bare number when we asked for the area (no AI call needed)
  if (s.awaiting === 'area' && /^[\d,.\s]+(sq\s?ft|sf|ft2|pies)?$/i.test(low)) {
    const n = toNum(low.replace(/(sq\s?ft|sf|ft2|pies)/i, ''));
    if (n) { s.data.roof_area_sqft = n; return advance(s, to); }
  }

  if (s.stage === 'collect' && s.awaiting === 'price') {
    const nums = parsePriceList(text, isRepair(s));
    if (nums && nums.length) {
      if (isRepair(s)) { if (nums.length === 1) { s.data.repair.total_price = nums[0]; return advance(s, to); } }
      else if (nums.length <= 3) { nums.forEach((n, i) => { s.data.tiers[['good', 'better', 'best'][i]].price = n; }); return advance(s, to); }
    }
  }
  if (s.stage === 'collect' && (await quickAnswer(s, to, low))) return null;

  // A plain typed answer to a single simple question counts even if the AI reader misses it
  if (s.awaiting === 'claim' && text.trim().length <= 40 && !SKIP_RE.test(low)) { s.data.claim_number = text.trim(); return advance(s, to); }

  const ex = await extract(s, text);
  if (ex.language === 'es' || ex.language === 'en') { if (text.trim().split(/\s+/).length >= 2) s.lang = ex.language; }
  if (ex.intent === 'new_quote') return startOver(s, to, phone);
  const changed = merge(s.data, ex.updates);
  const tu = ex.updates.tiers || {};
  if (tu.good && tu.good.price != null) {
    if (!(tu.better && tu.better.price != null)) delete s.data.tiers.better.price;
    if (!(tu.best && tu.best.price != null)) delete s.data.tiers.best.price;
  }
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
  return advance(s, to);
}

async function onImage(s, to, message) {
  if (s.stage === 'setup' && s.awaiting === 'setup_logo') {
    const logo = await downloadWhatsAppImage(message.image.id);
    const stored = logo ? saveLogo(to, logo) : null;
    if (stored) s.draft.logoFile = stored;
    return setupNext(s, to);
  }
  if (/measure|medici[oó]n|eagleview|quickmeasure|hover|roofr/i.test(message.image.caption || '')) return onMeasurement(s, to, { id: message.image.id, mime: 'image/jpeg' });
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
  if (s.stage === 'building' || s.stage === 'enroll') return;
  const ack = tx(s, 'gotPhotos', s.images.length);
  if (s.stage === 'done') { s.report = null; return doBuild(s, to, s.host); } // new photos: rewrite the findings
  if (s.awaiting && s.awaiting !== 'photo' && s.awaiting !== 'confirm') return sendText(to, ack);
  if (s.awaiting === 'confirm') return sendText(to, ack);
  await sendText(to, ack);
  return advance(s, to);
}

// ----- Roof measurement report (PDF). Created ONLY when the contractor uploads one. -----
const MEASURE_PROMPT = `You read a roof measurement report (GAF QuickMeasure, EagleView, Hover, Roofr or similar). Return ONLY JSON:
{"is_measurement_report": true, "source": "GAF QuickMeasure", "report_date": "17 September 2026", "structures": [{"name": "Main house", "area_sqft": 1877, "facets": 9, "pitch": "5/12", "low_slope_area_sqft": 64, "ridges_ft": 91, "hips_ft": 0, "valleys_ft": 66, "rakes_ft": 119, "eaves_ft": 95, "bends_ft": 8, "drip_edge_ft": 215, "step_flashing_ft": 28, "other_flashing_ft": 6}], "total_area_sqft": 1877, "diagram_page": 2}
RULES: copy ONLY numbers that are printed in the report. Use null for anything not printed. Never calculate, round, estimate or invent a number. If the report lists several structures, list each one. "pitch" is the predominant pitch like "5/12". "diagram_page" is the 1-based number of the page that shows the roof drawing with edge lengths, or null. If the file is NOT a roof measurement report, return {"is_measurement_report": false}.`;
const BOX_PROMPT = 'This is one page of a roof measurement report. Return ONLY JSON {"box": [ymin, xmin, ymax, xmax]} with coordinates from 0 to 1000: a tight box around the roof drawing (the diagram with edge lengths and its colour legend). Exclude page headers, titles, tables and logos. If there is no roof drawing, return {"box": null}.';

let pdfTools = null; let pdfToolsTried = false;
async function loadPdfTools() {
  if (pdfToolsTried) return pdfTools;
  pdfToolsTried = true;
  try {
    pdfTools = { pdfjs: await import('pdfjs-dist/legacy/build/pdf.mjs'), createCanvas: require('@napi-rs/canvas').createCanvas };
  } catch (e) {
    console.error('ℹ️ PDF diagram tools are not installed, so the measurement diagram will be skipped:', e.message);
    pdfTools = null;
  }
  return pdfTools;
}

// Renders the page that holds the roof drawing, asks Gemini where the drawing is, and crops it.
async function cropDiagram(buffer, pageNum) {
  const tools = await loadPdfTools();
  if (!tools) return null;
  const doc = await tools.pdfjs.getDocument({ data: new Uint8Array(buffer), useSystemFonts: true, verbosity: 0 }).promise;
  if (!Number.isInteger(pageNum) || pageNum < 1 || pageNum > doc.numPages) return null;
  const page = await doc.getPage(pageNum);
  const vp = page.getViewport({ scale: 2.2 });
  const canvas = tools.createCanvas(Math.floor(vp.width), Math.floor(vp.height));
  await page.render({ canvasContext: canvas.getContext('2d'), viewport: vp, canvas }).promise;
  const data = await callGemini({
    system: BOX_PROMPT,
    parts: [{ inline_data: { mime_type: 'image/jpeg', data: canvas.toBuffer('image/jpeg', 70).toString('base64') } }, { text: 'Return the box.' }],
    temperature: 0
  });
  const raw = geminiText(data);
  const box = raw ? parseJsonText(raw).box : null;
  if (!Array.isArray(box) || box.length !== 4 || box.some((n) => typeof n !== 'number')) return null;
  const [y0, x0, y1, x1] = box.map((n) => Math.max(0, Math.min(1000, n)));
  if (y1 - y0 < 80 || x1 - x0 < 80) return null; // too small to be a drawing
  const pad = 15;
  const sx = Math.floor(canvas.width * Math.max(0, x0 - pad) / 1000), sy = Math.floor(canvas.height * Math.max(0, y0 - pad) / 1000);
  const sw = Math.floor(canvas.width * Math.min(1000, x1 + pad) / 1000) - sx, sh = Math.floor(canvas.height * Math.min(1000, y1 + pad) / 1000) - sy;
  const out = tools.createCanvas(sw, sh);
  out.getContext('2d').drawImage(canvas, sx, sy, sw, sh, 0, 0, sw, sh);
  return out.toBuffer('image/jpeg', 85);
}

async function readMeasurementReport(buffer, mime) {
  const data = await callGemini({
    system: MEASURE_PROMPT,
    parts: [{ inline_data: { mime_type: mime, data: buffer.toString('base64') } }, { text: 'Read this report and return the JSON.' }],
    temperature: 0
  });
  const raw = geminiText(data);
  if (!raw) throw new Error('Measurement reader returned nothing');
  const j = parseJsonText(raw);
  if (!j.is_measurement_report) return { notReport: true };
  const keys = ['area_sqft', 'facets', 'low_slope_area_sqft', 'ridges_ft', 'hips_ft', 'valleys_ft', 'rakes_ft', 'eaves_ft', 'bends_ft', 'drip_edge_ft', 'step_flashing_ft', 'other_flashing_ft'];
  const structures = (Array.isArray(j.structures) ? j.structures : []).map((x) => {
    const o = { name: String(x.name || '').trim() || null, pitch: x.pitch ? String(x.pitch).trim() : null };
    keys.forEach((k) => { o[k] = toNum(x[k]); });
    return o;
  }).filter((x) => keys.some((k) => x[k] != null));
  let total = toNum(j.total_area_sqft);
  if (total == null && structures.length && structures.every((x) => x.area_sqft != null)) total = structures.reduce((a, x) => a + x.area_sqft, 0);
  if (!structures.length && total == null) return { notReport: true };
  let diagramFile = null;
  if (mime === 'application/pdf' && j.diagram_page) {
    try {
      const jpg = await cropDiagram(buffer, Number(j.diagram_page));
      if (jpg) { diagramFile = `diagram_${crypto.randomBytes(6).toString('hex')}.jpg`; fs.writeFileSync(path.join(publicDir, diagramFile), jpg); }
    } catch (e) { console.error('ℹ️ Diagram skipped:', e.message); }
  }
  return { source: String(j.source || '').trim() || null, date: String(j.report_date || '').trim() || null, structures, total_area_sqft: total, diagramFile };
}

async function onMeasurement(s, to, file) {
  await sendText(to, tx(s, 'readingMeasure'));
  let r;
  try {
    const media = await fetchMedia(file.id);
    if (media.buffer.length > 15 * 1024 * 1024) throw new Error('File too large');
    r = await readMeasurementReport(media.buffer, file.mime || media.mime);
  } catch (err) {
    console.error('❌ Measurement report error:', err);
    return sendText(to, tx(s, 'measureFail'));
  }
  if (r.notReport) return sendText(to, tx(s, 'notMeasure'));
  s.data.measurement = r;
  if (r.total_area_sqft) s.data.roof_area_sqft = r.total_area_sqft;
  const pitch = (r.structures.find((x) => x.pitch) || {}).pitch;
  if (pitch && !s.data.pitch) s.data.pitch = pitch;
  await sendText(to, tx(s, 'measureOk', measureLine(s)));
  if (s.stage === 'building') return null;
  if (s.stage === 'done') return doBuild(s, to, s.host);
  if (s.stage === 'confirm' || s.stage === 'changing') { s.stage = 'confirm'; return showConfirm(s, to); }
  if (s.stage === 'new') s.stage = 'collect';
  if (!s.awaiting || s.awaiting === 'area') return advance(s, to);
  return null;
}

async function onDocument(s, to, message) {
  const doc = message.document || {};
  const isPdf = String(doc.mime_type || '').toLowerCase() === 'application/pdf' || /\.pdf$/i.test(doc.filename || '');
  if (!isPdf) return sendText(to, tx(s, 'pdfOnly'));
  return onMeasurement(s, to, { id: doc.id, mime: 'application/pdf' });
}

// Turns what the report said into the pieces the template shows. Called only when a report was uploaded.
function applyMeasurement(d, m) {
  const st = m.structures || [];
  const sum = (k) => (st.some((x) => x[k] != null) ? st.reduce((a, x) => a + (x[k] || 0), 0) : null);
  d.measurements = { ridges: sum('ridges_ft'), hips: sum('hips_ft'), valleys: sum('valleys_ft'), rakes: sum('rakes_ft'), eaves: sum('eaves_ft'), bends: sum('bends_ft'), drip: sum('drip_edge_ft'), step: sum('step_flashing_ft'), flash: sum('other_flashing_ft') };
  const fmt = (n) => Number(n).toLocaleString('en-US');
  const multi = st.length > 1;
  const facets = sum('facets');
  const pitch = (st.find((x) => x.pitch) || {}).pitch || null;
  const total = m.total_area_sqft != null ? m.total_area_sqft : sum('area_sqft');
  if (total != null) d.meta.areaSqFt = total;
  if (pitch) d.meta.pitch = pitch;
  d.meta.facets = facets;
  d.meta.measureSource = m.source || 'the measurement report';
  d.meta.measureDate = m.date || '';
  if (multi && st.every((x) => x.area_sqft != null)) d.meta.areaNote = st.map((x, i) => `${(x.name || `structure ${i + 1}`).toLowerCase()} ${fmt(x.area_sqft)}`).join(' · ');
  d.meta.pitchNote = facets ? `${facets} facets${multi ? ', all structures' : ''}` : '';
  if (pitch) d.meta.roofBit = multi ? `${pitch} main pitch` : `${pitch} pitch`;
  const rowsOf = (x) => [
    ['Roof area', x.area_sqft != null ? `${fmt(x.area_sqft)} sq ft` : null], ['Roof facets', x.facets], ['Predominant pitch', x.pitch],
    ['Low-slope area', x.low_slope_area_sqft != null ? `${fmt(x.low_slope_area_sqft)} sq ft` : null],
    ['Ridges', x.ridges_ft], ['Hips', x.hips_ft], ['Valleys', x.valleys_ft], ['Rakes', x.rakes_ft], ['Eaves', x.eaves_ft], ['Bends', x.bends_ft],
    ['Drip edge', x.drip_edge_ft], ['Step flashing', x.step_flashing_ft], ['Other flashing', x.other_flashing_ft]
  ].filter((r) => r[1] != null && r[1] !== '').map(([k, v]) => [k, typeof v === 'number' && !['Roof facets'].includes(k) ? `${fmt(v)} ft` : String(v)]);
  let diagramSrc = '';
  try { if (m.diagramFile) diagramSrc = `data:image/jpeg;base64,${fs.readFileSync(path.join(publicDir, m.diagramFile)).toString('base64')}`; } catch (e) { diagramSrc = ''; }
  d.measuredPage = {
    intro: `The roof was measured by ${m.source || 'the report supplied'}${m.date ? `, ${m.date}` : ''}. Every quantity in the pricing comes from these figures.`,
    diagramSrc, diagramCaption: `Roof lengths${m.source ? ` · ${m.source}` : ''}`,
    groups: st.map((x, i) => ({ title: x.name || (multi ? `Structure ${i + 1}` : 'Roof'), source: m.source || '', rows: rowsOf(x) })).filter((g) => g.rows.length),
    total: multi && total != null ? ['Total roof area', `${fmt(total)} sq ft`] : null
  };
}

// ----- Enrollment: a first-time contractor gives the company name (required) and a logo (optional) before the first job -----
function needsEnrollment(phone) {
  const p = getProfile(phone);
  if (p && p.company) return false;
  if (AUTO_ENROLL) { saveProfile(phone, { ...(p || {}), company: AUTO_ENROLL }); return false; }
  return true;
}

// The logo lives with the profile, not in the public folder
function saveLogo(phone, publicFile) {
  try {
    const name = `${String(phone).replace(/\D/g, '')}.jpg`;
    fs.copyFileSync(path.join(publicDir, publicFile), path.join(LOGO_DIR, name));
    try { fs.unlinkSync(path.join(publicDir, publicFile)); } catch (e) { /* the copy is what matters */ }
    return name;
  } catch (e) {
    console.error('❌ Could not save logo:', e.message);
    return null;
  }
}

async function startEnroll(s, to, change = false) {
  s.prevStage = s.stage === 'enroll' ? s.prevStage : s.stage;
  s.stage = 'enroll';
  s.awaiting = 'enroll_company';
  s.enroll = { company: null, logoFile: null, change };
  if (!change) await sendText(to, tx(s, 'enrollWelcome'));
  return sendText(to, tx(s, 'sCompany'));
}

const askLogo = (s, to) => sendButtons(to, tx(s, 'qLogo', s.enroll.company), [{ id: 'logo:none', title: btn(s, 'noLogo') }]);

async function enrollText(s, to, text) {
  const t = text.trim();
  const low = t.toLowerCase();
  if (s.awaiting === 'enroll_company') {
    if (GREET_RE.test(low) || SKIP_RE.test(low) || t.length < 2) return sendText(to, tx(s, 'needCompany'));
    s.enroll.company = t.replace(/\s+/g, ' ').slice(0, 80);
    s.awaiting = 'enroll_logo';
    return askLogo(s, to);
  }
  if (/^(no|none|skip|omitir|no logo|sin logo|nope)$/.test(low)) return finishEnroll(s, to);
  await sendText(to, tx(s, 'nudge'));
  return askLogo(s, to);
}

async function enrollButton(s, to, id) {
  if (id === 'logo:none' && s.awaiting === 'enroll_logo') return finishEnroll(s, to);
  return null;
}

async function enrollLogo(s, to, message) {
  const f = await downloadWhatsAppImage(message.image.id);
  if (f) s.enroll.logoFile = saveLogo(to, f);
  return finishEnroll(s, to);
}

async function finishEnroll(s, to) {
  const e = s.enroll;
  const next = { ...(getProfile(to) || {}), company: e.company };
  if (e.logoFile) next.logoFile = e.logoFile; else delete next.logoFile;
  saveProfile(to, next);
  s.profile = getProfile(to);
  s.enroll = null;
  await sendText(to, tx(s, 'enrollDone', e.company, Boolean(e.logoFile)));
  if (e.change) { s.stage = s.prevStage && s.prevStage !== 'new' ? s.prevStage : 'collect'; s.awaiting = null; return null; }
  s.stage = 'collect';
  s.awaiting = null;
  if (s.images.length) { await sendText(to, tx(s, 'gotPhotos', s.images.length)); return advance(s, to); } // photos sent before enrolling are kept
  return sendText(to, tx(s, 'hello', firstName(s.contractorName)));
}

// ----- "my quotes": the contractor's remembered reports, newest first -----
async function showMyQuotes(s, to) {
  const byNo = {};
  for (const q of Object.values(QUOTES)) {
    if (q.phone !== to || !q.no) continue;
    const cur = byNo[q.no];
    byNo[q.no] = { ...(!cur || q.created > cur.created ? q : cur), accepted: q.accepted || (cur && cur.accepted) || null };
  }
  const mine = Object.values(byNo).sort((x, y) => y.created - x.created).slice(0, 5);
  if (!mine.length) return sendText(to, tx(s, 'myQuotesNone'));
  const lines = mine.map((q) => `${q.no} · ${q.customer || '—'} · ${q.address || ''}${q.price != null ? ` · ${money(q.price)}` : ''} · ${q.accepted ? tx(s, 'qAccepted') : tx(s, 'qSent')}${q.url ? `\n${q.url}` : ''}${q.accepted && q.accepted.confirmUrl ? `\n📄 ${q.accepted.confirmUrl}` : ''}`);
  return sendText(to, `${tx(s, 'myQuotesHead')}\n\n${lines.join('\n\n')}`);
}

// ----- One-time setup: company, usual shingles and warranties, how you get paid, look of the reports -----
const SETUP_ORDER = ['setup_rep', 'setup_shingles', 'setup_years', 'setup_mfr', 'setup_pay', 'setup_theme', 'setup_brand', 'setup_phone', 'setup_license', 'setup_color', 'setup_logo'];

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
    case 'setup_brand': return sendButtons(to, tx(s, 'sBrand'), [{ id: 'brand:yes', title: btn(s, 'addBrand') }, { id: 'brand:no', title: btn(s, 'notNow') }]);
    case 'setup_phone': return sendButtons(to, tx(s, 'sPhone'), [skip]);
    case 'setup_license': return sendButtons(to, tx(s, 'sLicense'), [skip]);
    case 'setup_color': return sendButtons(to, tx(s, 'sColor'), [{ id: 'color:#1a5fb4', title: btn(s, 'blue') }, { id: 'color:#2b7a4b', title: btn(s, 'green') }, skip]);
    case 'setup_logo': return sendButtons(to, tx(s, 'sLogo'), [skip]);
    default: return sendButtons(to, tx(s, 'sTheme'), [{ id: 'theme:day', title: btn(s, 'themeDay') }, { id: 'theme:dark', title: btn(s, 'themeDark') }, { id: 'theme:blush', title: btn(s, 'themeBlush') }]);
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
  if (s.awaiting === 'setup_brand') return /^(y|yes|si|sí|ok|add)/i.test(t) ? setupNext(s, to) : finishSetup(s, to);
  if (s.awaiting === 'setup_phone') { s.draft.phone = t.slice(0, 30); return setupNext(s, to); }
  if (s.awaiting === 'setup_license') { s.draft.license = t.slice(0, 40); return setupNext(s, to); }
  if (s.awaiting === 'setup_color') {
    const named = { blue: '#1a5fb4', green: '#2b7a4b', red: '#c0392b', orange: '#ce4e1b', black: '#111517', purple: '#6f42c1', teal: '#0f766e', azul: '#1a5fb4', verde: '#2b7a4b', rojo: '#c0392b' };
    const hex = t.match(/#?([0-9a-f]{6})\b/i);
    if (hex) s.draft.brandColor = `#${hex[1]}`;
    else if (named[t.toLowerCase()]) s.draft.brandColor = named[t.toLowerCase()];
    return setupNext(s, to);
  }
  if (s.awaiting === 'setup_logo') { await sendText(to, tx(s, 'nudge')); return askSetup(s, to); }
  const th = themeOf(t);
  if (th) s.draft.theme = th;
  return setupNext(s, to);
}

async function setupButton(s, to, id) {
  if (id === 'skip') return setupNext(s, to);
  const needs = { 'pay:': 'setup_pay', 'theme:': 'setup_theme', 'brand:': 'setup_brand', 'color:': 'setup_color' };
  for (const [prefix, step] of Object.entries(needs)) if (id.startsWith(prefix) && s.awaiting !== step) return null; // an old button: ignore
  if (id.startsWith('pay:')) s.draft.payment = { mode: id === 'pay:poc' ? 'on_completion' : 'standard' };
  if (id.startsWith('theme:')) s.draft.theme = id.split(':')[1];
  if (id === 'brand:no') return finishSetup(s, to);
  if (id.startsWith('color:')) s.draft.brandColor = id.slice(6);
  return setupNext(s, to);
}

async function finishSetup(s, to) {
  const profile = { ...(getProfile(to) || {}), ...s.draft, offered: true }; // keeps the saved report counter and logo
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

// ----- Downloading files the contractor sends (PDF measurement reports) -----
async function fetchMedia(mediaId) {
  const res = await fetch(`https://graph.facebook.com/v26.0/${mediaId}`, { headers: { Authorization: `Bearer ${waToken}` } });
  const data = await res.json();
  if (!data.url) throw new Error('No media URL returned by Meta');
  const r = await fetch(data.url, { headers: { Authorization: `Bearer ${waToken}` } });
  return { buffer: Buffer.from(await r.arrayBuffer()), mime: data.mime_type || 'audio/ogg' };
}

// =============================================================================
// 8. WEBHOOK
// =============================================================================
app.get('/', (req, res) => {
  if (req.query['hub.mode'] === 'subscribe' && req.query['hub.verify_token'] === verifyToken) res.status(200).send(req.query['hub.challenge']);
  else res.status(403).end();
});

app.post('/', async (req, res) => {
  if (!validSignature(req)) {
    console.error('❌ Rejected a webhook call with a missing or invalid signature');
    return res.status(401).end();
  }
  res.status(200).send('EVENT_RECEIVED');

  // One delivery can carry several messages (for example 10 photos sent together). Handle every one, in order.
  const values = [];
  for (const entry of req.body.entry || []) for (const change of entry.changes || []) if (change.value) values.push(change.value);
  if (req.body.value) values.push(req.body.value);
  const host = req.get('host');
  for (const value of values) for (const message of value.messages || []) handleIncoming(value, message, host);
});

function handleIncoming(value, message, host) {
  const phone = message.from;
  touchWindow(phone);
  const contact = (value.contacts || []).find((c) => c.wa_id === phone) || (value.contacts || [])[0];
  const name = contact?.profile?.name || 'Contractor';
  let s = getSession(phone, name);
  s.host = host;

  // One message at a time per contractor, in order
  s.queue = s.queue.then(async () => {
    s = userSessions.get(phone) || s;
    s.host = host;
    try {
      const waiting = takePending(phone);
      if (waiting.length) {
        const lines = waiting.map((p) => p.text || (p.doc ? `📄 ${p.doc.caption}` : '')).filter(Boolean);
        if (await sendText(phone, `${tx(s, 'pendingHead')}\n\n${lines.join('\n\n')}`)) {
          for (const p of waiting) if (p.doc) await sendDocument(phone, p.doc.url, p.doc.filename, p.doc.caption);
        } else waiting.forEach((p) => queuePending(phone, p.text, p.doc));
      }
      if (s.stage === 'new' && needsEnrollment(phone)) {
        if (message.type === 'text' && /^(hola|buenas|buenos|necesito|cotizaci)/i.test(message.text.body.trim())) s.lang = 'es';
        await startEnroll(s, phone);
        if (message.type === 'image') await onImage(s, phone, message); // keep photos sent first
        return;
      }
      if (s.stage === 'enroll') {
        if (message.type === 'text') await enrollText(s, phone, message.text.body);
        else if (message.type === 'interactive') await enrollButton(s, phone, (message.interactive?.button_reply || {}).id);
        else if (message.type === 'image') await (s.awaiting === 'enroll_logo' ? enrollLogo(s, phone, message) : onImage(s, phone, message));
        return;
      }
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
      } else if (message.type === 'document') {
        console.log(`📎 Document from ${name}`);
        await onDocument(s, phone, message);
      } else if (message.type === 'audio') {
        // Voice notes are not supported. Say so once, and never again in this chat.
        console.log(`ℹ️ Voice note from ${name} (not supported)`);
        if (!s.audioNoted) { s.audioNoted = true; await sendText(phone, tx(s, 'onlyThese')); }
      } else {
        // Reactions, stickers, album wrappers and other system messages: ignore quietly, but log what they were.
        console.log(`ℹ️ Ignored message type "${message.type}"`, message.errors ? JSON.stringify(message.errors) : '');
      }
    } catch (err) {
      console.error('❌ Processing error:', err);
      await sendText(phone, tx(s, 'hiccup'));
    }
  }).catch((e) => console.error('❌ Queue error:', e));
}

// The report's "Accept" button posts here. The contractor is told on WhatsApp right away.
const allowCors = (req, res, next) => {
  res.set({ 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Methods': 'POST, OPTIONS', 'Access-Control-Allow-Headers': 'Content-Type' });
  if (req.method === 'OPTIONS') return res.status(204).end();
  return next();
};
app.options('/accept', allowCors);
app.post('/accept', allowCors, async (req, res) => {
  const b = req.body || {};
  const token = String(b.token || '');
  const q = QUOTES[token];
  const name = String(b.name || '').trim().slice(0, 80);
  if (!q) return res.status(404).json({ ok: false });
  if (!b.agreed || name.length < 3) return res.status(400).json({ ok: false });
  if (q.accepted) return res.json({ ok: true, again: true, confirmationUrl: q.accepted.confirmUrl || '' });

  // The price and option come from what was stored when the report was built, never from the customer's browser.
  const opts = (q.confirm && q.confirm.options) || [];
  const chosen = opts.find((o) => o.name === b.option) || (opts.length === 1 ? opts[0] : null);
  if (opts.length && !chosen) return res.status(400).json({ ok: false });
  q.accepted = {
    name, option: chosen ? chosen.name : String(b.option || '').slice(0, 40), price: chosen ? chosen.final : toNum(b.price),
    when: new Date().toISOString(), tz: String(b.tz || '').slice(0, 60), localTime: String(b.localTime || '').slice(0, 60)
  };

  let confirmUrl = '';
  if (q.confirm) {
    try {
      const fileName = `Confirmation_${crypto.randomBytes(8).toString('hex')}.pdf`;
      await writeConfirmationPdf(path.join(publicDir, fileName), q.confirm, q.accepted, q.url || '', token, chosen);
      confirmUrl = `https://${req.get('host')}/files/${fileName}`;
      q.accepted.confirmFile = fileName;
      q.accepted.confirmUrl = confirmUrl;
    } catch (e) { console.error('❌ Could not write the confirmation PDF:', e.message); }
  }
  saveQuotes();

  const price = q.accepted.price != null ? `: ${money(q.accepted.price)}` : '';
  const lang = q.lang || 'en';
  const no = q.no || q.quoteNumber;
  const opt = `${q.accepted.option}${price}`;
  const doc = confirmUrl ? { url: confirmUrl, filename: `Acceptance_${no}.pdf`, caption: tx({ lang }, 'confirmCaption', no, name) } : null;
  notifyContractor(q.phone, tx({ lang }, 'acceptedMsg', name, no, q.address, opt, new Date().toLocaleString('en-GB')), { lang: q.lang, params: [name, no, q.address, opt] }, doc)
    .then((how) => { q.accepted.notified = how; saveQuotes(); })
    .catch((e) => console.error('❌ Could not notify the contractor:', e));
  return res.json({ ok: true, again: false, confirmationUrl: confirmUrl });
});

app.listen(port, () => console.log(`Server running on port ${port}`));
