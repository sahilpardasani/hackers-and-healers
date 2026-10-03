"""Privacy-conscious presentation helpers for stored FHIR resources."""

from __future__ import annotations

from datetime import datetime


def _codes(concept: dict) -> list[dict]:
    return [item for item in concept.get("coding", []) if isinstance(item, dict)]


def _display(concept: dict | None, fallback: str = "") -> str:
    if not isinstance(concept, dict):
        return fallback
    if concept.get("text"):
        return str(concept["text"])
    if concept.get("display"):
        return str(concept["display"])
    for coding in _codes(concept):
        if coding.get("display"):
            return str(coding["display"])
    return fallback


def _date(value: object) -> str:
    if not value:
        return "Date unavailable"
    text = str(value)
    try:
        parsed = datetime.fromisoformat(text.replace("Z", "+00:00"))
        return parsed.strftime("%Y-%m-%d")
    except (TypeError, ValueError, OverflowError):
        return text[:10]


def _timestamp(value: object) -> float:
    try:
        return datetime.fromisoformat(str(value).replace("Z", "+00:00")).timestamp()
    except (TypeError, ValueError, OverflowError):
        return 0.0


def _effective(resource: dict) -> str:
    value = resource.get("effectiveDateTime") or resource.get("issued") or resource.get("date")
    if not value and isinstance(resource.get("effectivePeriod"), dict):
        value = resource["effectivePeriod"].get("start")
    return str(value or "")


def _quantity(quantity: dict | None) -> str:
    if not isinstance(quantity, dict) or quantity.get("value") is None:
        return "Result unavailable"
    unit = quantity.get("unit") or quantity.get("code") or ""
    return f"{quantity['value']} {unit}".strip()


def _category_codes(resource: dict) -> set[str]:
    result: set[str] = set()
    categories = resource.get("category", [])
    if isinstance(categories, dict):
        categories = [categories]
    for category in categories:
        for coding in _codes(category):
            if coding.get("code"):
                result.add(str(coding["code"]))
    return result


def patient_view(resources: list[dict]) -> dict:
    patient = next((item for item in resources if item.get("resourceType") == "Patient"), {})
    names = patient.get("name", [])
    name = "Patient"
    if names:
        preferred = next((item for item in names if item.get("use") in {"official", "usual"}), names[0])
        name = preferred.get("text") or " ".join([*preferred.get("given", []), preferred.get("family", "")]).strip() or name
    return {"name": name, "birth_date": patient.get("birthDate") or "Not available", "gender": patient.get("gender") or "Not available"}


def observation_views(resources: list[dict]) -> tuple[list[dict], list[dict]]:
    labs: list[dict] = []
    vitals: list[dict] = []
    for resource in resources:
        if resource.get("resourceType") != "Observation":
            continue
        when = _effective(resource)
        row = {
            "date": _date(when),
            "display": _display(resource.get("code"), "Observation"),
            "value": _quantity(resource.get("valueQuantity")) if resource.get("valueQuantity") else _display(resource.get("valueCodeableConcept"), "Result unavailable"),
            "status": resource.get("status", "unknown"),
        }
        categories = _category_codes(resource)
        if "vital-signs" in categories:
            vitals.append(row)
        elif "laboratory" in categories:
            labs.append(row)
        else:
            labs.append(row)
    labs.sort(key=lambda item: _timestamp(item["date"]), reverse=True)
    vitals.sort(key=lambda item: _timestamp(item["date"]), reverse=True)
    return labs[:20], vitals[:20]


def condition_views(resources: list[dict]) -> list[dict]:
    rows = []
    for resource in resources:
        if resource.get("resourceType") != "Condition":
            continue
        onset = resource.get("onsetDateTime")
        if not onset and isinstance(resource.get("onsetPeriod"), dict):
            onset = resource["onsetPeriod"].get("start")
        rows.append({
            "display": _display(resource.get("code"), "Condition"),
            "status": _display(resource.get("clinicalStatus"), resource.get("verificationStatus", {}).get("text", "Unknown")),
            "onset": _date(onset),
        })
    return sorted(rows, key=lambda item: item["display"].lower())[:50]


def medication_views(resources: list[dict]) -> list[dict]:
    rows = []
    for resource in resources:
        if resource.get("resourceType") not in {"MedicationRequest", "Medication"}:
            continue
        if resource.get("resourceType") == "MedicationRequest":
            medication = resource.get("medicationCodeableConcept") or resource.get("medicationReference") or {}
            dosage = resource.get("dosageInstruction", [])
            dosage_text = dosage[0].get("text", "") if dosage and isinstance(dosage[0], dict) else ""
            rows.append({
                "display": _display(medication, "Medication"),
                "status": resource.get("status", "unknown"),
                "details": dosage_text or resource.get("intent", "Prescription"),
                "date": _date(resource.get("authoredOn")),
            })
        else:
            rows.append({
                "display": _display(resource.get("code"), "Medication"),
                "status": "Medication detail",
                "details": resource.get("form", {}).get("text", "") if isinstance(resource.get("form"), dict) else "",
                "date": "",
            })
    return sorted(rows, key=lambda item: item["display"].lower())[:50]


def appointment_views(resources: list[dict]) -> list[dict]:
    rows = []
    for resource in resources:
        if resource.get("resourceType") != "Appointment":
            continue
        period = resource.get("requestedPeriod", [{}])[0] if resource.get("requestedPeriod") else {}
        start = resource.get("start") or period.get("start") or (resource.get("when") or "")
        service = resource.get("serviceType", [{}])
        service_display = _display(service[0].get("concept", {}), "Visit") if service and isinstance(service[0], dict) else "Visit"
        rows.append({"date": _date(start), "display": service_display, "status": resource.get("status", "unknown")})
    return sorted(rows, key=lambda item: _timestamp(item["date"]))[:30]


def coverage_views(resources: list[dict]) -> list[dict]:
    rows = []
    for resource in resources:
        if resource.get("resourceType") != "Coverage":
            continue
        period = resource.get("period", {})
        rows.append({
            "display": _display(resource.get("type"), "Insurance plan"),
            "status": resource.get("status", "unknown"),
            "period": " – ".join(filter(None, [_date(period.get("start")), _date(period.get("end"))])) if period else "Dates unavailable",
        })
    return rows[:20]
