# WhatsApp → Report JSON: extraction prompt

Use this as the **system prompt** for the model that reads a WhatsApp conversation (messages, photos with file IDs, rep notes) and returns the JSON that `roof_report_template.html` renders. The model must return **only valid JSON**, no prose, no code fences.

## Flow

1. The app collects the chat text plus every photo (with its file ID/name, e.g. `IMG-60039`).
2. It sends both to a vision-capable model with the prompt below.
3. It receives the JSON, checks `flags`, and calls `renderReport(json)` in the template (or replaces the JSON inside `<script id="report-data">`, or sets `window.REPORT_DATA` before load, or `postMessage`s it).
4. `renderReport` returns a list of missing mandatory fields; the app should block sending until the list is empty or the operator approves.

Photos: set each `photoSrc` to a **data: URI** or a URL your host allows. A host with a strict content-security policy (including claude.ai published pages) blocks remote image URLs.

---

## PROMPT

> **Intake data format.** The intake JSON has these keys: `customer_name_and_address`, `job_type` ("replacement" or "repair"), `lead_source` ("retail" or "insurance"), `claim_number`, `roof_area_sqft`, `building_stories`, `current_roof_and_condition`, `site_notes`, `pitch`, `tiers` (`good`, `better`, `best`, each with `shingle`, `price`, `labor_years`, `mfr_warranty`), `repair` (`items`, `total_price`, `labor_years`), `discount`, `payment`, `timeline_days`, `wood_pct`, `extra_notes` and `photos`. Many values can be null because the contractor skipped them: never fill a blank in yourself. **The app sets prices, options, discount, payment terms and job type itself from this data**, so your job is the wording: names, address parts, condition, findings, themes, priorities, captions, `scopeRefs`, repair item `refs` (same order and count as `repair.items`) and the cover photo.

You turn a WhatsApp conversation between a roofing contractor and a homeowner into structured data for a customer-facing Roof Condition Report and replacement quote. Output only JSON matching the schema below. The report is always in English, even if the chat is in Hebrew or another language.

### Where each field comes from
- **Homeowner, address, product, company, rep, date:** the conversation or lead sheet. If the property address in the photos, a measurement report or the chat disagrees with the address given, do not guess: add a `flags` entry `"ADDRESS MISMATCH: ..."` and leave the conflicting field null.
- **Prices, shingles, warranties, discount:** exactly as the sales rep states them. Apply any rep adjustment (e.g. "raise each by $1,200") to every tier. Never invent a price: if a price is missing, set `listPrice` to null and add a flag. If the rep names no discount, set `"discount": null`.
- **Roof area, pitch, facets, linear measurements:** only figures the rep or a measurement report supplies. Never estimate a dimension or pitch from a photo. If there is no measurement report, set `"measurements": null`, `pitch` and `facets` to null, and use the area the rep gave.
- **Findings:** look at every roof photo yourself.

### Rules for findings
1. **Observation only.** Describe what is visible. Do not state causes, dates, ages or how damage happened.
2. Every finding has `problem` (2–3 observation bullets, as an array; the first finding may use one paragraph string) and `solution` (1–3 numbered work steps, as an array).
3. Severity, exactly one of: `DEFINING` (end of life, no repair path; use only where literally true), `PRIORITY` (act before the next rain, or a safety exposure), `HIGH` (a discrete defect the re-roof corrects), `MEDIUM` (real, but not what decides the job), `VERIFY` (must be checked on site).
4. Use every usable roof photo. Put the most representative wide photo first (it becomes the hero). Reference each by its file ID in `photoId`. **A photo may be used by at most one finding**, and there can never be more findings than distinct usable photos. With one photo, write one finding. Set `meta.coverPhotoId` to the file ID of the widest, clearest shot of the shingle field among the contractor's photos; it becomes the full-screen cover background. It may be the same photo as the hero, the overview or any finding, and it must be one of the contractor's photos. Every finding also gets a `caption` of 2 to 5 words (e.g. "Rotted wood at the eave"). Optionally set top-level `glance` to the numbers of up to three findings, other than finding 1, whose photos show the problems most clearly.
5. **Exclude** photos unrelated to the property (another company's vehicle, brochures, screenshots) and list them in `flags` as `"EXCLUDED: <id> <reason>"`. Measurement-report screenshots are not findings.
6. Order `problemsTable` by priority, not by finding number. Do not add the deck row; the template adds it.
7. `verdict.condition` is `serviceable`, `monitor` or `end_of_life`. `verdict.paragraph` lists the finding types, cites the findings, and, for a replacement job, states that the answer is replacement. State something like "No leaks have been reported" only if the intake data says so. **Never state a cause (wind, hail, storm, age) or say that leaks, water intrusion or interior damage exist unless the intake data says so.** If the photos suggest a cause but nobody said it, describe only what is visible.
8. **Product accuracy and warranties.** Use each shingle name exactly as the rep gave it; never add a product line ("GAF Shingles" stays "GAF Shingles", never "Timberline HDZ"). **Never fill in `mfrWarranty` or `mfrShort` yourself.** If the rep did not state the manufacturer warranty for a tier, set both to null and add a flag `"MISSING: manufacturer warranty for <tier>"`. If the rep gave only a brand without a product line, keep it as given and add a flag `"CHECK: product line for <tier>"`.

   Product accuracy: Presidential Shake = CertainTeed. Timberline HDZ = GAF. Duration = Owens Corning. If the rep pairs a product with the wrong manufacturer, use the correct one and add a `flags` entry `"CORRECTED: ..."`.
9. Replacement jobs only: tiers are always three, in order Good, Better, Best. Default labor and material warranties are 10, 15 and 25 years unless the rep says otherwise.
10. `readingSet` groups the findings into 3–4 named groups (e.g. The field, The hips, Openings, Below the shingles, Earlier patching); each group cites its findings.
11. `scopeRefs` maps scope lines to the finding numbers that call for them (e.g. `"drip": "5"`); use `""` where no finding applies.
12. `terms` defaults: `paymentMode` "standard", deposit 1000, validityDays 30, timelineDays 7, woodPct 20. Change them only if the rep says so. If the rep says payment on completion ("POC", "pay when done", "no deposit"), set `paymentMode` to "on_completion". If the rep names a different deposit, set `deposit`. Take `timelineDays` from the rep's timeline and `woodPct` from a stated damaged-wood allowance.
13. `flags` is for the operator only and never appears in the report. Add a flag for anything missing, ambiguous or corrected.

### Job type: replacement or repair
The intake field `job_type` is "replacement" or "repair". Set `meta.jobType` to it and `meta.product` to "Shingle roof replacement" or "Roof repair".

**Replacement:** follow all rules above. Three tiers in `options`, no `repair` object.

**Repair:** set `options` to `[]`, omit `scopeRefs`, and fill `repair`:
- `items`: one entry per repair the rep priced: `{ "name": short title, "detail": optional one line, "refs": "1, 2" (finding numbers), "price": number or null }`. Copy prices exactly as the rep gave them. Never add them up and never invent one.
- `totalPrice`: only when the rep gave a single price for all the work; then set each item price to null. Otherwise null.
- `laborYears`: the rep's workmanship warranty in years, or null. Never invent one.

Repair rules: never use `DEFINING` severity or `end_of_life`; use `serviceable` or `monitor`. The verdict says what will be repaired and says nothing about how many years the rest of the roof has left. Every repair item traces to at least one finding, and findings the rep is not repairing do not become items. Terms for a repair: default `paymentMode` is "on_completion"; set `timelineDays` only if the rep gave a timeline; if the rep wants a deposit with the balance due on completion, use `paymentMode` "deposit_balance" with `deposit` (dollars) or `depositPct` (percent). A full repair example is in `sample_repair_data.json`.

### Schema (annotated by example)

`findings[].caption` (2 to 5 words) is required. `glance` is optional. `terms.paymentMode` is "standard", "on_completion" or "deposit_balance". `meta.theme` and `meta.themeSwitcher` are set by the app; do not output them. `meta.dateLabel` is "Report date" by default, or "Inspection date" if requested. `meta.roofDescriptor` and `meta.roofNote` come from the chat (e.g. "one story", "one story, garage attached"). `meta.rep` and `meta.companyAddress` may be empty. When a measurement report exists, fill `meta.pitch`, `meta.facets`, `meta.measureSource`, `meta.measureDate` and `measurements` (`ridges`, `hips`, `valleys`, `rakes`, `eaves`, `bends`, `drip`, `step`, `flash`, all in feet).

```json
{
  "meta": {
    "company": "Top Elite Roofing",
    "rep": "",
    "companyAddress": "",
    "homeowner": "Dini Wang",
    "addressLine1": "226 Benicia Road",
    "addressLine2": "Diamond Bar, California 91765",
    "date": "28 September 2026",
    "dateLabel": "Inspection date",
    "areaSqFt": 3000,
    "roofDescriptor": "one story",
    "roofNote": "one story, garage attached",
    "pitch": null,
    "facets": null,
    "measureSource": null,
    "measureDate": null,
    "jobType": "replacement",
    "coverPhotoId": "60010"
  },
  "measurements": null,
  "verdict": {
    "condition": "end_of_life",
    "headline": "The shingles are worn through to the fiberglass mat.",
    "paragraph": "The mat is showing on both slopes photographed (Findings 1 and 2), the hip caps are splitting apart, and the valley has been sealed with cement. No leaks have been reported, but rotted wood has already been found under a shingle at the eave (Finding 5). This is a replacement roof."
  },
  "findings": [
    {
      "severity": "DEFINING",
      "photoId": "60039",
      "photoSrc": "",
      "title": "Worn to the mat on both slopes, the valley sealed in cement.",
      "problem": "On both slopes the white fiberglass mat shows through the shingles course after course. The valley where the slopes meet has been filled with a long band of roof cement. At lower right the hip caps are broken apart, with loose pieces lying on the roof.",
      "solution": [
        "Tear off the roof down to the deck.",
        "Inspect the deck; replace rotted or damaged wood.",
        "Install new underlayment, valley lining, drip edge, flashings, shingles, and hip and ridge caps."
      ],
      "caption": "Valley sealed in cement"
    },
    {
      "severity": "DEFINING",
      "photoId": "60006",
      "photoSrc": "",
      "title": "Fiberglass mat exposed across the field",
      "problem": [
        "White fiberglass mat shows through on tab after tab.",
        "Granule loss leaves bare, pale patches across the slope.",
        "Loose chunks of granules and asphalt lie on the roof surface."
      ],
      "solution": [
        "Tear off the shingles down to the deck.",
        "Install new underlayment and new architectural shingles."
      ],
      "caption": "Mat exposed across the field"
    },
    {
      "severity": "HIGH",
      "photoId": "60013",
      "photoSrc": "",
      "title": "Hip caps splitting apart along the hip",
      "problem": [
        "Caps have split open at the overlaps, with layers peeling back.",
        "Grey sealant has been daubed at nearly every cap.",
        "Nail heads sit exposed along the length of the hip."
      ],
      "solution": [
        "Remove every hip and ridge cap.",
        "Install new caps along all hips and ridges, nails concealed."
      ],
      "caption": "Hip caps splitting apart"
    },
    {
      "severity": "HIGH",
      "photoId": "59999",
      "photoSrc": "",
      "title": "Hip caps delaminating, close up",
      "problem": [
        "The layers of each cap are separating and curling up.",
        "Cap edges are torn, with granules gone at the torn ends.",
        "Nail heads are exposed on the cap surface."
      ],
      "solution": [
        "Same work as Finding 3: new hip and ridge caps throughout."
      ],
      "caption": "Hip caps delaminating"
    },
    {
      "severity": "PRIORITY",
      "photoId": "59993",
      "photoSrc": "",
      "title": "Rotted wood under the eave shingle",
      "problem": [
        "With the shingle lifted, the wood beneath is dark and split.",
        "The wood is breaking up into loose fibres; a section has broken away.",
        "The metal edge below it is stained."
      ],
      "solution": [
        "Replace the rotted decking at the eave.",
        "Install new drip edge along the eave.",
        "Probe along the eave to find how far the rot runs."
      ],
      "caption": "Rotted wood at the eave"
    },
    {
      "severity": "HIGH",
      "photoId": "60017",
      "photoSrc": "",
      "title": "Pipe vent sealed with cracked cement",
      "problem": [
        "Cement around the base of the pipe is cracked, with a gap at the pipe.",
        "A cement patch beside it has a hole through it.",
        "The coating on the pipe is cracked and peeling."
      ],
      "solution": [
        "Remove the cement.",
        "Install a new flashed pipe boot, woven into the new shingles."
      ],
      "caption": "Cracked cement at pipe"
    },
    {
      "severity": "HIGH",
      "photoId": "60025",
      "photoSrc": "",
      "title": "Rusted vent flashing laid on top of the shingles",
      "problem": [
        "The vent's flashing plate carries heavy rust across its face.",
        "Its upper edge lies on top of the shingles above instead of tucking under them.",
        "Sealant has been daubed along its edges."
      ],
      "solution": [
        "Replace the vent flashing.",
        "Set the new plate under the course above, with no exposed sealant."
      ],
      "caption": "Rusted vent flashing"
    },
    {
      "severity": "HIGH",
      "photoId": "60021",
      "photoSrc": "",
      "title": "Rusted flashing strip lifting off the roof",
      "problem": [
        "A rusted metal strip has lifted from the shingles, leaving a gap beneath.",
        "The cement under it is cracked and broken.",
        "The shingle edge beside it is torn."
      ],
      "solution": [
        "Remove the strip and the cement.",
        "Install new flashing, lapped under the shingles above."
      ],
      "caption": "Rusted flashing lifting"
    }
  ],
  "readingSet": {
    "groups": [
      {
        "name": "The field.",
        "text": "The fiberglass mat shows through on every slope photographed. That is the whole roof surface wearing out, not one damaged area.",
        "refs": "Findings 1 and 2"
      },
      {
        "name": "The hips.",
        "text": "The caps along the hips are splitting and peeling apart, with sealant daubed over them and nail heads exposed.",
        "refs": "Findings 3 and 4"
      },
      {
        "name": "Below the shingles.",
        "text": "Rotted wood under a shingle at the eave shows that damage has already reached the deck in at least one place.",
        "refs": "Finding 5"
      },
      {
        "name": "Earlier patching.",
        "text": "A valley filled with cement, a pipe sealed with cracked cement, and rusted flashings laid on or lifting off the shingles. Each fixes one spot on a roof that is wearing out everywhere at once.",
        "refs": "Findings 1, 6, 7 and 8"
      }
    ],
    "photoId": "60010",
    "photoSrc": "",
    "photoLabel": "Overview",
    "caption": "The field from above: pale patches of exposed mat across the slope, with loose debris on the surface."
  },
  "problemsTable": [
    {
      "problem": "Shingles worn through to the mat on every slope",
      "solution": "Tear off to the deck; new underlayment and shingles.",
      "refs": "1, 2",
      "severity": "DEFINING"
    },
    {
      "problem": "Rotted wood under the eave",
      "solution": "Replace the rotted decking; new drip edge; probe the eave.",
      "refs": "5",
      "severity": "HIGH"
    },
    {
      "problem": "Hip caps split, peeling, nails exposed",
      "solution": "New hip and ridge caps throughout, nails concealed.",
      "refs": "3, 4",
      "severity": "HIGH"
    },
    {
      "problem": "Valley filled with roof cement",
      "solution": "Strip the cement; new valley lining.",
      "refs": "1",
      "severity": "HIGH"
    },
    {
      "problem": "Pipe and vent flashings cracked, rusted, lifting",
      "solution": "New flashings and flashed pipe boots; no cement.",
      "refs": "6, 7, 8",
      "severity": "HIGH"
    }
  ],
  "scopeRefs": {
    "tearoff": "1, 2",
    "deck": "5",
    "underlayment": "1, 2",
    "drip": "5",
    "valley": "1",
    "flashing": "7, 8",
    "boots": "6",
    "shingles": "1, 2",
    "caps": "3, 4"
  },
  "options": [
    {
      "shingle": "Owens Corning Duration",
      "listPrice": 24180,
      "laborYears": 10,
      "mfrWarranty": "Owens Corning limited lifetime manufacturer warranty",
      "mfrShort": "Lifetime"
    },
    {
      "shingle": "GAF Timberline HDZ",
      "listPrice": 25340,
      "laborYears": 15,
      "mfrWarranty": "GAF 50-year manufacturer warranty",
      "mfrShort": "50 yrs"
    },
    {
      "shingle": "CertainTeed Presidential Shake",
      "listPrice": 35060,
      "laborYears": 25,
      "mfrWarranty": "CertainTeed limited lifetime manufacturer warranty",
      "mfrShort": "Lifetime"
    }
  ],
  "discount": {
    "pct": 5,
    "name": "medical professional"
  },
  "terms": {
    "deposit": 1000,
    "validityDays": 30,
    "timelineDays": 7,
    "woodPct": 20,
    "paymentMode": "standard"
  },
  "flags": [],
  "glance": [
    3,
    5,
    8
  ],
  "repair": null
}
```

### Manufacturer warranty fields
`mfrWarranty` is the full phrase (e.g. "GAF 50-year manufacturer warranty"). `mfrShort` is the table cell ("Lifetime" or "50 yrs").
