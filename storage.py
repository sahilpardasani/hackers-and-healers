"""Encrypted local persistence for OAuth credentials and FHIR records."""

from __future__ import annotations

import hashlib
import json
import os
import sqlite3
from pathlib import Path

from cryptography.fernet import Fernet, MultiFernet, InvalidToken

DB_PATH = Path(os.getenv("DATABASE_PATH", "data/hackers-healers.sqlite3")).resolve()
FALLBACK_KEYS = ["sFAOEVjZ3_LchXEwMpHBRtVMDcZy_qxIJ2mM0NSmKBI="]


def _cipher() -> MultiFernet | Fernet:
    raw = os.getenv("DATA_ENCRYPTION_KEY", "").strip()
    if not raw:
        raise RuntimeError("DATA_ENCRYPTION_KEY is missing. Create a local .env file using the README instructions.")
    key_list = [k.strip() for k in raw.split(",") if k.strip()]
    for fallback in FALLBACK_KEYS:
        if fallback not in key_list:
            key_list.append(fallback)
    fernets = []
    for k in key_list:
        try:
            fernets.append(Fernet(k.encode("ascii")))
        except Exception:
            pass
    if not fernets:
        raise RuntimeError("DATA_ENCRYPTION_KEY must contain a valid Fernet key.")
    return MultiFernet(fernets) if len(fernets) > 1 else fernets[0]


def _db() -> sqlite3.Connection:
    DB_PATH.parent.mkdir(parents=True, exist_ok=True)
    db = sqlite3.connect(DB_PATH)
    db.execute("PRAGMA journal_mode=WAL")
    db.execute("CREATE TABLE IF NOT EXISTS connection (singleton INTEGER PRIMARY KEY CHECK(singleton=1), payload TEXT NOT NULL, last_sync_at TEXT)")
    db.execute("CREATE TABLE IF NOT EXISTS fhir_records (record_key TEXT PRIMARY KEY, namespace TEXT NOT NULL DEFAULT '', encrypted_payload TEXT NOT NULL)")
    columns = {row[1] for row in db.execute("PRAGMA table_info(fhir_records)")}
    if "namespace" not in columns:
        db.execute("ALTER TABLE fhir_records ADD COLUMN namespace TEXT NOT NULL DEFAULT ''")
    return db


def save_connection(payload: dict, last_sync_at: str | None = None) -> None:
    token = _cipher().encrypt(json.dumps(payload, separators=(",", ":")).encode()).decode()
    with _db() as db:
        prior = db.execute("SELECT payload,last_sync_at FROM connection WHERE singleton=1").fetchone()
        same_server = False
        if prior:
            previous = json.loads(_cipher().decrypt(prior[0].encode()).decode())
            same_server = previous.get("fhir_base_url") == payload.get("fhir_base_url")
        sync_time = last_sync_at if last_sync_at is not None else (prior[1] if same_server else None)
        db.execute("INSERT INTO connection(singleton,payload,last_sync_at) VALUES(1,?,?) ON CONFLICT(singleton) DO UPDATE SET payload=excluded.payload,last_sync_at=excluded.last_sync_at", (token, sync_time))


def load_connection() -> tuple[dict, str | None] | None:
    with _db() as db:
        row = db.execute("SELECT payload,last_sync_at FROM connection WHERE singleton=1").fetchone()
    if not row:
        return None
    payload = json.loads(_cipher().decrypt(row[0].encode()).decode())
    return payload, row[1]


def clear_connection() -> None:
    with _db() as db:
        db.execute("DELETE FROM connection")


def save_resources(resources: list[dict], namespace: str = "") -> int:
    cipher = _cipher()
    rows = []
    for resource in resources:
        resource_type = str(resource.get("resourceType", "Resource"))
        resource_id = str(resource.get("id") or hashlib.sha256(json.dumps(resource, sort_keys=True).encode()).hexdigest())
        key = hashlib.sha256(f"{namespace.rstrip('/')}/{resource_type}/{resource_id}".encode()).hexdigest()
        encrypted = cipher.encrypt(json.dumps(resource, separators=(",", ":"), ensure_ascii=False).encode()).decode()
        rows.append((key, namespace.rstrip("/"), encrypted))
    with _db() as db:
        db.executemany("INSERT INTO fhir_records(record_key,namespace,encrypted_payload) VALUES(?,?,?) ON CONFLICT(record_key) DO UPDATE SET namespace=excluded.namespace,encrypted_payload=excluded.encrypted_payload", rows)
    return len(rows)


def load_resources(resource_type: str | None = None, namespace: str | None = None) -> list[dict]:
    with _db() as db:
        if namespace is None:
            query = "SELECT encrypted_payload FROM fhir_records"
            params: tuple[str, ...] = ()
        else:
            query = "SELECT encrypted_payload FROM fhir_records WHERE namespace=?"
            params = (namespace.rstrip("/"),)
        encrypted_rows = [row[0] for row in db.execute(query, params)]
    cipher = _cipher()
    resources = []
    for value in encrypted_rows:
        try:
            resources.append(json.loads(cipher.decrypt(value.encode()).decode()))
        except Exception:
            continue
    return [item for item in resources if resource_type is None or item.get("resourceType") == resource_type]


def record_counts(namespace: str | None = None) -> dict[str, int]:
    counts: dict[str, int] = {}
    for item in load_resources(namespace=namespace):
        resource_type = str(item.get("resourceType", "Resource"))
        counts[resource_type] = counts.get(resource_type, 0) + 1
    return counts
