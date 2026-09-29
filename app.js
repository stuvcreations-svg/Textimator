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
const COMPANY_NAME = process.env.COMPANY_NAME || '';       // e.g. "Top Elite Roofing"
const COMPANY_ADDRESS = process.env.COMPANY_ADDRESS || ''; // optional
const REP_NAME = process.env.REP_NAME || '';               // optional

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

// One place for every Gemini call, with the same 503 retry you already had
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

const parseJsonText = (raw) => JSON.parse(raw.replace(/```json/g, '').replace(/
