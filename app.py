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
import storage
from ckm import summarize
from local_server import server_options

FHIR_BASE_URL = os.getenv("FHIR_BASE_URL", "https://fhir.epic.com/interconnect-fhir-oauth/api/FHIR/R4").strip().rstrip("/")
CLIENT_ID = os.getenv("CLIENT_ID", "").strip()
CLIENT_SECRET = os.getenv("CLIENT_SECRET", "").strip()
REDIRECT_URI = os.getenv("REDIRECT_URI", "https://127.0.0.1:3000/callback").strip()
# Epic derives resource scopes from the APIs selected in the app registration.
# Request only standalone patient context and refresh access here; a broad
# wildcard resource scope can be rejected when it is not enabled by Epic.
SCOPES = os.getenv("FHIR_SCOPES", "launch/patient offline_access").strip()
SYNC_HOUR = int(os.getenv("SYNC_HOUR", "3"))
FHIR_TIMEOUT = (5, 45)
MAX_PAGES_PER_QUERY = 100

app = Flask(__name__)
app.secret_key = os.getenv("FLASK_SECRET_KEY") or secrets.token_hex(32)
app.config.update(SESSION_COOKIE_HTTPONLY=True, SESSION_COOKIE_SAMESITE="Lax",
                  SESSION_COOKIE_SECURE=urlparse(REDIRECT_URI).scheme == "https")
logging.getLogger("werkzeug").setLevel(logging.ERROR)

pending_auth: dict[str, dict[str, str]] = {}
sync_lock = threading.Lock()

SYNC_QUERIES = {
    "labs": ("Observation", {"category": "laboratory"}, "date"),
    "vitals": ("Observation", {"category": "vital-signs"}, "date"),
    "medications": ("MedicationRequest", {}, "authoredon"),
}

PAGE = """<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Hackers &amp; Healers</title><style>
:root{font:16px/1.5 system-ui,sans-serif;color-scheme:light dark}body{max-width:1050px;margin:36px auto;padding:0 20px}
h1{font-size:2rem}.muted{opacity:.72}.card{border:1px solid #8885;border-radius:12px;padding:20px;margin:18px 0}
.metrics{display:grid;grid-template-columns:repeat(auto-fit,minmax(190px,1fr));gap:12px}.metric{border:1px solid #8885;border-radius:10px;padding:16px}
.metric strong{display:block;font-size:1.5rem;margin-top:6px}button,.button{border:0;border-radius:8px;background:#635bff;color:white;padding:10px 16px;font:inherit;text-decoration:none;cursor:pointer}
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
<section class="card"><h2>CKM overview</h2><div class="metrics">
<div class="metric">Latest eGFR<strong>{{ metric_text(metrics.latest_egfr) }}</strong></div>
<div class="metric">Average blood pressure<strong>{{ pressure_text(metrics) }}</strong><span class="muted">{{ metrics.blood_pressure_count }} readings</span></div>
<div class="metric">A1c results<strong>{{ metrics.a1c_trend|length }}</strong><span class="muted">available in trend below</span></div>
</div><p class="muted">These summaries describe the imported records; they are not clinical advice.</p>
{% if metrics.a1c_trend %}<h3>A1c trend</h3><div class="rows"><table><thead><tr><th>Date</th><th>Result</th><th>Test</th></tr></thead><tbody>{% for row in metrics.a1c_trend|reverse %}<tr><td>{{ row.date or 'Date unavailable' }}</td><td>{{ row.value }} {{ row.unit }}</td><td>{{ row.display }}</td></tr>{% endfor %}</tbody></table></div>{% endif %}</section>
<section class="card"><h2>Synced records</h2>{% if counts %}<div class="rows"><table><thead><tr><th>FHIR type</th><th>Records</th></tr></thead><tbody>{% for kind,count in counts.items() %}<tr><td>{{ kind }}</td><td>{{ count }}</td></tr>{% endfor %}</tbody></table></div>{% else %}<p>No records synced yet.</p>{% endif %}</section>{% endif %}
<p class="muted">This demo runs on this computer at <code>127.0.0.1</code>. Stop it to stop scheduled syncs.</p><footer class="muted"><a href="{{ url_for('terms') }}">Terms and Conditions (Draft)</a></footer></body></html>"""


def _sid() -> str:
    if not session.get("sid"):
        session["sid"] = secrets.token_urlsafe(24)
    return str(session["sid"])


def _metadata(base_url: str) -> dict:
    response = requests.get(f"{base_url}/.well-known/smart-configuration", headers={"Accept": "application/json"}, timeout=FHIR_TIMEOUT)
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
    refresh_token = connection.get("refresh_token")
    if not refresh_token:
        raise ValueError("The access token expired and this server did not issue a refresh token. Reconnect to continue syncing.")
    response = requests.post(
        connection["token_endpoint"],
        data={"grant_type": "refresh_token", "refresh_token": refresh_token},
        headers={"Accept": "application/json", **_client_auth_header()},
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


def fetch_bundle(connection: dict, resource_type: str, params: dict) -> list[dict]:
    token = connection["access_token"]
    base = connection["fhir_base_url"].rstrip("/")
    url = f"{base}/{resource_type}?{urlencode(params)}"
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
    for label, (resource_type, params, date_param) in SYNC_QUERIES.items():
        query = {**params, "patient": patient_id, "_count": "100"}
        if since:
            query[date_param] = f"ge{since}"
        resources = fetch_bundle(connection, resource_type, query)
        fetched.extend(resources)
        counts[label] = len(resources)
    stored = storage.save_resources(fetched, namespace=connection["fhir_base_url"])
    synced_at = datetime.now(timezone.utc).replace(microsecond=0).isoformat().replace("+00:00", "Z")
    storage.save_connection(connection, last_sync_at=synced_at)
    return {"counts": counts, "stored": stored, "synced_at": synced_at}


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
    error = request.args.get("error")
    connection_item = storage.load_connection()
    connection = connection_item[0] if connection_item else None
    last_sync = connection_item[1] if connection_item else None
    records = storage.load_resources("Observation") if connection else []
    metrics = summarize(records)
    return render_template_string(
        PAGE,
        error=error,
        connection=connection,
        base_url=FHIR_BASE_URL,
        endpoints=_known_endpoints(),
        client_ready=bool(CLIENT_ID and CLIENT_SECRET and os.getenv("DATA_ENCRYPTION_KEY")),
        last_sync=last_sync,
        counts=storage.record_counts() if connection else {},
        metrics=metrics,
        metric_text=lambda item: f"{item['value']:g} {item['unit']}" if item else "No result",
        pressure_text=lambda item: f"{item['systolic_average'] or '—'}/{item['diastolic_average'] or '—'} mmHg",
    )


@app.get("/terms")
def terms():
    """Show draft terms for the local prototype; not yet legally operative."""
    return render_template("terms.html")


@app.post("/connect")
def connect():
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
    pending_auth[_sid()] = {"state": state, "verifier": verifier, "base_url": selected_url, "display_name": selected["name"], "auth_endpoint": metadata["authorization_endpoint"], "token_endpoint": metadata["token_endpoint"]}
    query = urlencode({
        "response_type": "code", "client_id": CLIENT_ID, "redirect_uri": REDIRECT_URI,
        "aud": selected_url, "scope": SCOPES, "state": state,
        "code_challenge": _b64url(hashlib.sha256(verifier.encode()).digest()), "code_challenge_method": "S256",
    })
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
    try:
        response = requests.post(
            pending["token_endpoint"],
            data={"grant_type": "authorization_code", "code": code, "redirect_uri": REDIRECT_URI,
                  "code_verifier": pending["verifier"]},
            headers={"Accept": "application/json", **_client_auth_header()}, timeout=FHIR_TIMEOUT,
        )
        response.raise_for_status()
        tokens = response.json()
        if not tokens.get("access_token") or not tokens.get("patient"):
            raise ValueError("Missing access token or patient context.")
        connection = {
            "display_name": pending["display_name"],
            "fhir_base_url": pending["base_url"], "token_endpoint": pending["token_endpoint"],
            "patient_id": tokens["patient"], "access_token": tokens["access_token"],
            "refresh_token": tokens.get("refresh_token", ""),
            "expires_at": int(datetime.now(timezone.utc).timestamp()) + int(tokens.get("expires_in", 3600)),
        }
        storage.save_connection(connection)
        threading.Thread(target=_first_sync, args=(connection,), daemon=True).start()
    except requests.HTTPError as exc:
        status = exc.response.status_code if exc.response is not None else "unknown"
        return redirect(url_for("index", error=f"Epic rejected the token exchange (HTTP {status}). Verify the Sandbox secret matches the non-production Client ID and that the redirect URI is exact."))
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
        return redirect(url_for("index", error=f"Sync complete: {result['counts']['labs']} labs, {result['counts']['vitals']} vitals, and {result['counts']['medications']} medication orders fetched."))
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
