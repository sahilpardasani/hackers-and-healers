cd /Users/pavelovertchouk/projects/h2_project/hackers-and-healers
python3 -m venv .venv
source .venv/bin/activate
pip install -r requirements.txt

python app.py
# https://127.0.0.1:3000/

cd /Users/pavelovertchouk/projects/h2_project/hackers-and-healers/patient-agency-react
npm install
npm run dev


# Hackers & Healers

A local-first SMART on FHIR sync demo inspired by [FHIR_EPIC](https://github.com/narges-rzv/FHIR_EPIC). A patient connects through their health system's own sign-in and consent page. The app then syncs patient demographics, labs, vital signs, conditions, medication requests when enabled, appointments, and coverage; follows FHIR pagination links; stores records encrypted on the local machine; and displays them in a CKM-oriented dashboard.

The patient completes the first MyChart sign-in and clicks Allow themselves. This app does not ask for, collect, or fill in MyChart passwords. It uses OAuth authorization code with PKCE. `FHIR_SCOPES=` omits the scope parameter entirely, as in the reference repository. Persistent access must be explicitly configured with a compatible confidential registration and `offline_access`.

## Run the Epic sandbox demo

1. Create an app in the [Epic FHIR developer portal](https://fhir.epic.com/). Configure its redirect URI as `https://127.0.0.1:3000/callback` and enable the patient-facing read scopes and refresh/offline access supported by the app registration. Use its **non-production** Client ID for the Epic sandbox.
2. Copy `.env.example` to `.env`, then fill in your own non-production client ID. The example uses the verified sandbox flow, `EPIC_OAUTH_CLIENT_MODE=public`, with no secret. Match this to your Epic registration; a confidential registration instead requires `EPIC_OAUTH_CLIENT_MODE=confidential` and its matching sandbox secret. Keep `.env` private; it is ignored by Git.
3. Generate a local encryption key and add it to `.env`:

   ```sh
   python -c "import base64, secrets; print(base64.urlsafe_b64encode(secrets.token_bytes(32)).decode())"
   ```

   Set the printed value as `DATA_ENCRYPTION_KEY`. Keep a backup somewhere private: the encrypted local database cannot be read without this key.
4. Install and run:

   ```sh
   python -m venv .venv
   source .venv/bin/activate  # Windows: .venv\\Scripts\\activate
   pip install -r requirements.txt
   python app.py
   ```
5. Open <https://127.0.0.1:3000/>, choose the Epic sandbox, and complete the MyChart test-patient authorization in the browser. After consent, the first sync starts automatically. Use **Sync now** to run another sync on demand.

The server uses the scheme and port in `REDIRECT_URI`. HTTPS creates a persistent self-signed development certificate under ignored `data/local-tls/`, with its private key readable only by the current user. Your browser may ask you to accept this local certificate on the first visit. The app does not install a trusted root or disable TLS verification to Epic. HTTP remains supported if both your local configuration and Epic registration use HTTP.

If Epic shows **The request is invalid**, check the saved Endpoint URI against `REDIRECT_URI` character for character. `http://` and `https://` are different redirect URIs. A sandbox probe for this project returned an authorization error for HTTP but accepted HTTPS, so the local demo now defaults to HTTPS. Start each attempt with **Continue to MyChart**; signing into the sandbox MyChart home page directly does not authorize this app. Epic app-setting updates may take up to an hour to propagate.

### Public PKCE fallback

If Epic has registered the app as a **non-confidential** client, set `EPIC_OAUTH_CLIENT_MODE=public` and remove the client secret from local configuration. The app still uses S256 PKCE, omits HTTP Basic client authentication, and sends `client_id` in the token request as required by Epic's non-confidential flow. This mode is an explicit fallback: it only works for an Epic app registered as non-confidential, and it never persists or refreshes with a refresh token. The app also removes `offline_access` from the authorization request in this mode. Reconnect when the access token expires.

Match the token method to the Epic registration. `invalid_client` can indicate rejected credentials or an authentication-method mismatch; it does not identify which by itself. This project's sandbox flow was verified on October 3, 2026: a fresh patient-authorized login using public mode successfully exchanged the code, fetched FHIR records, saved them in the encrypted local database, and rendered the dashboard. Public mode never sends `CLIENT_SECRET`, even if it remains in the local environment. It requires reconnection after token expiry; it does not enable unattended daily refresh.

The default FHIR base URL is Epic's R4 sandbox: `https://fhir.epic.com/interconnect-fhir-oauth/api/FHIR/R4`. A local endpoint directory is refreshed from Epic weekly; choose an organization from the list before consent. You can set `FHIR_BASE_URL` and `HEALTH_SYSTEM_NAME` in `.env` to use a specific endpoint directly.

## What syncs

- `Observation?category=laboratory` for lab results, including common eGFR and A1c codes.
- `Observation?category=vital-signs` for blood pressure and other vitals.
- `Patient` for the authorized patient's demographics.
- `Condition` for the problem list.
- `MedicationRequest` and referenced `Medication` resources when the app registration grants those APIs.
- `Appointment` and `Coverage` for visit and insurance information.
- Bundle `next` links are followed, with a page limit to avoid runaway requests.
- Later runs add a FHIR date lower bound based on the previous successful sync. Resources are upserted by a one-way hash of type and FHIR ID, so repeated pages do not duplicate rows.
- If an optional API is not enabled or unavailable, successful resource types are still saved and the dashboard identifies the skipped category.

The dashboard shows the patient's demographics, recent labs and vitals, conditions, medications, appointments, coverage, fetched record counts, latest eGFR, A1c history, and mean systolic/diastolic blood pressure when those values exist in the records. Records are filtered by FHIR base URL so changing health systems cannot mix data on the dashboard. These summaries are informational and are not clinical advice.

## Try the fictional sample without Epic

After setting a local encryption key and starting the app, choose **Load sample records** on the home page. This imports the bundled fictional Maya fixture and opens `/sample`; `/sample.json` exposes that same synthetic FHIR bundle. The sample is stored separately from Epic records, does not create an OAuth connection, and is clearly labeled as fictional. No downloaded Epic patient data or credentials are included in this repository.

## Clinical trials

### Shared Camila sandbox snapshot

`fixtures/camila-epic-sandbox.json` is a minimized FHIR collection from Epic's documented **Camila test patient**, retrieved from the Epic R4 sandbox. It contains 1 Patient, 251 Observations, 1 MedicationRequest, and 2 Appointments from the saved snapshot. It is test data, not a real person's chart and not a complete medical history. No Condition resources were available in this export; absence is not evidence of no conditions.

Original resource IDs are replaced with fixture IDs, internal patient links are remapped, and contact details, identifiers, narratives, notes, provider identities, and API error payloads are omitted. Clinical measurements, codes, units, dates, and selected prescription/appointment fields remain. The sandbox birth date is retained to exercise age calculations. No OAuth tokens, API keys, client secrets, or encrypted database files are included.

Teammates can load this standard `Bundle.entry[].resource` array into their FHIR normalizer without signing in. It does not automatically replace the connected patient's database. For example, `clinicaltrial.profile_from_json(json.load(open('fixtures/camila-epic-sandbox.json')))` derives a local trial-search profile without contacting an external service. The guarded `scripts/export_camila_sandbox.py` prints a fresh minimized snapshot only when the local connection matches this exact documented sandbox patient; it refuses production endpoints and other patients.

Source: [Epic sandbox test data](https://fhir.epic.com/Documentation?docId=testpatients). The fixture is supplied only for development/testing and does not establish redistribution rights to other Epic materials.

Open the **Clinical trials** tab after syncing or loading the fictional sample. It previews a profile derived locally from the selected source's FHIR JSON, then asks permission to send search topics (and optional coordinates) to ClinicalTrials.gov's public API v2. No Epic secret is needed for trial listings, and names, identifiers, birth dates, medication lists, and lab values are not sent to ClinicalTrials.gov.

The matcher checks supported units, separates demo records from the connected patient, and labels lab-derived topics as suggestions—not diagnoses. Listings include reasons, potential barriers, unreviewed criteria, sites, and official study links. Results are limited and do not establish eligibility; old or incomplete records require study-team review. See [CLINICAL_TRIALS.md](CLINICAL_TRIALS.md) for JSON inputs and API details.

The separate React frontend also has a **Trials** tab. Start this Python backend, then run `npm install` and `npm run dev` in `patient-agency-react`; Vite proxies `/api/trials` to the local HTTPS backend. React sends a minimal profile from its own current record, not another patient stored in the Python database. A static GitHub Pages deployment alone cannot run this backend.

## Ask about your health

The **Ask about your health** tab explains the selected patient's record and optionally suggests retrieved clinical trials for discussion with a clinician. Both the Python dashboard and React frontend use the same server-side integration with NVIDIA's OpenAI-compatible API and `z-ai/glm-5.3` model.

Install the Python requirements, put `NVIDIA_API_KEY` in your private `.env`, optionally set `NVIDIA_MODEL`, and restart the backend. Never put the key in a `VITE_` variable or commit it. React's development server proxies `/api/health` to the Python backend; a static deployment cannot use this feature by itself.

Opening the tab creates a local context preview without contacting NVIDIA. Each submission requires consent to send that preview and the question to NVIDIA. Trial searches have a separate opt-in: condition/search topics go to ClinicalTrials.gov, and retrieved study details go to NVIDIA. Names, addresses, record IDs, and exact birth dates are excluded from structured context, but clinical labels and questions may still contain sensitive information. This is not guaranteed anonymization. Use fictional or sandbox data until provider agreements and a privacy/security review support real-patient use; no HIPAA-compliance or zero-retention claim is made.

Answers are independent, not a remembered conversation. The app does not persist question/answer transcripts or print provider responses. Provider retention policies still apply. A changed patient/context requires a new preview and consent. Recommended trial IDs must exist in the retrieved results; official links are generated by the backend, not trusted from model text. Clinical eligibility and medical accuracy are not guaranteed. The assistant is educational, does not diagnose or prescribe, and is not an emergency service.

If the model times out or produces an invalid answer after studies were retrieved, the UI keeps those official study links, explicitly labeled as search candidates rather than AI recommendations. No synthetic AI explanation is substituted.

## Tests

```sh
python -m unittest discover -s tests -v
```

## Privacy and operational limits

- OAuth tokens, patient identifiers, and FHIR resource payloads are encrypted in `data/hackers-healers.sqlite3` using `DATA_ENCRYPTION_KEY`. The entire `data/` directory and `.env` are excluded from Git.
- Tokens live in the local encrypted database; the app never prints them or patient records to the console. The web server binds only to `127.0.0.1`.
- Keep `python app.py` running for scheduled syncs. The scheduler runs once every 24 hours; the initial download and **Sync now** are also available.
- A refresh token is issued and renewed only if that health system's configuration permits it. If none is issued, the dashboard indicates that reconnection will be needed after the access token expires. Refresh-token lifetime and rotation are controlled by each health system.
- Epic is federated: each health system has its own FHIR endpoint and may require its own app registration, client credentials, scopes, and approval. The endpoint directory helps find endpoints; it does not grant access. This demo keeps one active health-system connection at a time.
- The scheduled job runs only while this local process is running. A reliable always-on multi-patient product needs a hosted service, tenant isolation, stronger operational controls, monitoring, and a deployment/security review.

## Configuration

See `.env.example`. Never commit `.env`, an encryption key, OAuth credentials, a SQLite database, or downloaded health records.

## References

- [Epic sandbox and customer endpoint directory](https://open.epic.com/MyApps/Endpoints?exp=default&v=1)
- [Epic developer resources](https://open.epic.com/DeveloperResources)
- [Epic OAuth 2.0 patient-facing app documentation](https://fhir.epic.com/Documentation?docId=patientfacingfhirapps&section=AutomaticClientDistribution)
- [SMART App Launch](https://hl7.org/fhir/smart-app-launch/)
