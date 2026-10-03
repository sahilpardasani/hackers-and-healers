# Patient Agency: Postpartum GLP-1 Journey (React MVP)

> *As a millennial parent, I want to act on my health data so that I can be successful in my weight management journey in the postpartum period.*

A React + Vite front end that connects to a FHIR server with **SMART on FHIR**, combines it with **self-reported check-ins**, and runs a small **rules engine** that turns the data into one-tap daily actions, safety alerts and a visit summary.

## Quick start

```bash
npm install
npm run dev        # http://localhost:5173
npm test           # rules + normalizer unit tests (Node 18+)
npm run build      # static build in dist/
```

Open the app, tick the consent box, then pick:

- **Try with demo patient "Maya"**: a synthetic FHIR R4 Bundle (postpartum, prediabetes, gestational diabetes history, week 10 on tirzepatide, oral contraceptive). Every rule can fire.
- **Connect my health record**:
  - **SMART Health IT sandbox:** works immediately, no registration. Choose any patient in the picker.
  - **Epic sandbox:** register a patient-facing app at fhir.epic.com, then copy `.env.example` to `.env.local` and set `VITE_EPIC_CLIENT_ID`. The redirect URI must match exactly (e.g. `http://localhost:5173/`). Log in with Epic's test MyChart users (see Epic's sandbox test data docs).

## Project structure

```
src/
  App.jsx                 Phone frame, tab routing, side panel
  state/store.jsx         useReducer store + localStorage (self-reported data only)
  fhir/smart.js           SMART standalone launch (fhirclient: PKCE, pagination)
  fhir/normalize.js       FHIR R4 → PatientContext (LOINC / ICD-10 / RxNorm + text fallback)
  data/mayaBundle.js      Synthetic demo patient (no real PHI)
  rules/engine.js         Rules S-1…S-9, dose schedule, weight stats, visit summary
  components/             Shared UI (ActionCard, AlertCard, BottomNav, SidePanel, Toast)
  screens/                Connect, Today, Journey, Progress, MyData, VisitPrep
  agent/                  Voice log agent: intent parser + responder
test/               24 unit tests: data layer, rules, voice agent
```

## FHIR queries (read-only)

| Query | Used for |
|---|---|
| `Patient/{id}` | Name |
| `Observation?category=vital-signs` | Weight (29463-7), BMI (39156-5), height |
| `Observation?category=laboratory` | A1c (4548-4), glucose |
| `Condition` | Prediabetes, type 2 diabetes, gestational diabetes history, high BP, sleep apnea |
| `MedicationRequest` | GLP-1 drug, dose and start date; oral contraceptive |
| `AllergyIntolerance` | Snapshot |

Matching Epic API names: Patient.Read, Observation.Search (Vital Signs / Labs), Condition.Search (Problems), MedicationRequest.Search (Signed Medication Order), Medication.Read, AllergyIntolerance.Search (all R4).

## Rules

| ID | Trigger | Output |
|---|---|---|
| S-1 | Breastfeeding | Pause readiness; clinician conversation |
| S-2 | Planning pregnancy + GLP-1 | Discuss timing |
| S-3 | Thyroid cancer / MEN2 or pancreatitis history | Clinician check first |
| S-4 | Belly pain logged | Red alert: contact clinician |
| S-5 | Mood ≤ 2/5 | Support alert + 988 |
| S-6 | Tirzepatide + oral contraceptive, within 28 days of a dose change or 7 days before a step-up | Backup contraception for 4 weeks |
| S-8 | ≥ 5% weight loss | Milestone |
| S-9 | Gestational diabetes history / prediabetes with no A1c in 12 months | "Get your A1c test" action |

## Voice log agent 🎙️

Tap the 🎙️ button on any screen. Speak, type, or tap a suggestion. Patient Agency logs what it understands right away and offers an **Undo** on the latest log.

| Say… | Patient Agency does |
|---|---|
| "I took my shot" | Logs the dose (7.5 mg on step-up day) + backup birth control reminder |
| "Walked 30 minutes with the stroller" / "did 20 minutes of weights" | Logs exercise; strength completes Today's strength card |
| "Had a protein shake and two eggs" | Adds 25 g + 12 g protein |
| "Drank 2 glasses of water" | Water +2 |
| "I weigh 183.4" | Logs weight |
| "Feeling nauseous" / "my stomach hurts" | Logs side effect + tip, or urgent "contact your clinician" for belly pain |
| "I feel really down" | Logs mood + support message with 988 |
| "What's next?" / "When is my next dose?" / "How much have I lost?" | Answers from her own data and the rules engine |
| "Can I take ibuprofen?" | No medical advice: adds it to Visit prep questions |

- `src/agent/parse.js`: offline, rule-based intent parser; one sentence can hold several intents.
- `src/agent/respond.js`: maps intents to store actions and writes the reply.
- `src/components/VoiceAgent.jsx`: chat sheet, Web Speech API speech-to-text, spoken replies (toggle 🔊).
- To use an LLM later, keep the same intent shape and swap `parseUtterance`.

**Browser support:** speech input works in Chrome, Edge and Safari; elsewhere it falls back to typing. Chrome's speech recognition sends audio to Google's servers for transcription, so before using real patient data, review this or switch to on-device or BAA-covered speech-to-text.

## Privacy (prototype)

- Use **sandbox or synthetic data only**. No real PHI.
- fhirclient keeps tokens in sessionStorage; Patient Agency never logs them.
- Live EHR data is held in memory only. Self-reported check-ins are stored on the device (localStorage) and can be deleted from **My data**.
- Mocked integrations: calendar, pharmacy, insurance (labelled in the UI).

## Deploy to GitHub Pages

`npm run build`, then publish `dist/` (e.g. with the `gh-pages` package or a Pages GitHub Action). Add the Pages URL as a redirect URI in your Epic app registration.

---

Not medical advice. All clinical rules and wording require clinician review before use with patients.
