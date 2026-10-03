# Trial-matching samples

Synthetic patients (no real PHI) for trying `clinicaltrial.py` against live ClinicalTrials.gov data.

| File | Shape | What it exercises |
|---|---|---|
| `sample_patient.json` | FHIR Bundle | CKD 3a + type 2 diabetes + hypertension, resolved condition ignored, BP panel components |
| `labs_only_patient.json` | FHIR Bundle | No problem list: conditions inferred from eGFR 38, A1c 6.8, systolic 152 |
| `postpartum_prediabetes.json` | FHIR Bundle | Young female, prediabetes + obesity, resolved gestational diabetes, on tirzepatide |
| `simple_profile.json` | Simple profile | `{age, sex, conditions, labs}` shape a frontend can send |

```sh
# What was read from the JSON and which queries would be sent (no API calls)
python clinicaltrial.py samples/labs_only_patient.json --profile-only

# Top matches with every criterion annotated: ✓ meets/clear  ✗ fails/excluded  ⚑ mentions your condition  · not checkable
python clinicaltrial.py samples/sample_patient.json --lat 42.34 --lon -71.07 --miles 25

# One specific trial, line by line
python clinicaltrial.py samples/sample_patient.json --nct NCT05759468

# Inline edits without making a file
python clinicaltrial.py '{"age": 70, "sex": "female", "conditions": ["atrial fibrillation"], "labs": {"egfr": 25}}' --limit 3

# More results, include rejected ones, compact view, or raw JSON
python clinicaltrial.py samples/sample_patient.json --limit 20 --all --brief
python clinicaltrial.py samples/sample_patient.json --json > /tmp/out.json
```

The same inputs work over HTTP while `app.py` runs:

```sh
curl -k -X POST "https://127.0.0.1:3000/api/trials/match?lat=42.34&lon=-71.07&miles=25" \
     -H "Content-Type: application/json" -d @samples/postpartum_prediabetes.json
```

Results are cached in memory for an hour per query, and requests are spaced to stay under ClinicalTrials.gov's ~50/minute limit.
