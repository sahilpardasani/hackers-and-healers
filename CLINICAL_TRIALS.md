# Clinical Trial Matching

`clinicaltrial.py` finds recruiting studies on [ClinicalTrials.gov](https://clinicaltrials.gov/) for a patient and pre-screens their eligibility against the patient's own records. It runs inside the existing Flask app (`python app.py`), works as a standalone command-line tool, and accepts JSON from any frontend.

> **Pre-screen, not an eligibility decision.** Most criteria (consent, prior procedures, investigator judgement) cannot be checked automatically. Every result lists which criteria still need the study team. Not medical advice.

## How it works

```
FHIR records ──► patient profile ──► one search per condition ──► pre-screen each trial ──► ranked results
(synced DB,      age, sex,           ClinicalTrials.gov API v2     sex/age, lab thresholds,     strong / possible /
 Bundle, or      conditions, labs,   recruiting + not yet          condition mentions,          likely ineligible
 simple JSON)    medications         recruiting, optional geo      unrelated conditions
```

### 1. Patient profile

| Profile field | Source in FHIR |
|---|---|
| Age, sex | `Patient.birthDate`, `Patient.gender` |
| Conditions | `Condition.code` text or display; entries with a `clinicalStatus` of resolved, inactive or remission are skipped |
| eGFR | Latest `Observation` with LOINC 33914-3, 48642-3, 62238-1 or 98979-8 |
| A1c | LOINC 4548-4, 17856-6, 59261-8 |
| BMI | LOINC 39156-5 |
| Systolic BP | LOINC 8480-6, either as its own Observation or as a component of the 85354-9 BP panel |
| Medications | Active `MedicationRequest` names |

If there is no problem list, the matcher proposes **search topics, not diagnoses**, labeled `labs`: eGFR < 60 suggests searching kidney disease studies, A1c ≥ 6.5 suggests diabetes studies, A1c 5.7 to 6.4 suggests prediabetes studies, BMI ≥ 30 suggests obesity studies, and systolic ≥ 130 suggests hypertension studies. These single values cannot establish a diagnosis (or diabetes type). Unsupported or missing units and cancelled, preliminary, or entered-in-error readings are not compared. Historical results still need confirmation.

Stored matching is scoped to the active connection's FHIR server **and patient reference**. `source=sample` explicitly uses the isolated fictional Maya namespace; disconnecting does not expose previously stored patients through trial matching.

### 2. Search

Chart wording is simplified before searching, because ClinicalTrials.gov condition search is literal. For example, "Chronic kidney disease stage 3a" returns 0 recruiting studies, while "chronic kidney disease" returns about 860.

| Chart wording | Search term |
|---|---|
| Chronic kidney disease stage 3a | chronic kidney disease |
| Type 2 diabetes mellitus with hyperglycemia | type 2 diabetes |
| Essential (primary) hypertension | hypertension |

Up to 5 conditions are searched, 25 studies each, filtered to `RECRUITING` and `NOT_YET_RECRUITING`. If latitude and longitude are given, results are limited to `filter.geo=distance(lat,lon,miles)` and sites are sorted by distance.

### 3. Pre-screen

ClinicalTrials.gov publishes eligibility criteria as one free-text block. The matcher splits it into inclusion and exclusion items and assesses each one:

| Mark | Inclusion item | Exclusion item |
|---|---|---|
| ✓ | Meets a lab threshold (e.g. "eGFR ≥ 25 and < 75") | Lab threshold does not apply |
| ✗ | Fails a lab threshold | Exclusion applies |
| ⚑ | Mentions one of the patient's conditions | Mentions one of the patient's conditions, so check with the study team |
| · | Not machine-checkable | Not machine-checkable |

The parser handles `≥ ≤ > <`, written comparisons ("at least", "less than"), `>/=`, "between X and Y" and "X–Y" ranges, and escaped text such as `\<`. It also avoids common false negatives:

- A threshold from another measurement in the same sentence is not applied to the lab ("eGFR ≥ 30 *with urine protein ≥ 150*").
- Conditional clauses are not treated as requirements ("potassium ≤ 4.5 *if eGFR < 45*", "*For insulin users*, …").
- Items with alternatives or lettered cohorts ("… *or* on dialysis", "(b) eGFR 60–75") are downgraded from ✗ to · .
- A1c thresholds given in mmol/mol are not compared with % results.

Each trial gets one verdict:

- **strong match** (displayed as criteria overlap): shares a condition with the patient, meets at least one inclusion item, has known age/sex, and has no barriers, flags, or unreviewed criteria. This still is not a validated eligibility decision.
- **possible match**: no barriers found, but there are open questions. This includes a trial that also studies a condition the patient doesn't have (e.g. a multiple sclerosis study for a patient with hypertension).
- **likely ineligible**: sex or age is outside the range, an inclusion item fails, or an exclusion item applies. These are hidden unless `all` is requested.

## Using it

### In the app

After connecting and syncing, open the **Clinical trials** dashboard tab (or `https://127.0.0.1:3000/#trials`). Review the local profile, optionally enter latitude, longitude and radius, and confirm sharing the displayed search topics before clicking **Find clinical trials**. Opening the tab does not call ClinicalTrials.gov. `/trials` redirects to the tab; `/sample#trials` explores the fictional sample.

Enable **Condition.Search (Problems) R4** and **Patient.Read R4** in the Epic app registration. The merged sync preserves the existing required Patient read and optional-category warnings. The problem list is fetched in full (no incremental recorded-date filter), while the working OAuth, medications, appointments, and coverage paths remain intact. A missing problem list can yield clearly labeled lab-derived search suggestions.

### HTTP API

| Route | Purpose |
|---|---|
| `GET /trials` | Redirect to the dashboard Clinical trials tab |
| `GET /api/trials/profile?source=connected` | Local profile and planned queries; no external request. Use `source=sample` for fictional records. |
| `GET /api/trials?consent=yes&source=connected&lat=&lon=&miles=&all=1` | JSON results for the selected patient after explicit topic-sharing consent; omit empty coordinate fields |
| `POST /api/trials/match` | JSON results for a posted FHIR Bundle, `{"resources": [...]}`, or a simple profile. `lat`, `lon`, `miles` and `all` can go in the body or the query string. |
| `GET /api/trials/NCT01234567` | One trial's summary, pre-screened against the synced patient |

Simple profile format:

```json
{"age": 45, "sex": "male", "conditions": ["heart failure", "type 2 diabetes"],
 "labs": {"egfr": 72, "a1c": 8.1, "bmi": 29.5, "systolic": 128}}
```

JSON responses contain `profile` (what was read), `searches` (the exact ClinicalTrials.gov queries), and `trials`. Each trial includes a summary, interventions, sites, contacts, and a `match` object with `verdict`, `reasons`, `blockers`, `flags`, and the assessed `inclusion` and `exclusion` items.

To call the API from a frontend on another origin (e.g. the React app), allow it in `.env`:

```sh
TRIALS_CORS_ORIGINS=http://localhost:5173
```

The included Vite development server already proxies `/api/trials` to `https://127.0.0.1:3000`, so this CORS option is not needed for that setup. Its local-only proxy accepts the development self-signed certificate; upstream Epic and ClinicalTrials.gov TLS verification stays enabled. The React tab sends only age, recorded sex, condition labels and supported A1c/BMI values from its own current context. It does not silently substitute the backend's active patient.

### Command line

```sh
python clinicaltrial.py samples/labs_only_patient.json --profile-only        # what was read, planned queries; no API calls
python clinicaltrial.py samples/sample_patient.json --lat 42.34 --lon -71.07 --miles 25
python clinicaltrial.py samples/sample_patient.json --nct NCT05759468         # one trial, line by line
python clinicaltrial.py '{"age": 70, "sex": "female", "conditions": ["atrial fibrillation"], "labs": {"egfr": 25}}'
```

Options: `--limit N` (default 5), `--all`, `--brief` (no per-criterion lines), `--json`. The input can be a file, `-` for stdin, or inline JSON.

### Samples

The files in `samples/` are synthetic patients. See [`samples/README.md`](samples/README.md).

| File | Exercises |
|---|---|
| `sample_patient.json` | CKD 3a + type 2 diabetes + hypertension, resolved condition ignored |
| `labs_only_patient.json` | No problem list; conditions inferred from labs |
| `postpartum_prediabetes.json` | Prediabetes + obesity, resolved gestational diabetes, GLP-1 medication |
| `simple_profile.json` | Simple `{age, sex, conditions, labs}` input |

## ClinicalTrials.gov API notes

- API v2 is public, needs no key, and is limited to about 50 requests per minute per IP. Requests are spaced 1.3 s apart and cached in memory for an hour.
- Endpoints used: `GET /api/v2/studies` (search) and `GET /api/v2/studies/{nctId}`. Responses are restricted with `fields=` to the identification, status, description, conditions, design, eligibility, contacts/locations and arms/interventions modules.
- Useful parameters: `query.cond`, `query.term`, `filter.overallStatus`, `filter.geo=distance(lat,lon,Nmi)`, `pageSize`, `pageToken`.
- Eligibility is structured only for `sex`, `minimumAge`, `maximumAge` and `healthyVolunteers`. Everything else is in the `eligibilityCriteria` free text.

## Privacy

- **Sent to ClinicalTrials.gov:** simplified condition names, plus coordinates when the caller provides them.
- **Never sent:** patient identifiers, lab values, medications and the full records. All matching runs locally.
- Cross-origin API access is off unless `TRIALS_CORS_ORIGINS` is set.
- Use synthetic or sandbox data. The samples contain no real PHI.

## Limitations and next steps

- Only eGFR, A1c, BMI and systolic BP thresholds are evaluated. Candidates to add next: UACR, LDL, potassium, diastolic BP and pregnancy status.
- Medications are read but not yet matched against criteria such as "on a stable dose of metformin" or "no prior GLP-1 use".
- Multi-cohort studies with nested sub-criteria can still be marked likely ineligible.
- Location search needs lat/lon; the patient's address is not geocoded.
- An LLM could interpret the `·` items. The rule-based results would remain the transparent baseline.

## Tests

```sh
python -m unittest discover -s tests -v
```

Tests run offline with mocked ClinicalTrials.gov calls. They cover profile extraction, criteria parsing, matching, the sample files, and the API routes.
