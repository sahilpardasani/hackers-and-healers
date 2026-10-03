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
import uvicorn
from apscheduler.schedulers.background import BackgroundScheduler
from dotenv import load_dotenv
from fastapi import FastAPI, Request, Response
from fastapi.responses import HTMLResponse, JSONResponse, RedirectResponse, PlainTextResponse
from fastapi.staticfiles import StaticFiles
from fastapi.templating import Jinja2Templates
from starlette.middleware.sessions import SessionMiddleware
from fastapi.testclient import TestClient


load_dotenv()

import endpoint_directory
import clinicaltrial
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
SCOPES = os.getenv("FHIR_SCOPES", "").strip()
SYNC_HOUR = int(os.getenv("SYNC_HOUR", "3"))
FHIR_TIMEOUT = (5, 45)
MAX_PAGES_PER_QUERY = 100

app = FastAPI(title="Hackers & Healers")
USE_SSL = os.getenv("USE_SSL", "false").lower() in {"1", "true", "yes"}

app.add_middleware(
    SessionMiddleware,
    secret_key=os.getenv("FLASK_SECRET_KEY") or secrets.token_hex(32),
    session_cookie="session",
    same_site="lax",
    https_only=USE_SSL and urlparse(REDIRECT_URI).scheme == "https",
)
app.mount("/static", StaticFiles(directory="static"), name="static")
app.include_router(clinicaltrial.router)
app.extensions: dict = {}

templates = Jinja2Templates(directory="templates")


def custom_url_for(endpoint: str, **values):
    if endpoint == "static":
        filename = values.get("filename") or values.get("path")
        return f"/static/{filename}"
    endpoint_map = {
        "index": "/",
        "landing": "/",
        "app": "/app",
        "patient_app": "/app",
        "sample": "/sample",
        "sample_json": "/sample.json",
        "sample_dashboard": "/sample",
        "load_sample": "/sample/load",
        "connect": "/connect",
        "callback": "/callback",
        "sync_now": "/sync",
        "disconnect": "/disconnect",
        "terms": "/terms",
    }
    url = endpoint_map.get(endpoint, f"/{endpoint}")
    if values:
        return f"{url}?{urlencode(values)}"
    return url


templates.env.globals["url_for"] = custom_url_for


class ResponseWrapper:
    def __init__(self, response):
        self._response = response

    @property
    def status_code(self):
        return self._response.status_code

    @property
    def headers(self):
        return self._response.headers

    @property
    def location(self):
        return self._response.headers.get("location")

    def get_json(self):
        return self._response.json()

    def json(self):
        return self._response.json()

    def get_data(self, as_text=False):
        return self._response.text if as_text else self._response.content

    @property
    def data(self):
        return self._response.content

    @property
    def text(self):
        return self._response.text


    @property
    def content(self):
        return self._response.content


class TestClientWrapper:
    def __init__(self, test_client):
        self._client = test_client

    def get(self, url, *args, query_string=None, params=None, follow_redirects=False, **kwargs):
        kwargs.pop("base_url", None)
        p = params if params is not None else query_string
        res = self._client.get(url, params=p, follow_redirects=follow_redirects, **kwargs)
        return ResponseWrapper(res)

    def post(self, url, *args, data=None, json=None, follow_redirects=False, **kwargs):
        kwargs.pop("base_url", None)
        res = self._client.post(url, data=data, json=json, follow_redirects=follow_redirects, **kwargs)
        return ResponseWrapper(res)


def app_test_client(base_url: str = "https://127.0.0.1:3000"):
    from fastapi.testclient import TestClient
    return TestClientWrapper(TestClient(app, base_url=base_url))


app.test_client = app_test_client


logger = logging.getLogger("hackers_healers")

pending_auth: dict[str, dict[str, str]] = {}
sync_lock = threading.Lock()
sync_tracker: dict = {
    "active": False,
    "stage": "",
    "step": 0,
    "total_steps": 6,
    "counts": {},
    "total_fetched": 0,
    "warnings": [],
    "error": None,
    "done": False,
}

SYNC_QUERIES = {
    "labs": ("Observation", {"category": "laboratory"}, "date"),
    "vitals": ("Observation", {"category": "vital-signs"}, "date"),
    "conditions": ("Condition", {"category": "problem-list-item"}, None),
    "medications": ("MedicationRequest", {}, "authoredon"),
    "appointments": ("Appointment", {}, "date"),
    "coverage": ("Coverage", {}, "_lastUpdated"),
}


def _sid(request: Request) -> str:
    if not request.session.get("sid"):
        request.session["sid"] = secrets.token_urlsafe(24)
    return str(request.session["sid"])


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
    encoded = f"{quote(CLIENT_ID, safe='')}:{quote(CLIENT_SECRET, safe='')}".encode("ascii")
    return {"Authorization": f"Basic {base64.b64encode(encoded).decode('ascii')}"}


def _token_request(mode: str, data: dict[str, str]) -> tuple[dict[str, str], dict[str, str]]:
    if mode == "public":
        return {**data, "client_id": CLIENT_ID}, {"Accept": "application/json"}
    if mode == "confidential":
        return data, {"Accept": "application/json", **_client_auth_header()}
    raise ValueError("Unsupported OAuth client mode.")


def _authorization_scopes(mode: str) -> str:
    scopes = SCOPES.split()
    if mode == "public":
        scopes = [scope for scope in scopes if scope != "offline_access"]
    return " ".join(scopes)


def _configured_client_ready() -> bool:
    return bool(CLIENT_ID and os.getenv("DATA_ENCRYPTION_KEY")
                and (OAUTH_CLIENT_MODE == "public" or CLIENT_SECRET))


def _safe_oauth_error_code(response) -> str:
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
    global sync_tracker
    sync_tracker.update({
        "active": True,
        "stage": "Refreshing credentials & connecting...",
        "step": 1,
        "total_steps": 6,
        "counts": {},
        "total_fetched": 0,
        "warnings": [],
        "error": None,
        "done": False,
    })
    connection = _refresh_connection(connection)
    patient_id = connection.get("patient_id")
    if not patient_id:
        sync_tracker["active"] = False
        sync_tracker["error"] = "Authorization response did not include patient context."
        raise ValueError("The authorization response did not include patient context.")
    since = last_sync_at or ""
    fetched: list[dict] = []
    counts: dict[str, int] = {}
    warnings: list[str] = []

    try:
        sync_tracker["stage"] = "Fetching patient demographics..."
        patient = fetch_resource(connection, "Patient", patient_id)
        fetched.append(patient)
        counts["patient"] = 1
        sync_tracker["counts"]["Patient"] = 1
        sync_tracker["total_fetched"] = 1
    except (requests.RequestException, ValueError) as exc:
        sync_tracker["active"] = False
        sync_tracker["error"] = "The patient record could not be read from the selected FHIR server."
        raise ValueError("The patient record could not be read from the selected FHIR server.") from exc

    step_labels = {
        "labs": ("Fetching laboratory results (A1c, eGFR)...", 2),
        "vitals": ("Fetching vital signs (blood pressure, weight)...", 3),
        "conditions": ("Fetching conditions & problem list...", 4),
        "medications": ("Fetching medications & active prescriptions...", 5),
        "appointments": ("Fetching appointments...", 6),
        "coverage": ("Fetching insurance coverage...", 6),
    }

    for label, (resource_type, params, date_param) in SYNC_QUERIES.items():
        stage_desc, step_num = step_labels.get(label, (f"Fetching {label}...", 5))
        sync_tracker["stage"] = stage_desc
        sync_tracker["step"] = step_num
        query = {**params, "patient": patient_id, "_count": "100"}
        if since and date_param:
            query[date_param] = f"ge{since}"
        try:
            resources = fetch_bundle(connection, resource_type, query)
        except (requests.RequestException, ValueError):
            warnings.append(label)
            counts[label] = 0
            sync_tracker["warnings"] = list(warnings)
            continue
        fetched.extend(resources)
        counts[label] = len(resources)
        sync_tracker["counts"][label] = len(resources)
        sync_tracker["total_fetched"] = len(fetched)

    medication_references = {
        item.get("medicationReference", {}).get("reference", "").split("/")[-1]
        for item in fetched
        if item.get("resourceType") == "MedicationRequest"
        and item.get("medicationReference", {}).get("reference", "").startswith("Medication/")
    }
    medication_details = 0
    if medication_references:
        sync_tracker["stage"] = "Fetching medication details..."
    for medication_id in medication_references:
        try:
            fetched.append(fetch_resource(connection, "Medication", medication_id))
            medication_details += 1
            sync_tracker["total_fetched"] = len(fetched)
        except (requests.RequestException, ValueError):
            warnings.append("medication details")
    if medication_details:
        counts["medication_details"] = medication_details

    sync_tracker["stage"] = f"Encrypting and saving {len(fetched)} records locally..."
    stored = storage.save_resources(fetched, namespace=connection["fhir_base_url"])
    synced_at = datetime.now(timezone.utc).replace(microsecond=0).isoformat().replace("+00:00", "Z")
    connection["last_sync_warnings"] = warnings
    storage.save_connection(connection, last_sync_at=synced_at)
    sync_tracker["active"] = False
    sync_tracker["done"] = True
    sync_tracker["step"] = 6
    sync_tracker["stage"] = f"Sync complete! {len(fetched)} records successfully loaded."
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
        logger.warning("Scheduled FHIR sync failed; check the local dashboard and reconnect if needed.")
    finally:
        sync_lock.release()


@app.get("/", response_class=HTMLResponse)
def index(request: Request):
    connection_item = storage.load_connection()
    connection = connection_item[0] if connection_item else None
    last_sync = connection_item[1] if connection_item else None
    patient = {}
    if connection:
        records = storage.load_resources(namespace=connection.get("fhir_base_url"))
        if records:
            patient = patient_view(records)
    return templates.TemplateResponse(
        request=request,
        name="landing.html",
        context={
            "connection": connection,
            "patient": patient,
            "last_sync": last_sync,
        },
    )


@app.get("/app", response_class=HTMLResponse)
def patient_app(request: Request):
    connection_item = storage.load_connection()
    connection = connection_item[0] if connection_item else None
    last_sync = connection_item[1] if connection_item else None
    return _render_dashboard(request, connection, last_sync)


@app.post("/sample/load")
def load_sample():
    storage.save_resources(sample_resources(), namespace=SAMPLE_NAMESPACE)
    return RedirectResponse(url="/sample", status_code=303)


@app.get("/sample")
def sample_dashboard(request: Request):
    if not storage.record_counts(namespace=SAMPLE_NAMESPACE):
        storage.save_resources(sample_resources(), namespace=SAMPLE_NAMESPACE)
    return _render_dashboard(request, {"fhir_base_url": SAMPLE_NAMESPACE,
                              "display_name": "Maya — synthetic sample data"},
                             None, sample_mode=True)


@app.get("/sample.json")
def sample_json():
    records = storage.load_resources(namespace=SAMPLE_NAMESPACE)
    return {"resourceType": "Bundle", "type": "collection",
            "meta": {"tag": [{"code": "synthetic", "display": "Fictional Maya demo; not Epic data"}]},
            "entry": [{"resource": record} for record in records]}


def _render_dashboard(request: Request, connection, last_sync, sample_mode=False):
    error = request.query_params.get("error")
    namespace = connection.get("fhir_base_url") if connection else None
    records = storage.load_resources(namespace=namespace) if connection else []
    labs, vitals = observation_views(records)
    metrics = summarize(records)
    sync_active = sync_tracker["active"] or (sync_lock.locked() and not sample_mode)
    return templates.TemplateResponse(
        request=request,
        name="index.html",
        context={
            "error": error,
            "sample_mode": sample_mode,
            "connection": connection,
            "base_url": FHIR_BASE_URL,
            "endpoints": _known_endpoints(),
            "client_ready": _configured_client_ready(),
            "last_sync": last_sync,
            "counts": storage.record_counts(namespace=namespace) if connection else {},
            "metrics": metrics,
            "patient": patient_view(records) if connection else {},
            "labs": labs,
            "vitals": vitals,
            "conditions": condition_views(records),
            "medications": medication_views(records),
            "appointments": appointment_views(records),
            "coverage": coverage_views(records),
            "sync_warnings": connection.get("last_sync_warnings", []) if connection else [],
            "sync_active": sync_active,
            "sync_tracker": sync_tracker,
            "metric_text": lambda item: f"{item['value']:g} {item['unit']}" if item else "No result",
            "pressure_text": lambda item: f"{item['systolic_average'] or '—'}/{item['diastolic_average'] or '—'} mmHg",
        },
    )


@app.get("/terms")
def terms(request: Request):
    """Show draft terms for the local prototype; not yet legally operative."""
    return templates.TemplateResponse(request=request, name="terms.html", context={})


@app.post("/connect")
async def connect(request: Request):
    form = await request.form()
    if form.get("consent") != "yes":
        return RedirectResponse(url="/app?error=Please+acknowledge+the+privacy+and+medical-information+notice+before+connecting.", status_code=302)
    if not _configured_client_ready():
        return RedirectResponse(url="/app?error=OAuth+configuration+is+incomplete+for+the+selected+client+mode.+Check+CLIENT_ID,+DATA_ENCRYPTION_KEY,+and+CLIENT_SECRET+when+using+confidential+mode.", status_code=302)
    selected_url = str(form.get("endpoint", "")).rstrip("/")
    selected = next((item for item in _known_endpoints() if item["url"] == selected_url), None)
    if not selected:
        return PlainTextResponse("Choose a health system from the published list.", status_code=400)
    try:
        metadata = _metadata(selected_url)
    except (requests.RequestException, ValueError):
        return RedirectResponse(url="/app?error=Could+not+read+the+selected+FHIR+server's+SMART+configuration.", status_code=302)
    verifier = _b64url(secrets.token_bytes(48))
    state = secrets.token_urlsafe(32)
    pending_auth[_sid(request)] = {"state": state, "verifier": verifier, "base_url": selected_url, "display_name": selected["name"], "auth_endpoint": metadata["authorization_endpoint"], "token_endpoint": metadata["token_endpoint"], "oauth_client_mode": OAUTH_CLIENT_MODE}
    params = {
        "response_type": "code", "client_id": CLIENT_ID, "redirect_uri": REDIRECT_URI,
        "aud": selected_url, "state": state,
        "code_challenge": _b64url(hashlib.sha256(verifier.encode()).digest()), "code_challenge_method": "S256",
    }
    scopes = _authorization_scopes(OAUTH_CLIENT_MODE)
    if scopes:
        params["scope"] = scopes
    query = urlencode(params)
    return RedirectResponse(url=f"{metadata['authorization_endpoint']}?{query}", status_code=302)


@app.get("/callback")
def callback(request: Request):
    sid = _sid(request)
    pending = pending_auth.get(sid)
    if not pending:
        return RedirectResponse(url="/app?error=This+sign-in+attempt+expired+or+the+app+restarted.+Start+a+fresh+connection.", status_code=302)
    state = request.query_params.get("state", "")
    if not secrets.compare_digest(state, pending["state"]):
        pending_auth.pop(sid, None)
        return RedirectResponse(url="/app?error=OAuth+state+did+not+match.+For+your+security,+start+a+fresh+connection.", status_code=302)
    pending_auth.pop(sid, None)
    oauth_error = request.query_params.get("error")
    if oauth_error:
        messages = {
            "access_denied": "The patient declined access. No connection was saved.",
            "invalid_client": "Epic did not recognize this app. Verify the non-production Client ID, exact redirect URI, and Sandbox readiness.",
            "invalid_scope": "Epic rejected a requested scope. Check the APIs selected for this app and start again after Sandbox sync.",
            "unauthorized_client": "Epic has not enabled this app for the Sandbox yet. Check its status and try again after settings sync.",
        }
        msg = messages.get(oauth_error, "Epic returned an OAuth authorization error. Verify the app settings and start again.")
        return RedirectResponse(url=f"/app?error={quote(msg)}", status_code=302)
    code = request.query_params.get("code", "")
    if not code:
        return PlainTextResponse("The FHIR server did not return an authorization code.", status_code=400)
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
            "oauth_client_mode": mode,
            "refresh_token": tokens.get("refresh_token", "") if mode == "confidential" else "",
            "expires_at": int(datetime.now(timezone.utc).timestamp()) + int(tokens.get("expires_in", 3600)),
        }
        storage.save_connection(connection)
        threading.Thread(target=_first_sync, args=(connection,), daemon=True).start()
    except requests.HTTPError as exc:
        status = exc.response.status_code if exc.response is not None else "unknown"
        error_code = _safe_oauth_error_code(exc.response) if exc.response is not None else ""
        return RedirectResponse(url=f"/app?error={quote(_token_exchange_error(status, error_code, mode))}", status_code=302)
    except (requests.RequestException, ValueError, RuntimeError):
        return RedirectResponse(url="/app?error=Connection+could+not+be+saved.+Check+app+settings+and+ensure+local+encryption+is+configured.", status_code=302)
    return RedirectResponse(url="/app", status_code=302)


def _first_sync(connection: dict) -> None:
    if not sync_lock.acquire(blocking=False):
        return
    try:
        sync_connection(connection, None)
    except Exception as exc:
        sync_tracker["active"] = False
        sync_tracker["error"] = str(exc)
        logger.warning("Initial FHIR sync failed; check the local dashboard and reconnect if needed.")
    finally:
        sync_lock.release()


@app.get("/sync/status")
def sync_status_endpoint():
    return {
        "active": sync_tracker["active"] or sync_lock.locked(),
        "stage": sync_tracker["stage"],
        "step": sync_tracker["step"],
        "total_steps": sync_tracker["total_steps"],
        "counts": sync_tracker["counts"],
        "total_fetched": sync_tracker["total_fetched"],
        "warnings": sync_tracker["warnings"],
        "error": sync_tracker["error"],
        "done": sync_tracker["done"],
    }


@app.get("/favicon.ico")
def favicon():
    return Response(status_code=204)


@app.post("/sync")
def sync_now(request: Request):
    accept_header = request.headers.get("accept", "")
    is_ajax = "application/json" in accept_header
    try:
        item = storage.load_connection()
        if not item:
            if is_ajax:
                return JSONResponse({"error": "Connect your health system first."}, status_code=400)
            return RedirectResponse(url="/?error=Connect+your+health+system+first.", status_code=303)
        if sync_lock.locked() or sync_tracker["active"]:
            if is_ajax:
                return JSONResponse({"status": "in_progress", "message": "A sync is already running."})
            return RedirectResponse(url="/?error=A+sync+is+already+running.", status_code=303)
        if is_ajax:
            def run_async_sync():
                if not sync_lock.acquire(blocking=False):
                    return
                try:
                    sync_connection(*item)
                except Exception as exc:
                    sync_tracker["active"] = False
                    sync_tracker["error"] = str(exc)
                finally:
                    sync_lock.release()

            threading.Thread(target=run_async_sync, daemon=True).start()
            return JSONResponse({"status": "started", "message": "Sync started in background."})

        if not sync_lock.acquire(blocking=False):
            return RedirectResponse(url="/app?error=A+sync+is+already+running.", status_code=303)
        try:
            result = sync_connection(*item)
        finally:
            sync_lock.release()
        warning_text = f" Optional APIs unavailable: {', '.join(result['warnings'])}." if result["warnings"] else ""
        msg = f"Sync complete: {result['counts'].get('labs', 0)} labs, {result['counts'].get('vitals', 0)} vitals, {result['counts'].get('conditions', 0)} conditions, and {result['counts'].get('appointments', 0)} appointments fetched.{warning_text}"
        return RedirectResponse(url=f"/app?error={quote(msg)}", status_code=303)
    except Exception:
        if is_ajax:
            return JSONResponse({"error": "Sync failed."}, status_code=500)
        return RedirectResponse(url="/app?error=Sync+failed.+The+local+dashboard+did+not+record+server+response+details.", status_code=303)


@app.api_route("/disconnect", methods=["GET", "POST"])
def disconnect(request: Request):
    storage.clear_connection()
    request.session.clear()
    return RedirectResponse(url="/app", status_code=303)


def start_scheduler() -> None:
    scheduler = BackgroundScheduler(timezone="UTC")
    scheduler.add_job(daily_sync, "cron", hour=SYNC_HOUR, id="daily-fhir-sync", max_instances=1, coalesce=True)
    scheduler.add_job(_refresh_directory_if_stale, "interval", days=7, id="epic-directory-refresh", max_instances=1, coalesce=True)
    scheduler.start()
    app.state.fhir_scheduler = scheduler
    app.extensions["fhir_scheduler"] = scheduler


def _refresh_directory_if_stale() -> None:
    if endpoint_directory.cache_is_stale():
        try:
            endpoint_directory.refresh()
        except Exception:
            logger.warning("Epic endpoint list could not be refreshed; the saved list remains available.")


@app.post("/refresh-endpoint-directory")
def refresh_endpoint_directory():
    try:
        count = endpoint_directory.refresh()
        message = f"Health system list refreshed ({count} FHIR endpoints)."
    except Exception:
        message = "The directory could not be refreshed. Try again later."
    return RedirectResponse(url=f"/app?error={quote(message)}", status_code=303)


if __name__ == "__main__":
    use_ssl = os.getenv("USE_SSL", "false").lower() in {"1", "true", "yes"}
    run_options = server_options(REDIRECT_URI, use_ssl=use_ssl)
    try:
        start_scheduler()
    except RuntimeError:
        logger.warning("Daily scheduler could not start.")
    if endpoint_directory.cache_is_stale():
        threading.Thread(target=_refresh_directory_if_stale, daemon=True).start()
    scheme = "https" if (use_ssl and run_options.get("ssl_certfile")) else "http"
    port = run_options.get("port") or 3000
    print(f"Open {scheme}://127.0.0.1:{port}/. Keep this process running for scheduled syncs.")
    if scheme == "https":
        print("Local HTTPS uses a self-signed development certificate in data/local-tls.")
    else:
        print("Running in local HTTP mode without SSL certificates.")
    uvicorn.run(
        "app:app",
        host=run_options["host"],
        port=port,
        ssl_keyfile=run_options.get("ssl_keyfile") if scheme == "https" else None,
        ssl_certfile=run_options.get("ssl_certfile") if scheme == "https" else None,
        reload=True,
        log_level="info",
    )
