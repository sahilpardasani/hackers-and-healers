"""Small, transparent CKM-oriented summaries from FHIR Observation resources."""

from __future__ import annotations

from datetime import datetime


EGFR_CODES = {"33914-3", "48642-3", "62238-1", "98979-8"}
A1C_CODES = {"4548-4", "17856-6", "59261-8"}
SYSTOLIC_CODES = {"8480-6"}
DIASTOLIC_CODES = {"8462-4"}
BP_PANEL_CODES = {"85354-9"}


def _codes(concept: dict) -> set[str]:
    return {str(item.get("code", "")) for item in concept.get("coding", []) if item.get("code")}


def _effective(resource: dict) -> str:
    value = resource.get("effectiveDateTime") or resource.get("issued") or resource.get("date") or ""
    if not value and isinstance(resource.get("effectivePeriod"), dict):
        value = resource["effectivePeriod"].get("start", "")
    return str(value)


def _timestamp(value: str) -> float:
    try:
        return datetime.fromisoformat(value.replace("Z", "+00:00")).timestamp()
    except (ValueError, TypeError, OverflowError):
        return 0.0


def _number(resource: dict) -> tuple[float | None, str]:
    quantity = resource.get("valueQuantity") or {}
    try:
        return float(quantity["value"]), str(quantity.get("unit") or quantity.get("code") or "")
    except (KeyError, TypeError, ValueError):
        return None, ""


def _display(resource: dict) -> str:
    code = resource.get("code", {})
    return code.get("text") or next((item.get("display", "") for item in code.get("coding", []) if item.get("display")), "Observation")


def summarize(observations: list[dict]) -> dict:
    egfr: list[dict] = []
    a1c: list[dict] = []
    systolic: list[tuple[float, str]] = []
    diastolic: list[tuple[float, str]] = []

    for resource in observations:
        main_codes = _codes(resource.get("code", {}))
        value, unit = _number(resource)
        when = _effective(resource)
        if value is not None and main_codes & EGFR_CODES:
            egfr.append({"date": when, "value": value, "unit": unit or "mL/min/1.73 m²", "display": _display(resource)})
        if value is not None and main_codes & A1C_CODES:
            a1c.append({"date": when, "value": value, "unit": unit or "%", "display": _display(resource)})
        if value is not None and main_codes & SYSTOLIC_CODES:
            systolic.append((value, when))
        if value is not None and main_codes & DIASTOLIC_CODES:
            diastolic.append((value, when))
        if main_codes & BP_PANEL_CODES:
            for component in resource.get("component", []):
                component_codes = _codes(component.get("code", {}))
                try:
                    component_value = float(component.get("valueQuantity", {}).get("value"))
                except (TypeError, ValueError):
                    continue
                if component_codes & SYSTOLIC_CODES:
                    systolic.append((component_value, when))
                if component_codes & DIASTOLIC_CODES:
                    diastolic.append((component_value, when))

    egfr.sort(key=lambda row: _timestamp(row["date"]), reverse=True)
    a1c.sort(key=lambda row: _timestamp(row["date"]))
    return {
        "latest_egfr": egfr[0] if egfr else None,
        "a1c_trend": a1c[-12:],
        "systolic_average": round(sum(value for value, _ in systolic) / len(systolic), 1) if systolic else None,
        "diastolic_average": round(sum(value for value, _ in diastolic) / len(diastolic), 1) if diastolic else None,
        "blood_pressure_count": min(len(systolic), len(diastolic)),
    }
