const express = require('express');
const fs = require('fs');
const path = require('path');

const app = express();
app.use(express.json());

// Expose the public folder so WhatsApp and browsers can view files
app.use('/files', express.static(path.join(__dirname, 'public')));

const port = process.env.PORT || 3000;
const verifyToken = process.env.VERIFY_TOKEN;
const waToken = process.env.WA_TOKEN;
const waPhoneId = process.env.WA_PHONE_ID;
const geminiApiKey = process.env.GEMINI_API_KEY;

const userSessions = new Map();

const DEFAULT_STATE = {
  property_address: null,
  scope_of_work: null,
  existing_roof_material: null,
  desired_new_material: null,
  building_stories: null,
  active_leaks_or_decking_damage: null,
  insurance_or_retail: null,
  timeline: null,
  client_name: null
};

const SYSTEM_INSTRUCTION = `
You are an expert AI intake coordinator for a roofing contractor.
Guide the homeowner through this sequential intake protocol:

1. property_address: Street, city, state, zip.
2. scope_of_work: Replacement, leak repair, or new construction.
3. existing_roof_material: Current material (shingles, tile, metal, flat).
4. desired_new_material: Material to install (shingles, metal, tile).
5. building_stories: 1-story, 2-story, etc.
6. active_leaks_or_decking_damage: Active leaks or suspected wood damage.
7. insurance_or_retail: Insurance claim or cash/retail quote.
8. timeline: Emergency, 2-4 weeks, or flexible.
9. client_name: Full name and email for the estimate delivery.

Rules:
- Return ONLY valid raw JSON with keys: "collected_data", "customer_reply", and "is_complete".
- Extract incoming user details into "collected_data".
- Ask ONLY ONE question for the earliest field that is still null in "customer_reply".
- Set "is_complete": true when all 9 fields have values.
`;

// Helper: Injects collected data and expands repeating blocks in the template
function populateQuoteTemplate(templateHtml, data) {
  let html = templateHtml;

  // Expand Scope repeating block
  const scopeRegex = /<!-- REPEAT:scope -->([\s\S]*?)<!-- END:scope -->/;
  const scopeMatch = html.match(scopeRegex);
  if (scopeMatch && Array.isArray(data.scope)) {
    const block = scopeMatch[1];
    const expanded = data.scope.map(item =>
      block.replace(/{{scope_title}}/g, item.title || '').replace(/{{scope_detail}}/g, item.detail || '')
    ).join('\n');
    html = html.replace(scopeRegex, expanded);
  }

  // Expand Materials repeating block
  const matRegex = /<!-- REPEAT:materials -->([\s\S]*?)<!-- END:materials -->/;
  const matMatch = html.match(matRegex);
  if (matMatch && Array.isArray(data.materials)) {
    const block = matMatch[1];
    const expanded = data.materials.map(m =>
      block.replace(/{{material_name}}/g, m.name || '')
           .replace(/{{material_qty}}/g, m.qty || '')
           .replace(/{{material_unit_price}}/g, m.unit_price || '')
           .replace(/{{material_line_total}}/g, m.line_total || '')
    ).join('\n');
    html = html.replace(matRegex, expanded);
  }

  // Clean empty repeating blocks
  html = html.replace(/<!-- REPEAT:spots -->[\s\S]*?<!-- END:spots -->/g, '');

  // Static company brand info
  const companyDefaults = {
    company_name: "Apex Elite Roofing",
    company_tagline: "Precision Roofing & Storm Restoration",
    company_phone: "(239) 555-0199",
    company_email: "estimates@apexroofing.com",
    company_address: "Cape Coral, FL 33904",
    license_number: "CCC1332490",
    workmanship_warranty_text: "10-year defect-free installation warranty backed directly by Apex Elite Roofing.",
    manufacturer_warranty_text: "50-year non-prorated manufacturer warranty on certified architectural materials."
  };

  const merged = { ...companyDefaults, ...data };

  // Replace remaining single placeholders
  return html.replace(/{{([a-zA-Z0-9_]+)}}/g, (match, key) => (merged[key] !== undefined ? merged[key] : ''));
}

// Meta Webhook Verification (GET)
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

// Incoming WhatsApp Handler (POST)
app.post('/', async (req, res) => {
  res.status(200).send('EVENT_RECEIVED');

  const value = req.body.entry?.[0]?.changes?.[0]?.value || req.body.value;
  const message = value?.messages?.[0];

  if (!message || message.type !== 'text') return;

  const senderPhone = message.from;
  const incomingText = message.text.body;

  if (!userSessions.has(senderPhone)) {
    userSessions.set(senderPhone, {
      data: { ...DEFAULT_STATE },
      isComplete: false
    });
  }

  const session = userSessions.get(senderPhone);

  if (session.isComplete) {
    await sendWhatsAppMessage(senderPhone, "Your estimate has already been generated! An estimator will follow up with you shortly.");
    return;
  }

  try {
    const geminiUrl = `https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-flash:generateContent?key=${geminiApiKey}`;

    const geminiResponse = await fetch(geminiUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        system_instruction: { parts: [{ text: SYSTEM_INSTRUCTION }] },
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

    const geminiData = await geminiResponse.json();
    const rawAiOutput = geminiData.candidates?.[0]?.content?.parts?.[0]?.text;
    if (!rawAiOutput) return;

    const parsed = JSON.parse(rawAiOutput);
    session.data = { ...session.data, ...parsed.collected_data };
    session.isComplete = Boolean(parsed.is_complete);

    // Intake complete -> Generate the custom quote file from the template
    if (session.isComplete) {
      const quoteNumber = `Q-${Math.floor(100000 + Math.random() * 900000)}`;

      // Prepare data for template
      const fullQuoteData = {
        quote_number: quoteNumber,
        quote_date: new Date().toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' }),
        quote_valid_until: new Date(Date.now() + 30 * 86400000).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' }),
        customer_name: session.data.client_name || 'Homeowner',
        customer_phone: senderPhone,
        customer_email: 'Provided via chat',
        property_address: session.data.property_address || 'Job Site',
        roof_type: session.data.desired_new_material || session.data.existing_roof_material || 'Architectural Shingle',
        roof_age: 'Not Specified',
        roof_size_sqft: '2,400',
        stories: session.data.building_stories || '1 story',
        diagnosis_summary: `Based on your reported ${session.data.scope_of_work || 'replacement'} scope and ${session.data.active_leaks_or_decking_damage || 'no visible decking rot'}, we have prepared a full tear-off and installation schedule.`,
        subtotal: '$12,450.00',
        tax: '$871.50',
        total: '$13,321.50',
        deposit_amount: '$1,500.00',
        estimated_start_date: 'Within 2-3 weeks',
        estimated_duration: '2-3 business days',
        scope: [
          { title: "Tear-off & Deck Inspection", detail: "Remove existing roofing down to plywood substrate and inspect for moisture damage." },
          { title: "Underlayment & Flashing", detail: "Install high-temp synthetic ice/water underlayment and brand new drip edge perimeter." },
          { title: "Surface Installation", detail: `Install certified ${session.data.desired_new_material || 'architectural'} roofing per local building code.` }
        ],
        materials: [
          { material_name: "Architectural Roofing Material (Squares)", material_qty: "26", material_unit_price: "$210.00", material_line_total: "$5,460.00" },
          { material_name: "Synthetic Underlayment Rolls", material_qty: "6", material_unit_price: "$115.00", material_line_total: "$690.00" },
          { material_name: "Tear-off, Labor, & Disposal Services", material_qty: "1", material_unit_price: "$6,300.00", material_line_total: "$6,300.00" }
        ]
      };

      // Read template from root
      const templatePath = path.join(__dirname, 'roof-quote-template.html');
      const rawTemplate = fs.readFileSync(templatePath, 'utf8');

      // Hydrate placeholders
      const finalHtml = populateQuoteTemplate(rawTemplate, fullQuoteData);

      // Ensure /public exists and write file
      const publicDir = path.join(__dirname, 'public');
      if (!fs.existsSync(publicDir)) fs.mkdirSync(publicDir, { recursive: true });

      const fileName = `Roof_Quote_${quoteNumber}.html`;
      fs.writeFileSync(path.join(publicDir, fileName), finalHtml, 'utf8');

      // Build the public URL using the Render host
      const host = req.get('host');
      const fileUrl = `https://${host}/files/${fileName}`;

      // Send to WhatsApp: Text link + Document attachment
      await sendWhatsAppMessage(senderPhone, `Your estimate proposal is ready!\n\nReview it online:\n${fileUrl}`);
      await sendWhatsAppDocument(senderPhone, fileUrl, fileName, `Estimate Proposal ${quoteNumber}`);
      return;
    }

    // Still asking intake questions
    await sendWhatsAppMessage(senderPhone, parsed.customer_reply);

  } catch (err) {
    console.error('Processing error:', err);
  }
});

async function sendWhatsAppMessage(to, text) {
  try {
    await fetch(`https://graph.facebook.com/v21.0/${waPhoneId}/messages`, {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${waToken}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ messaging_product: 'whatsapp', recipient_type: 'individual', to, type: 'text', text: { body: text } })
    });
  } catch (err) {
    console.error('WhatsApp text error:', err);
  }
}

async function sendWhatsAppDocument(to, fileUrl, fileName, caption) {
  try {
    await fetch(`https://graph.facebook.com/v21.0/${waPhoneId}/messages`, {
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
  } catch (err) {
    console.error('WhatsApp doc error:', err);
  }
}

// Test endpoint: Triggers quote generation directly via browser or curl
app.get('/test-quote', async (req, res) => {
  try {
    const quoteNumber = `Q-${Math.floor(100000 + Math.random() * 900000)}`;

    const testQuoteData = {
      quote_number: quoteNumber,
      quote_date: new Date().toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' }),
      quote_valid_until: new Date(Date.now() + 30 * 86400000).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' }),
      customer_name: req.query.name || "Jane Doe",
      customer_phone: req.query.phone || "(555) 019-2834",
      customer_email: req.query.email || "jane@example.com",
      property_address: req.query.address || "124 Pine Island Rd, Cape Coral, FL",
      roof_type: "Standing Seam Metal",
      roof_age: "18 years",
      roof_size_sqft: "2,600",
      stories: "1 story",
      diagnosis_summary: "Multiple compromised fastener gaskets, moderate wind uplift along the south ridge, and surface corrosion around vent penetrations.",
      subtotal: "$14,800.00",
      tax: "$962.00",
      total: "$15,762.00",
      deposit_amount: "$2,500.00",
      estimated_start_date: "Within 2 weeks",
      estimated_duration: "3 business days",
      scope: [
        { title: "Tear-off & Deck Fastener Check", detail: "Remove existing surface material, inspect 5/8-inch plywood decking, and replace damaged sections." },
        { title: "High-Temp Underlayment", detail: "Install full self-adhering synthetic secondary water barrier across all valleys and eaves." },
        { title: "24-Gauge Metal Installation", detail: "Fasten standing seam panels with concealed clips and install color-matched ridge ventilation." }
      ],
      materials: [
        { material_name: "24-Gauge Galvalume Standing Seam Panels", material_qty: "28 sq", material_unit_price: "$320.00", material_line_total: "$8,960.00" },
        { material_name: "Self-Adhering High-Temp Underlayment", material_qty: "7 rolls", material_unit_price: "$145.00", material_line_total: "$1,015.00" },
        { material_name: "Tear-off, Disposal & Installation Labor", material_qty: "1 job", material_unit_price: "$4,825.00", material_line_total: "$4,825.00" }
      ]
    };

    const templatePath = path.join(__dirname, 'roof-quote-template.html');
    const rawTemplate = fs.readFileSync(templatePath, 'utf8');
    const filledHtml = populateQuoteTemplate(rawTemplate, testQuoteData);

    const publicDir = path.join(__dirname, 'public');
    if (!fs.existsSync(publicDir)) fs.mkdirSync(publicDir, { recursive: true });

    const fileName = `Roof_Quote_${quoteNumber}.html`;
    fs.writeFileSync(path.join(publicDir, fileName), filledHtml, 'utf8');

    const fileUrl = `https://${req.get('host')}/files/${fileName}`;
    res.json({
      status: "success",
      quote_number: quoteNumber,
      file_url: fileUrl
    });
  } catch (error) {
    res.status(500).json({ status: "error", message: error.message });
  }
});

// Test endpoint: Direct Gemini intake evaluation in browser
app.get('/test-intake', async (req, res) => {
  const incomingText = req.query.msg || "Hi, I need an estimate. Address is 310 SW 25th Terrace Cape Coral. Full tear-off, 2400 sqft, asphalt shingle to standing seam metal. 1 story, minor wind uplift, cash retail, timeline 3 weeks. Contact is Juan Londono, juan@test.com";
  const dummyPhone = "test-browser-user";

  if (!userSessions.has(dummyPhone)) {
    userSessions.set(dummyPhone, {
      data: { ...DEFAULT_STATE },
      isComplete: false
    });
  }

  const session = userSessions.get(dummyPhone);

  try {
    const geminiUrl = `https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-flash:generateContent?key=${geminiApiKey}`;

    const geminiResponse = await fetch(geminiUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        system_instruction: { parts: [{ text: SYSTEM_INSTRUCTION }] },
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

    const geminiData = await geminiResponse.json();

    if (geminiData.error) {
      return res.status(500).json({ status: "gemini_api_error", details: geminiData.error });
    }

    const rawAiOutput = geminiData.candidates?.[0]?.content?.parts?.[0]?.text;
    if (!rawAiOutput) {
      return res.status(500).json({ status: "empty_ai_output", raw: geminiData });
    }

    const parsed = JSON.parse(rawAiOutput);
    session.data = { ...session.data, ...parsed.collected_data };
    session.isComplete = Boolean(parsed.is_complete);

    res.json({
      status: "success",
      input_message: incomingText,
      extracted_data: session.data,
      is_complete: session.isComplete,
      ai_response: parsed.reply_to_user || parsed.next_question || parsed
    });
  } catch (error) {
    res.status(500).json({ status: "server_error", message: error.message, stack: error.stack });
  }
});

app.listen(port, () => console.log(`Server running on port ${port}`));
