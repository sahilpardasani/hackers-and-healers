"""Encrypted local persistence for OAuth credentials and FHIR records."""

from __future__ import annotations

import hashlib
import json
import os
import sqlite3
from pathlib import Path

from cryptography.fernet import Fernet

DB_PATH = Path(os.getenv("DATABASE_PATH", "data/hackers-healers.sqlite3")).resolve()


def _cipher() -> Fernet:
    key = os.getenv("DATA_ENCRYPTION_KEY", "").strip()
    if not key:
        raise RuntimeError("DATA_ENCRYPTION_KEY is missing. Create a local .env file using the README instructions.")
    try:
        return Fernet(key.encode("ascii"))
    except (ValueError, UnicodeEncodeError) as exc:
        raise RuntimeError("DATA_ENCRYPTION_KEY must be a valid Fernet key.") from exc


def _db() -> sqlite3.Connection:
    DB_PATH.parent.mkdir(parents=True, exist_ok=True)
    db = sqlite3.connect(DB_PATH)
    db.execute("PRAGMA journal_mode=WAL")
    db.execute("CREATE TABLE IF NOT EXISTS connection (singleton INTEGER PRIMARY KEY CHECK(singleton=1), payload TEXT NOT NULL, last_sync_at TEXT)")
    db.execute("CREATE TABLE IF NOT EXISTS fhir_records (record_key TEXT PRIMARY KEY, encrypted_payload TEXT NOT NULL)")
    return db


def save_connection(payload: dict, last_sync_at: str | None = None) -> None:
    token = _cipher().encrypt(json.dumps(payload, separators=(",", ":")).encode()).decode()
    with _db() as db:
        prior = db.execute("SELECT last_sync_at FROM connection WHERE singleton=1").fetchone()
        sync_time = last_sync_at if last_sync_at is not None else (prior[0] if prior else None)
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


def save_resources(resources: list[dict]) -> int:
    cipher = _cipher()
    rows = []
    for resource in resources:
        resource_type = str(resource.get("resourceType", "Resource"))
        resource_id = str(resource.get("id") or hashlib.sha256(json.dumps(resource, sort_keys=True).encode()).hexdigest())
        key = hashlib.sha256(f"{resource_type}/{resource_id}".encode()).hexdigest()
        encrypted = cipher.encrypt(json.dumps(resource, separators=(",", ":"), ensure_ascii=False).encode()).decode()
        rows.append((key, encrypted))
    with _db() as db:
        db.executemany("INSERT INTO fhir_records(record_key,encrypted_payload) VALUES(?,?) ON CONFLICT(record_key) DO UPDATE SET encrypted_payload=excluded.encrypted_payload", rows)
    return len(rows)


def load_resources(resource_type: str | None = None) -> list[dict]:
    with _db() as db:
        encrypted_rows = [row[0] for row in db.execute("SELECT encrypted_payload FROM fhir_records")]
    cipher = _cipher()
    resources = [json.loads(cipher.decrypt(value.encode()).decode()) for value in encrypted_rows]
    return [item for item in resources if resource_type is None or item.get("resourceType") == resource_type]


def record_counts() -> dict[str, int]:
    counts: dict[str, int] = {}
    for item in load_resources():
        resource_type = str(item.get("resourceType", "Resource"))
        counts[resource_type] = counts.get(resource_type, 0) + 1
    return counts
