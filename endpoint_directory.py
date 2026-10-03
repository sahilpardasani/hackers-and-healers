"""Local cache for Epic's published FHIR endpoint directory."""

from __future__ import annotations

import json
import os
from datetime import datetime, timezone
from pathlib import Path

import requests

DIRECTORY_URL = "https://open.epic.com/Endpoints/Brands"
CACHE_PATH = Path(os.getenv("ENDPOINT_DIRECTORY_PATH", "data/epic-brands.json")).resolve()


def refresh() -> int:
    """Download and cache the current R4 User-access Brands Bundle."""
    CACHE_PATH.parent.mkdir(parents=True, exist_ok=True)
    response = requests.get(DIRECTORY_URL, headers={"Accept": "application/fhir+json, application/json"}, timeout=(10, 90))
    response.raise_for_status()
    bundle = response.json()
    entries = bundle.get("entry", []) if isinstance(bundle, dict) else []
    endpoints: dict[str, dict] = {}
    brands: list[dict] = []
    for entry in entries:
        resource = entry.get("resource", {})
        if resource.get("resourceType") == "Endpoint":
            address = resource.get("address", "")
            if not address.startswith("https://"):
                continue
            version = " ".join(
                str(ext.get(key, ""))
                for ext in resource.get("extension", [])
                for key in ("valueCode", "valueString", "valueUri")
            )
            if version and not any(mark in version.lower() for mark in ("4.0.1", "r4")):
                continue
            endpoints[resource.get("id", "")] = {"address": address, "managing": resource.get("managingOrganization", {}).get("display", "")}
        elif resource.get("resourceType") == "Organization":
            is_brand = any(coding.get("code") == "pab" for item in resource.get("type", []) for coding in item.get("coding", []))
            if is_brand:
                brands.append(resource)
    choices = []
    for brand in brands:
        name = brand.get("name", "").strip()
        for reference in brand.get("endpoint", []):
            ref = reference.get("reference", "").rsplit("/", 1)[-1]
            match = endpoints.get(ref)
            if match:
                choices.append({"name": name or "Health system", "url": match["address"], "managing_organization": match["managing"]})
    choices = sorted({(item["name"], item["url"]): item for item in choices}.values(), key=lambda item: item["name"].casefold())
    cache = {"refreshed_at": datetime.now(timezone.utc).isoformat(), "endpoints": choices}
    CACHE_PATH.write_text(json.dumps(cache, separators=(",", ":")), encoding="utf-8")
    return len(choices)


def load() -> list[dict]:
    try:
        content = json.loads(CACHE_PATH.read_text(encoding="utf-8"))
        return content.get("endpoints", [])
    except (OSError, json.JSONDecodeError):
        return []


def cache_is_stale(max_age_days: int = 7) -> bool:
    try:
        content = json.loads(CACHE_PATH.read_text(encoding="utf-8"))
        refreshed = datetime.fromisoformat(content["refreshed_at"])
        return (datetime.now(timezone.utc) - refreshed).days >= max_age_days
    except (OSError, KeyError, ValueError, json.JSONDecodeError):
        return True
