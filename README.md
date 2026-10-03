# Hackers & Healers

A local-first SMART on FHIR sync demo inspired by [FHIR_EPIC](https://github.com/narges-rzv/FHIR_EPIC). A patient connects through their health system's own sign-in and consent page. The app then syncs labs, vital signs, and medication requests, follows FHIR pagination links, stores records encrypted on the local machine, and displays a small CKM-oriented dashboard.

The patient completes the first MyChart sign-in and clicks Allow themselves. This app does not ask for, collect, or fill in MyChart passwords. It uses OAuth authorization code with PKCE and requests `offline_access` so it can refresh access when the health system grants a refresh token.

## Run the Epic sandbox demo

1. Create an app in the [Epic FHIR developer portal](https://fhir.epic.com/). Configure its redirect URI as `https://127.0.0.1:3000/callback` and enable the patient-facing read scopes and refresh/offline access supported by the app registration. Use its **non-production** Client ID for the Epic sandbox.
2. Copy `.env.example` to `.env`, then fill in your own client ID and client secret. Keep `.env` private; it is ignored by Git.
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

The default FHIR base URL is Epic's R4 sandbox: `https://fhir.epic.com/interconnect-fhir-oauth/api/FHIR/R4`. A local endpoint directory is refreshed from Epic weekly; choose an organization from the list before consent. You can set `FHIR_BASE_URL` and `HEALTH_SYSTEM_NAME` in `.env` to use a specific endpoint directly.

## What syncs

- `Observation?category=laboratory` for lab results, including common eGFR and A1c codes.
- `Observation?category=vital-signs` for blood pressure and other vitals.
- `MedicationRequest` for medication orders.
- Bundle `next` links are followed, with a page limit to avoid runaway requests.
- Later runs add a FHIR date lower bound based on the previous successful sync. Resources are upserted by a one-way hash of type and FHIR ID, so repeated pages do not duplicate rows.

The dashboard shows fetched record counts, latest eGFR, A1c history, and mean systolic/diastolic blood pressure when those values exist in the records. These summaries are informational and are not clinical advice.

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
- [SMART App Launch](https://hl7.org/fhir/smart-app-launch/)
