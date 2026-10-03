"""One-consent SMART-on-FHIR sync service and local CKM dashboard."""

from __future__ import annotations

import base64
import hashlib
import json
import logging
import os
import secrets
import threading
from datetime import datetime, timezone
from urllib.parse import quote, urlencode, urlparse

import requests
from apscheduler.schedulers.background import BackgroundScheduler
from dotenv import load_dotenv
from flask import Flask, abort, redirect, render_template, render_template_string, request, session, url_for

load_dotenv()

import endpoint_directory
import clinicaltrial
import health_assistant
import storage
from sample_data import SAMPLE_NAMESPACE, sample_resources
from ckm import summarize
from dashboard import appointment_views, condition_views, coverage_views, medication_views, observation_views, patient_view
from local_server import server_options

FHIR_BASE_URL = os.getenv("FHIR_BASE_URL", "https://fhir.epic.com/interconnect-fhir-oauth/api/FHIR/R4").strip().rstrip("/")
CLIENT_ID = os.getenv("CLIENT_ID", "").strip()
CLIENT_SECRET = os.getenv("CLIENT_SECRET", "").strip()
OAUTH_CLIENT_MODE = os.getenv("EPIC_OAUTH_CLIENT_MODE", "confidential").strip().lower()
if OAUTH_CLIENT_MODE not in {"confidential", "public"}:
    raise ValueError("EPIC_OAUTH_CLIENT_MODE must be 'confidential' or 'public'.")
REDIRECT_URI = os.getenv("REDIRECT_URI", "https://127.0.0.1:3000/callback").strip()
# Match the reference repo by omitting scope unless explicitly configured.
# Epic can grant access based on the APIs selected in the app registration.
SCOPES = os.getenv("FHIR_SCOPES", "").strip()
SYNC_HOUR = int(os.getenv("SYNC_HOUR", "3"))
FHIR_TIMEOUT = (5, 45)
MAX_PAGES_PER_QUERY = 100

app = Flask(__name__)
app.register_blueprint(clinicaltrial.trials)
app.register_blueprint(health_assistant.health)
app.secret_key = os.getenv("FLASK_SECRET_KEY") or secrets.token_hex(32)
app.config.update(SESSION_COOKIE_HTTPONLY=True, SESSION_COOKIE_SAMESITE="Lax",
                  SESSION_COOKIE_SECURE=urlparse(REDIRECT_URI).scheme == "https")
logging.getLogger("werkzeug").setLevel(logging.ERROR)

pending_auth: dict[str, dict[str, str]] = {}
sync_lock = threading.Lock()

SYNC_QUERIES = {
    "labs": ("Observation", {"category": "laboratory"}, "date"),
    "vitals": ("Observation", {"category": "vital-signs"}, "date"),
    "conditions": ("Condition", {"category": "problem-list-item"}, None),
    "medications": ("MedicationRequest", {}, "authoredon"),
    "appointments": ("Appointment", {}, "date"),
    "coverage": ("Coverage", {}, "_lastUpdated"),
}

PAGE = """<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Hackers &amp; Healers</title><style>
:root{font:16px/1.5 system-ui,sans-serif;color-scheme:light dark}body{max-width:1050px;margin:36px auto;padding:0 20px}
h1{font-size:2rem}.muted{opacity:.72}.card{border:1px solid #8885;border-radius:12px;padding:20px;margin:18px 0}
.metrics{display:grid;grid-template-columns:repeat(auto-fit,minmax(190px,1fr));gap:12px}.metric{border:1px solid #8885;border-radius:10px;padding:16px}
.metric strong{display:block;font-size:1.5rem;margin-top:6px}button,.button{border:0;border-radius:8px;background:#635bff;color:white;padding:10px 16px;font:inherit;text-decoration:none;cursor:pointer}
.split{display:grid;grid-template-columns:repeat(auto-fit,minmax(320px,1fr));gap:18px}.empty{opacity:.7}
.warning{border-left:4px solid #d99000;padding:10px 14px;background:#d9900018}.rows{overflow:auto}table{border-collapse:collapse;width:100%}td,th{text-align:left;padding:8px;border-bottom:1px solid #8885}form.inline{display:inline}
</style></head><body><h1>Hackers &amp; Healers</h1><p class="muted">Patient-authorized FHIR sync · local CKM dashboard</p>
<p class="warning"><strong>Private health data:</strong> use the Epic sandbox or your own authorized account. You complete the MyChart sign-in and consent. The app never asks for or stores your MyChart password. Local records and refresh tokens are encrypted using your local key.</p>
{% if error %}<p class="warning">{{ error }}</p>{% endif %}
{% if not connection %}<section class="card"><h2>Connect a health system</h2>
{% if not client_ready %}<p>Add <code>CLIENT_ID</code>, <code>CLIENT_SECRET</code>, and <code>DATA_ENCRYPTION_KEY</code> to your local <code>.env</code> first.</p>
{% else %}<p>Select a portal. You will sign in directly with that health system and approve access there.</p>
<form method="post" action="{{ url_for('connect') }}"><label for="endpoint">Health system</label><br><select id="endpoint" name="endpoint" required>{% for item in endpoints %}<option value="{{ item.url }}">{{ item.name }}</option>{% endfor %}</select> <button>Continue to MyChart</button></form>{% endif %}
<form method="post" action="{{ url_for('refresh_endpoint_directory') }}"><button class="button">Refresh health system list</button></form>
<p class="muted">The list is cached locally and refreshed weekly from Epic’s published endpoint directory.</p></section>
{% else %}<section class="card"><h2>Sync status</h2><p>Connected to <code>{{ connection.display_name or connection.fhir_base_url }}</code></p>
<p>Last sync: {{ last_sync or 'Not synced yet' }} · {{ 'Daily sync enabled' if connection.refresh_token else 'Reconnect required after this session expires' }}</p>
<form class="inline" method="post" action="{{ url_for('sync_now') }}"><button>Sync now</button></form>
<form class="inline" method="post" action="{{ url_for('disconnect') }}"><button>Disconnect</button></form></section>
{% if sync_warnings %}<p class="warning">Some optional record categories were unavailable from this Epic app: {{ sync_warnings|join(', ') }}. Other records were still saved.</p>{% endif %}
<section class="card"><h2>Patient</h2><p><strong>{{ patient.name }}</strong></p><p class="muted">Birth date: {{ patient.birth_date }} · Gender: {{ patient.gender }}</p></section>
<section class="card"><h2>CKM overview</h2><div class="metrics">
<div class="metric">Latest eGFR<strong>{{ metric_text(metrics.latest_egfr) }}</strong></div>
<div class="metric">Average blood pressure<strong>{{ pressure_text(metrics) }}</strong><span class="muted">{{ metrics.blood_pressure_count }} readings</span></div>
<div class="metric">A1c results<strong>{{ metrics.a1c_trend|length }}</strong><span class="muted">available in trend below</span></div>
</div><p class="muted">These summaries describe the imported records; they are not clinical advice.</p>
{% if metrics.a1c_trend %}<h3>A1c trend</h3><div class="rows"><table><thead><tr><th>Date</th><th>Result</th><th>Test</th></tr></thead><tbody>{% for row in metrics.a1c_trend|reverse %}<tr><td>{{ row.date or 'Date unavailable' }}</td><td>{{ row.value }} {{ row.unit }}</td><td>{{ row.display }}</td></tr>{% endfor %}</tbody></table></div>{% endif %}</section>
<div class="split"><section class="card"><h2>Recent labs</h2>{% if labs %}<div class="rows"><table><thead><tr><th>Date</th><th>Test</th><th>Result</th></tr></thead><tbody>{% for row in labs %}<tr><td>{{ row.date }}</td><td>{{ row.display }}</td><td>{{ row.value }}</td></tr>{% endfor %}</tbody></table></div>{% else %}<p class="empty">No lab results synced.</p>{% endif %}</section>
<section class="card"><h2>Recent vitals</h2>{% if vitals %}<div class="rows"><table><thead><tr><th>Date</th><th>Measurement</th><th>Value</th></tr></thead><tbody>{% for row in vitals %}<tr><td>{{ row.date }}</td><td>{{ row.display }}</td><td>{{ row.value }}</td></tr>{% endfor %}</tbody></table></div>{% else %}<p class="empty">No vital signs synced.</p>{% endif %}</section></div>
<div class="split"><section class="card"><h2>Problems</h2>{% if conditions %}<div class="rows"><table><thead><tr><th>Condition</th><th>Status</th><th>Onset</th></tr></thead><tbody>{% for row in conditions %}<tr><td>{{ row.display }}</td><td>{{ row.status }}</td><td>{{ row.onset }}</td></tr>{% endfor %}</tbody></table></div>{% else %}<p class="empty">No problems synced.</p>{% endif %}</section>
<section class="card"><h2>Medications</h2>{% if medications %}<div class="rows"><table><thead><tr><th>Medication</th><th>Status</th><th>Instructions</th></tr></thead><tbody>{% for row in medications %}<tr><td>{{ row.display }}</td><td>{{ row.status }}</td><td>{{ row.details }}</td></tr>{% endfor %}</tbody></table></div>{% else %}<p class="empty">No medication orders available. The Epic app may need MedicationRequest access.</p>{% endif %}</section></div>
<div class="split"><section class="card"><h2>Upcoming appointments</h2>{% if appointments %}<div class="rows"><table><thead><tr><th>Date</th><th>Visit</th><th>Status</th></tr></thead><tbody>{% for row in appointments %}<tr><td>{{ row.date }}</td><td>{{ row.display }}</td><td>{{ row.status }}</td></tr>{% endfor %}</tbody></table></div>{% else %}<p class="empty">No appointments synced.</p>{% endif %}</section>
<section class="card"><h2>Insurance coverage</h2>{% if coverage %}<div class="rows"><table><thead><tr><th>Plan</th><th>Status</th><th>Period</th></tr></thead><tbody>{% for row in coverage %}<tr><td>{{ row.display }}</td><td>{{ row.status }}</td><td>{{ row.period }}</td></tr>{% endfor %}</tbody></table></div>{% else %}<p class="empty">No coverage records synced.</p>{% endif %}</section></div>
<section class="card"><h2>Synced records</h2>{% if counts %}<div class="rows"><table><thead><tr><th>FHIR type</th><th>Records</th></tr></thead><tbody>{% for kind,count in counts.items() %}<tr><td>{{ kind }}</td><td>{{ count }}</td></tr>{% endfor %}</tbody></table></div>{% else %}<p>No records synced yet.</p>{% endif %}</section>{% endif %}
<p class="muted">This demo runs on this computer at <code>127.0.0.1</code>. Stop it to stop scheduled syncs.</p><footer class="muted"><a href="{{ url_for('terms') }}">Terms and Conditions (Draft)</a></footer></body></html>"""


def _sid() -> str:
    if not session.get("sid"):
        session["sid"] = secrets.token_urlsafe(24)
    return str(session["sid"])


def _metadata(base_url: str) -> dict:
    headers = {"Accept": "application/json"}
    if CLIENT_ID:
        headers["Epic-Client-ID"] = CLIENT_ID
    response = requests.get(f"{base_url}/.well-known/smart-configuration", headers=headers, timeout=FHIR_TIMEOUT)
    response.raise_for_status()
    metadata = response.json()
    if not metadata.get("authorization_endpoint") or not metadata.get("token_endpoint"):
        raise ValueError("FHIR discovery document did not provide OAuth endpoints.")
    return metadata


def _b64url(value: bytes) -> str:
    return base64.urlsafe_b64encode(value).rstrip(b"=").decode("ascii")


def _client_auth_header() -> dict[str, str]:
    # Epic's confidential-client flow expects URL-encoded client credentials
    # in HTTP Basic auth, rather than client_id/client_secret in the form body.
    encoded = f"{quote(CLIENT_ID, safe='')}:{quote(CLIENT_SECRET, safe='')}".encode("ascii")
    return {"Authorization": f"Basic {base64.b64encode(encoded).decode('ascii')}"}


def _token_request(mode: str, data: dict[str, str]) -> tuple[dict[str, str], dict[str, str]]:
    """Build Epic's token request without mixing public and confidential auth."""
    if mode == "public":
        # Epic's non-confidential flow authenticates with the public client ID in
        # the form body. It must not send a Basic header or a client secret.
        return {**data, "client_id": CLIENT_ID}, {"Accept": "application/json"}
    if mode == "confidential":
        return data, {"Accept": "application/json", **_client_auth_header()}
    raise ValueError("Unsupported OAuth client mode.")


def _authorization_scopes(mode: str) -> str:
    """Do not ask a public client for Epic's refresh-token scope."""
    scopes = SCOPES.split()
    if mode == "public":
        scopes = [scope for scope in scopes if scope != "offline_access"]
    return " ".join(scopes)


def _configured_client_ready() -> bool:
    return bool(CLIENT_ID and os.getenv("DATA_ENCRYPTION_KEY")
                and (OAUTH_CLIENT_MODE == "public" or CLIENT_SECRET))


def _safe_oauth_error_code(response) -> str:
    """Return only a known OAuth error code; never expose a response body."""
    try:
        payload = response.json()
    except (TypeError, ValueError):
        return ""
    if not isinstance(payload, dict):
        return ""
    error = payload.get("error")
    known_errors = {"invalid_client", "invalid_grant", "invalid_scope", "unauthorized_client"}
    return error if isinstance(error, str) and error in known_errors else ""


def _token_exchange_error(status, error_code: str, mode: str) -> str:
    detail = f", error {error_code}" if error_code else ""
    if error_code == "invalid_client":
        if mode == "public":
            guidance = "Confirm the Epic app is registered as non-confidential and that public PKCE mode is selected."
        else:
            guidance = "Verify the non-production Client ID, matching Sandbox secret, and confidential app registration."
        return f"Epic rejected the token exchange (HTTP {status}{detail}). {guidance}"
    if error_code == "invalid_grant":
        return f"Epic rejected the token exchange (HTTP {status}{detail}). The authorization code may be expired or already used; start a fresh connection."
    return f"Epic rejected the token exchange (HTTP {status}{detail}). Verify the app registration and exact redirect URI."


def _known_endpoints() -> list[dict]:
    endpoints = endpoint_directory.load()
    endpoints.insert(0, {"name": os.getenv("HEALTH_SYSTEM_NAME", "Epic sandbox"), "url": FHIR_BASE_URL})
    unique = {}
    for item in endpoints:
        if item.get("url", "").startswith("https://"):
            unique[item["url"].rstrip("/")] = {"name": item.get("name") or "Health system", "url": item["url"].rstrip("/")}
    return list(unique.values())


def _refresh_connection(connection: dict) -> dict:
    expires = int(connection.get("expires_at", 0))
    if connection.get("access_token") and expires > int(datetime.now(timezone.utc).timestamp()) + 90:
        return connection
    mode = connection.get("oauth_client_mode", OAUTH_CLIENT_MODE)
    if mode == "public":
        raise ValueError("Public PKCE mode does not retain refresh tokens. Reconnect to continue syncing.")
    refresh_token = connection.get("refresh_token")
    if not refresh_token:
        raise ValueError("The access token expired and this server did not issue a refresh token. Reconnect to continue syncing.")
    data, headers = _token_request(mode, {
        "grant_type": "refresh_token", "refresh_token": refresh_token,
    })
    response = requests.post(
        connection["token_endpoint"],
        data=data,
        headers=headers,
        timeout=FHIR_TIMEOUT,
    )
    response.raise_for_status()
    tokens = response.json()
    connection["access_token"] = tokens["access_token"]
    connection["refresh_token"] = tokens.get("refresh_token", refresh_token)
    connection["expires_at"] = int(datetime.now(timezone.utc).timestamp()) + int(tokens.get("expires_in", 3600))
    storage.save_connection(connection)
    return connection


def _fhir_get(url: str, token: str, base_url: str) -> dict:
    response = requests.get(url, headers={"Authorization": f"Bearer {token}", "Accept": "application/fhir+json"}, timeout=FHIR_TIMEOUT)
    response.raise_for_status()
    parsed = response.json()
    if not isinstance(parsed, dict):
        raise ValueError("FHIR server returned a non-object response.")
    return parsed


def fetch_resource(connection: dict, resource_type: str, resource_id: str) -> dict:
    """Read one resource while keeping the request on the selected FHIR host."""
    base = connection["fhir_base_url"].rstrip("/")
    base_parts = urlparse(base)
    safe_id = quote(str(resource_id), safe="")
    url = f"{base}/{resource_type}/{safe_id}"
    parts = urlparse(url)
    if parts.scheme != "https" or parts.netloc != base_parts.netloc:
        raise ValueError("FHIR resource URL did not remain on the approved HTTPS host.")
    return _fhir_get(url, connection["access_token"], base)


def fetch_bundle(connection: dict, resource_type: str, params: dict) -> list[dict]:
    token = connection["access_token"]
    base = connection["fhir_base_url"].rstrip("/")
    url = f"{base}/{resource_type}" + (f"?{urlencode(params)}" if params else "")
    collected = []
    for _ in range(MAX_PAGES_PER_QUERY):
        bundle = _fhir_get(url, token, base)
        if bundle.get("resourceType") != "Bundle":
            collected.append(bundle)
            break
        collected.extend(entry.get("resource", {}) for entry in bundle.get("entry", []) if isinstance(entry.get("resource"), dict))
        next_url = next((link.get("url") for link in bundle.get("link", []) if link.get("relation") == "next"), None)
        if not next_url:
            break
        next_parts, base_parts = urlparse(next_url), urlparse(base)
        if next_parts.scheme != "https" or next_parts.netloc != base_parts.netloc:
            raise ValueError("FHIR pagination link did not remain on the approved HTTPS host.")
        url = next_url
    else:
        raise ValueError("FHIR result exceeded the pagination safety limit; sync cursor was not advanced.")
    return collected


def sync_connection(connection: dict, last_sync_at: str | None) -> dict:
    connection = _refresh_connection(connection)
    patient_id = connection.get("patient_id")
    if not patient_id:
        raise ValueError("The authorization response did not include patient context.")
    since = last_sync_at or ""
    fetched: list[dict] = []
    counts: dict[str, int] = {}
    warnings: list[str] = []

    try:
        patient = fetch_resource(connection, "Patient", patient_id)
        fetched.append(patient)
        counts["patient"] = 1
    except (requests.RequestException, ValueError) as exc:
        raise ValueError("The patient record could not be read from the selected FHIR server.") from exc

    for label, (resource_type, params, date_param) in SYNC_QUERIES.items():
        query = {**params, "patient": patient_id, "_count": "100"}
        if since and date_param:
            query[date_param] = f"ge{since}"
        try:
            resources = fetch_bundle(connection, resource_type, query)
        except (requests.RequestException, ValueError):
            # A patient-facing Epic app may not have every optional API enabled.
            # Keep successful resource types and tell the dashboard which ones were skipped.
            warnings.append(label)
            counts[label] = 0
            continue
        fetched.extend(resources)
        counts[label] = len(resources)

    medication_references = {
        item.get("medicationReference", {}).get("reference", "").split("/")[-1]
        for item in fetched
        if item.get("resourceType") == "MedicationRequest"
        and item.get("medicationReference", {}).get("reference", "").startswith("Medication/")
    }
    medication_details = 0
    for medication_id in medication_references:
        try:
            fetched.append(fetch_resource(connection, "Medication", medication_id))
            medication_details += 1
        except (requests.RequestException, ValueError):
            warnings.append("medication details")
    if medication_details:
        counts["medication_details"] = medication_details

    stored = storage.save_resources(fetched, namespace=connection["fhir_base_url"])
    synced_at = datetime.now(timezone.utc).replace(microsecond=0).isoformat().replace("+00:00", "Z")
    connection["last_sync_warnings"] = warnings
    storage.save_connection(connection, last_sync_at=synced_at)
    return {"counts": counts, "stored": stored, "synced_at": synced_at, "warnings": warnings}


def daily_sync() -> None:
    if not sync_lock.acquire(blocking=False):
        return
    try:
        item = storage.load_connection()
        if item:
            connection, last_sync_at = item
            sync_connection(connection, last_sync_at)
    except Exception:
        # Avoid logging patient data, tokens, or server response bodies.
        app.logger.warning("Scheduled FHIR sync failed; check the local dashboard and reconnect if needed.")
    finally:
        sync_lock.release()


@app.get("/")
def index():
    connection_item = storage.load_connection()
    connection = connection_item[0] if connection_item else None
    last_sync = connection_item[1] if connection_item else None
    return _render_dashboard(connection, last_sync)


@app.post("/sample/load")
def load_sample():
    storage.save_resources(sample_resources(), namespace=SAMPLE_NAMESPACE)
    return redirect(url_for("sample_dashboard"))


@app.get("/sample")
def sample_dashboard():
    if not storage.record_counts(namespace=SAMPLE_NAMESPACE):
        return redirect(url_for("index"))
    return _render_dashboard({"fhir_base_url": SAMPLE_NAMESPACE,
                              "display_name": "Maya — synthetic sample data"},
                             None, sample_mode=True)


@app.get("/sample.json")
def sample_json():
    records = storage.load_resources(namespace=SAMPLE_NAMESPACE)
    return {"resourceType": "Bundle", "type": "collection",
            "meta": {"tag": [{"code": "synthetic", "display": "Fictional Maya demo; not Epic data"}]},
            "entry": [{"resource": record} for record in records]}


def _render_dashboard(connection, last_sync, sample_mode=False):
    error = request.args.get("error")
    namespace = connection.get("fhir_base_url") if connection else None
    records = storage.load_resources(namespace=namespace) if connection else []
    labs, vitals = observation_views(records)
    metrics = summarize(records)
    return render_template(
        "index.html",
        error=error,
        sample_mode=sample_mode,
        connection=connection,
        base_url=FHIR_BASE_URL,
        endpoints=_known_endpoints(),
        client_ready=_configured_client_ready(),
        last_sync=last_sync,
        counts=storage.record_counts(namespace=namespace) if connection else {},
        metrics=metrics,
        patient=patient_view(records) if connection else {},
        labs=labs,
        vitals=vitals,
        conditions=condition_views(records),
        medications=medication_views(records),
        appointments=appointment_views(records),
        coverage=coverage_views(records),
        sync_warnings=connection.get("last_sync_warnings", []) if connection else [],
        metric_text=lambda item: f"{item['value']:g} {item['unit']}" if item else "No result",
        pressure_text=lambda item: f"{item['systolic_average'] or '—'}/{item['diastolic_average'] or '—'} mmHg",
    )


@app.get("/terms")
def terms():
    """Show draft terms for the local prototype; not yet legally operative."""
    return render_template("terms.html")


@app.post("/connect")
def connect():
    if request.form.get("consent") != "yes":
        return redirect(url_for("index", error="Please acknowledge the privacy and medical-information notice before connecting."))
    if not _configured_client_ready():
        return redirect(url_for("index", error="OAuth configuration is incomplete for the selected client mode. Check CLIENT_ID, DATA_ENCRYPTION_KEY, and CLIENT_SECRET when using confidential mode."))
    selected_url = request.form.get("endpoint", "").rstrip("/")
    selected = next((item for item in _known_endpoints() if item["url"] == selected_url), None)
    if not selected:
        abort(400, "Choose a health system from the published list.")
    try:
        metadata = _metadata(selected_url)
    except (requests.RequestException, ValueError):
        return redirect(url_for("index", error="Could not read the selected FHIR server's SMART configuration."))
    verifier = _b64url(secrets.token_bytes(48))
    state = secrets.token_urlsafe(32)
    pending_auth[_sid()] = {"state": state, "verifier": verifier, "base_url": selected_url, "display_name": selected["name"], "auth_endpoint": metadata["authorization_endpoint"], "token_endpoint": metadata["token_endpoint"], "oauth_client_mode": OAUTH_CLIENT_MODE}
    params = {
        "response_type": "code", "client_id": CLIENT_ID, "redirect_uri": REDIRECT_URI,
        "aud": selected_url, "state": state,
        "code_challenge": _b64url(hashlib.sha256(verifier.encode()).digest()), "code_challenge_method": "S256",
    }
    scopes = _authorization_scopes(OAUTH_CLIENT_MODE)
    if scopes:
        params["scope"] = scopes
    query = urlencode(params)
    return redirect(f"{metadata['authorization_endpoint']}?{query}")


@app.get("/callback")
def callback():
    sid = _sid()
    pending = pending_auth.get(sid)
    if not pending:
        return redirect(url_for("index", error="This sign-in attempt expired or the app restarted. Start a fresh connection."))
    if not secrets.compare_digest(request.args.get("state", ""), pending["state"]):
        pending_auth.pop(sid, None)
        return redirect(url_for("index", error="OAuth state did not match. For your security, start a fresh connection."))
    pending_auth.pop(sid, None)
    oauth_error = request.args.get("error")
    if oauth_error:
        messages = {
            "access_denied": "The patient declined access. No connection was saved.",
            "invalid_client": "Epic did not recognize this app. Verify the non-production Client ID, exact redirect URI, and Sandbox readiness.",
            "invalid_scope": "Epic rejected a requested scope. Check the APIs selected for this app and start again after Sandbox sync.",
            "unauthorized_client": "Epic has not enabled this app for the Sandbox yet. Check its status and try again after settings sync.",
        }
        return redirect(url_for("index", error=messages.get(oauth_error, "Epic returned an OAuth authorization error. Verify the app settings and start again.")))
    code = request.args.get("code", "")
    if not code:
        abort(400, "The FHIR server did not return an authorization code.")
    mode = pending.get("oauth_client_mode", OAUTH_CLIENT_MODE)
    try:
        data, headers = _token_request(mode, {
            "grant_type": "authorization_code", "code": code, "redirect_uri": REDIRECT_URI,
            "code_verifier": pending["verifier"],
        })
        response = requests.post(
            pending["token_endpoint"],
            data=data, headers=headers, timeout=FHIR_TIMEOUT,
        )
        response.raise_for_status()
        tokens = response.json()
        if not isinstance(tokens, dict) or not tokens.get("access_token") or not tokens.get("patient"):
            raise ValueError("Missing access token or patient context.")
        connection = {
            "display_name": pending["display_name"],
            "fhir_base_url": pending["base_url"], "token_endpoint": pending["token_endpoint"],
            "patient_id": tokens["patient"], "access_token": tokens["access_token"],
            # Public clients intentionally do not persist refresh tokens, even
            # if an endpoint returns one contrary to its registration.
            "oauth_client_mode": mode,
            "refresh_token": tokens.get("refresh_token", "") if mode == "confidential" else "",
            "expires_at": int(datetime.now(timezone.utc).timestamp()) + int(tokens.get("expires_in", 3600)),
        }
        storage.save_connection(connection)
        threading.Thread(target=_first_sync, args=(connection,), daemon=True).start()
    except requests.HTTPError as exc:
        status = exc.response.status_code if exc.response is not None else "unknown"
        error_code = _safe_oauth_error_code(exc.response) if exc.response is not None else ""
        return redirect(url_for("index", error=_token_exchange_error(status, error_code, mode)))
    except (requests.RequestException, ValueError, RuntimeError):
        return redirect(url_for("index", error="Connection could not be saved. Check app settings and ensure local encryption is configured."))
    return redirect(url_for("index"))


def _first_sync(connection: dict) -> None:
    if not sync_lock.acquire(blocking=False):
        return
    try:
        sync_connection(connection, None)
    except Exception:
        app.logger.warning("Initial FHIR sync failed; check the local dashboard and reconnect if needed.")
    finally:
        sync_lock.release()


@app.post("/sync")
def sync_now():
    try:
        item = storage.load_connection()
        if not item:
            return redirect(url_for("index", error="Connect your health system first."))
        if not sync_lock.acquire(blocking=False):
            return redirect(url_for("index", error="A sync is already running."))
        try:
            result = sync_connection(*item)
        finally:
            sync_lock.release()
        warning_text = f" Optional APIs unavailable: {', '.join(result['warnings'])}." if result["warnings"] else ""
        return redirect(url_for("index", error=f"Sync complete: {result['counts'].get('labs', 0)} labs, {result['counts'].get('vitals', 0)} vitals, {result['counts'].get('conditions', 0)} conditions, and {result['counts'].get('appointments', 0)} appointments fetched.{warning_text}"))
    except Exception:
        return redirect(url_for("index", error="Sync failed. The local dashboard did not record server response details."))


@app.post("/disconnect")
def disconnect():
    storage.clear_connection()
    return redirect(url_for("index"))


def start_scheduler() -> None:
    scheduler = BackgroundScheduler(timezone="UTC")
    scheduler.add_job(daily_sync, "cron", hour=SYNC_HOUR, id="daily-fhir-sync", max_instances=1, coalesce=True)
    scheduler.add_job(_refresh_directory_if_stale, "interval", days=7, id="epic-directory-refresh", max_instances=1, coalesce=True)
    scheduler.start()
    app.extensions["fhir_scheduler"] = scheduler


def _refresh_directory_if_stale() -> None:
    if endpoint_directory.cache_is_stale():
        try:
            endpoint_directory.refresh()
        except Exception:
            app.logger.warning("Epic endpoint list could not be refreshed; the saved list remains available.")


@app.post("/refresh-endpoint-directory")
def refresh_endpoint_directory():
    try:
        count = endpoint_directory.refresh()
        message = f"Health system list refreshed ({count} FHIR endpoints)."
    except Exception:
        message = "The directory could not be refreshed. Try again later."
    return redirect(url_for("index", error=message))


if __name__ == "__main__":
    # Validate and prepare the callback transport before starting background work.
    run_options = server_options(REDIRECT_URI)
    try:
        start_scheduler()
    except RuntimeError:
        app.logger.warning("Daily scheduler could not start.")
    if endpoint_directory.cache_is_stale():
        threading.Thread(target=_refresh_directory_if_stale, daemon=True).start()
    callback_url = urlparse(REDIRECT_URI)
    print(f"Open {callback_url.scheme}://{callback_url.netloc}/. Keep this process running for scheduled syncs.")
    if callback_url.scheme == "https":
        print("Local HTTPS uses a self-signed development certificate in data/local-tls.")
    app.run(**run_options, debug=False, use_reloader=False)
