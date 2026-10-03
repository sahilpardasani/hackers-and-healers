"""ClinicalTrials.gov search and eligibility pre-screening for the synced patient.

Uses the public ClinicalTrials.gov API v2 (no key). Only condition names and,
when the caller provides them, coarse coordinates are sent to ClinicalTrials.gov;
patient identifiers and lab values stay on this machine. Matching is a
transparent, rule-based pre-screen, not an eligibility decision: free-text
criteria are checked only where a lab threshold or a known condition can be
recognised, and everything else is left for the study team.
"""

from __future__ import annotations

import math
import os
import re
import threading
import time
from datetime import date

import requests
from fastapi import APIRouter, Request
from fastapi.responses import JSONResponse, RedirectResponse

import storage
from sample_data import SAMPLE_NAMESPACE
from ckm import A1C_CODES, EGFR_CODES, SYSTOLIC_CODES, _codes, _effective, _number, _timestamp

API_BASE = "https://clinicaltrials.gov/api/v2"
STUDY_URL = "https://clinicaltrials.gov/study/{}"
TIMEOUT = (5, 12)
ACTIVE_STATUSES = ("RECRUITING", "NOT_YET_RECRUITING")
FIELDS = ",".join((
    "IdentificationModule", "StatusModule", "DescriptionModule", "ConditionsModule", "DesignModule",
    "EligibilityModule", "ContactsLocationsModule", "ArmsInterventionsModule",
))
CACHE_SECONDS = 3600
# ClinicalTrials.gov allows roughly 50 requests per minute per IP.
MIN_REQUEST_INTERVAL = 1.3
MAX_CONDITIONS = 5
NCT_PATTERN = re.compile(r"^NCT\d{8}$")
BMI_CODES = {"39156-5"}
INACTIVE_CONDITION_STATUSES = {"inactive", "resolved", "remission"}

_cache: dict[tuple, tuple[float, dict]] = {}
_request_lock = threading.Lock()
_last_request = 0.0


# --- ClinicalTrials.gov API client -------------------------------------------------

def _get(path: str, params: dict | None = None) -> dict:
    global _last_request
    key = (path, tuple(sorted((params or {}).items())))
    hit = _cache.get(key)
    if hit and time.monotonic() - hit[0] < CACHE_SECONDS:
        return hit[1]
    with _request_lock:
        wait = _last_request + MIN_REQUEST_INTERVAL - time.monotonic()
        if wait > 0:
            time.sleep(wait)
        _last_request = time.monotonic()
        response = requests.get(f"{API_BASE}{path}", params=params, headers={"Accept": "application/json"}, timeout=TIMEOUT)
    response.raise_for_status()
    data = response.json()
    _cache[key] = (time.monotonic(), data)
    return data


def _search_params(condition, term, statuses, geo, page_size) -> dict:
    params = {"format": "json", "fields": FIELDS, "pageSize": str(page_size)}
    if condition:
        params["query.cond"] = condition
    if term:
        params["query.term"] = term
    if statuses:
        params["filter.overallStatus"] = ",".join(statuses)
    if geo:
        params["filter.geo"] = f"distance({geo[0]:.3f},{geo[1]:.3f},{geo[2]:g}mi)"
    return params


def planned_searches(profile: dict, geo: tuple[float, float, float] | None = None, per_condition: int = 25) -> list[dict]:
    """The ClinicalTrials.gov queries find_trials will send for this profile (without `fields`, for readability)."""
    searches = []
    for condition in profile.get("conditions", [])[:MAX_CONDITIONS]:
        term = core_condition(condition["name"]) or condition["name"]
        params = {key: value for key, value in _search_params(term, None, ACTIVE_STATUSES, geo, per_condition).items() if key != "fields"}
        url = requests.Request("GET", f"{API_BASE}/studies", params=params).prepare().url
        searches.append({"from": condition["name"], "source": condition["source"], "query": term, "url": url})
    return searches


def search_studies(condition: str | None = None, term: str | None = None, statuses=ACTIVE_STATUSES,
                   geo: tuple[float, float, float] | None = None, page_size: int = 25, max_pages: int = 1) -> list[dict]:
    """Search studies; `geo` is (latitude, longitude, miles)."""
    params = _search_params(condition, term, statuses, geo, page_size)
    studies: list[dict] = []
    for _ in range(max_pages):
        page = _get("/studies", params)
        studies.extend(page.get("studies", []))
        token = page.get("nextPageToken")
        if not token:
            break
        params = {**params, "pageToken": token}
    return studies


def get_study(nct_id: str) -> dict:
    if not NCT_PATTERN.match(nct_id):
        raise ValueError("Expected an NCT number such as NCT01234567.")
    return _get(f"/studies/{nct_id}", {"format": "json", "fields": FIELDS})


# --- Patient profile from synced FHIR records -----------------------------------

def _concept_text(concept: dict) -> str:
    return concept.get("text") or next((item.get("display", "") for item in concept.get("coding", []) if item.get("display")), "")


def _latest(observations: list[dict], codes: set[str]) -> float | None:
    readings = []
    for resource in observations:
        if resource.get("status") in {"entered-in-error", "cancelled", "preliminary"}:
            continue
        parts = [resource, *resource.get("component", [])]
        for part in parts:
            value, unit = _number(part)
            unit = unit.lower().replace(" ", "").replace("²", "2")
            allowed = ({"%"} if codes == A1C_CODES else {"kg/m2", "kg/m^2"} if codes == BMI_CODES
                       else {"mmhg", "mm[hg]"} if codes == SYSTOLIC_CODES
                       else {"ml/min/1.73m2", "ml/min/{1.73_m2}", "ml/min/1.73m^2"})
            if value is None or not math.isfinite(value) or unit not in allowed:
                continue
            if value is not None and _codes(part.get("code", {})) & codes:
                readings.append((_timestamp(_effective(resource)), value))
    return max(readings)[1] if readings else None


def _inferred_conditions(labs: dict) -> list[str]:
    inferred = []
    if labs.get("egfr") is not None and labs["egfr"] < 60:
        inferred.append("Chronic Kidney Disease")
    if labs.get("a1c") is not None:
        if labs["a1c"] >= 6.5:
            inferred.append("Type 2 Diabetes")
        elif labs["a1c"] >= 5.7:
            inferred.append("Prediabetes")
    if labs.get("bmi") is not None and labs["bmi"] >= 30:
        inferred.append("Obesity")
    if labs.get("systolic") is not None and labs["systolic"] >= 130:
        inferred.append("Hypertension")
    return inferred


def patient_profile(resources: list[dict], today: date | None = None) -> dict:
    """Reduce FHIR resources to the facts the matcher uses."""
    today = today or date.today()
    by_type: dict[str, list[dict]] = {}
    for resource in resources:
        by_type.setdefault(resource.get("resourceType", ""), []).append(resource)

    patient = (by_type.get("Patient") or [{}])[0]
    age = None
    try:
        born = date.fromisoformat(str(patient.get("birthDate", ""))[:10])
        age = today.year - born.year - ((today.month, today.day) < (born.month, born.day))
    except ValueError:
        pass
    sex = {"male": "MALE", "female": "FEMALE"}.get(patient.get("gender", ""))

    conditions, seen = [], set()
    for resource in by_type.get("Condition", []):
        status = {item.get("code") for item in resource.get("clinicalStatus", {}).get("coding", [])}
        name = _concept_text(resource.get("code", {})).strip()
        verification = _codes(resource.get("verificationStatus", {}))
        if (name and not status & INACTIVE_CONDITION_STATUSES
                and not verification & {"refuted", "entered-in-error"} and name.casefold() not in seen):
            seen.add(name.casefold())
            conditions.append({"name": name, "source": "record"})

    observations = by_type.get("Observation", [])
    labs = {
        "egfr": _latest(observations, EGFR_CODES),
        "a1c": _latest(observations, A1C_CODES),
        "bmi": _latest(observations, BMI_CODES),
        "systolic": _latest(observations, SYSTOLIC_CODES),
    }
    if not conditions:
        conditions = [{"name": name, "source": "labs"} for name in _inferred_conditions(labs)]

    medications = sorted({
        _concept_text(item.get("medicationCodeableConcept", {})) or item.get("medicationReference", {}).get("display", "")
        for item in by_type.get("MedicationRequest", []) if item.get("status") in (None, "active")
    } - {""})
    return {"age": age, "sex": sex, "conditions": conditions, "labs": labs, "medications": medications,
            "warnings": ["Lab-derived search topics are not diagnoses. Missing or unsupported units are not compared.",
                         "Results may be historical. Study teams must confirm current labs, sex eligibility, pregnancy, medications, and all other criteria."]}


# --- Eligibility criteria parsing ------------------------------------------------

LAB_PATTERNS = {
    "egfr": (re.compile(r"\be?GFR\b|glomerular filtration", re.I), "eGFR"),
    "a1c": (re.compile(r"\bhb\s*a1c\b|\ba1c\b|ha?emoglobin a1c|glycated ha?emoglobin", re.I), "A1c"),
    "bmi": (re.compile(r"\bBMI\b|body mass index", re.I), "BMI"),
    "systolic": (re.compile(r"\bsystolic\b|\bSBP\b", re.I), "systolic blood pressure"),
    "body_fat": (re.compile(r"\bbody\s*fat\b|\bpercent(?:age)?\s*fat\b|\bBF%\b", re.I), "body fat percentage"),
    "visceral_fat": (re.compile(r"\bvisceral\s*(?:fat|adipose|adiposity)\b|\bVAT\b", re.I), "visceral adipose tissue"),
}
_PHRASES = [
    (r"≥|=>|>/=|greater than or equal to|more than or equal to|at least|equal to or greater than", ">="),
    (r"≤|=<|</=|less than or equal to|equal to or less than|no more than|up to", "<="),
    (r"greater than|more than|above|higher than|exceeding", ">"),
    (r"less than|below|lower than", "<"),
]
CONDITION_ALIASES = {
    "chronic kidney disease": ["ckd", "chronic renal", "renal insufficiency", "nephropathy"],
    "type 2 diabetes": ["t2d", "t2dm", "type ii diabetes", "type 2 diabetes mellitus", "metabolic", "glycemic"],
    "type 1 diabetes": ["t1d", "type i diabetes"],
    "hypertension": ["high blood pressure", "cardiovascular risk"],
    "heart failure": ["hfref", "hfpef"],
    "obesity": ["obese", "overweight"],
}
# Words too generic to show that a trial condition relates to the patient's.
_GENERIC_WORDS = {"disease", "diseases", "disorder", "disorders", "chronic", "acute", "type", "mellitus", "syndrome",
                  "stage", "risk", "factor", "factors", "and", "with", "the", "of", "in", "or", "high"}
_NUMBER = r"(\d+(?:\.\d+)?)"


def _normalize(text: str) -> str:
    text = re.sub(r"\\([^\w\s])", r"\1", text)  # ClinicalTrials.gov escapes markdown, e.g. "\<"
    for pattern, symbol in _PHRASES:
        text = re.sub(pattern, symbol, text, flags=re.I)
    return text


def split_criteria(text: str) -> dict[str, list[str]]:
    """Split the free-text eligibility block into inclusion and exclusion items."""
    sections: dict[str, list[str]] = {"inclusion": [], "exclusion": []}
    current = "inclusion"
    for line in (text or "").splitlines():
        item = re.sub(r"\\([^\w\s])", r"\1", line).strip()
        heading = re.match(r"^(?:key\s+|main\s+)?(inclusion|exclusion)\s+criteria\b", item, re.I)
        if heading and len(item) < 60:
            current = heading.group(1).lower()
            continue
        item = re.sub(r"^(?:[*•\-–]|\d+[.)])\s*", "", item).strip()
        if item:
            sections[current].append(item)
    return sections


def _bounds(fragment: str, metric: str) -> list[tuple[str, float]]:
    between = re.search(rf"between\s+{_NUMBER}\s*%?\s*(?:and|to|-)\s*{_NUMBER}", fragment, re.I)
    if between:
        bounds = [(">=", float(between.group(1))), ("<=", float(between.group(2)))]
    else:
        bounds = [(op, float(number)) for op, number in re.findall(rf"(>=|<=|>|<|=)\s*{_NUMBER}", fragment)]
        if not bounds:
            span = re.search(rf"{_NUMBER}\s*%?\s*(?:-|–|to)\s*{_NUMBER}", fragment)
            if span:
                bounds = [(">=", float(span.group(1))), ("<=", float(span.group(2)))]
    if metric == "a1c":  # thresholds in mmol/mol are not comparable with % results
        bounds = [item for item in bounds if item[1] <= 20]
    return bounds


def _compare(value: float, op: str, limit: float) -> bool:
    return {">=": value >= limit, "<=": value <= limit, ">": value > limit, "<": value < limit, "=": value == limit}[op]


def core_condition(condition: str) -> str:
    """Reduce chart wording to a searchable name: "CKD stage 3a" -> "ckd"."""
    name = re.sub(r"\(.*?\)|,.*$|\b(?:with|without|due to|associated with)\b.*$", "", condition.casefold())
    name = re.sub(r"\b(?:mellitus|unspecified|stage\s*\w+|primary|essential)\b", "", name)
    return re.sub(r"\s+", " ", name).strip()


def _mentions(text: str, condition: str) -> bool:
    name = core_condition(condition)
    terms = {name, *CONDITION_ALIASES.get(name, [])} - {""}
    lowered = text.casefold()
    return any(re.search(rf"\b{re.escape(term)}\b", lowered) for term in terms)


_CONDITIONAL = re.compile(r"^\s*for\b[^.;]*$|\b(?:if|when|unless|whose|for (?:participants|patients|those) with)\b[^.;]*$", re.I)
# Stop at the next clause so another measurement's threshold is not attributed to this lab.
_CLAUSE_END = re.compile(r"[;\n(]|\.\s|\b(?:with|plus|if|unless|when|while|or|in|on)\b|\band\s+(?![<>=]|\d)", re.I)
_ALTERNATIVE = re.compile(r"^\(?(?:[a-h]|i{1,3}|iv|v)\)|\bor\b", re.I)


def assess_criterion(text: str, profile: dict) -> dict:
    """Return met / not_met / mentions_condition / unknown for one criterion."""
    normalized = _normalize(text)
    for metric, (pattern, label) in LAB_PATTERNS.items():
        for found in pattern.finditer(normalized):
            if _CONDITIONAL.search(normalized[:found.start()]):
                continue  # e.g. "potassium <= 4.5 if eGFR < 45" does not require the eGFR range
            fragment = _CLAUSE_END.split(normalized[found.end():found.end() + 120])[0]
            bounds = _bounds(fragment, metric)
            if not bounds:
                continue
            value = profile.get("labs", {}).get(metric)
            if value is None and metric in ("body_fat", "visceral_fat"):
                dexa_m = (profile.get("dexa") or {}).get("measurements", {})
                if metric == "body_fat":
                    value = dexa_m.get("bodyFatPercent")
                elif metric == "visceral_fat":
                    value = (dexa_m.get("visceralFat") or {}).get("areaCm2")
            if value is None:
                return {"text": text, "result": "unknown", "basis": f"No {label} result on file."}
            basis = f"Your latest {label} is {value:g}."
            if all(_compare(value, op, limit) for op, limit in bounds):
                return {"text": text, "result": "met", "basis": basis}
            if _ALTERNATIVE.search(normalized):
                return {"text": text, "result": "unknown", "basis": f"{basis} This item lists alternatives, so it may still apply."}
            return {"text": text, "result": "not_met", "basis": basis}
    for condition in profile.get("conditions", []):
        if _mentions(text, condition["name"]):
            return {"text": text, "result": "mentions_condition", "basis": f"Mentions {condition['name']}."}
    return {"text": text, "result": "unknown", "basis": ""}


def _stems(text: str) -> set[str]:
    return {word[:6] for word in re.findall(r"[a-z]+|\d+", text.casefold()) if word not in _GENERIC_WORDS}


def _unrelated_conditions(trial_conditions: list[str], profile: dict) -> list[str]:
    """Trial conditions sharing no meaningful word with the patient's (recorded, aliased or lab-inferred) conditions."""
    names = [item["name"] for item in profile.get("conditions", [])] + _inferred_conditions(profile.get("labs", {}))
    known = set()
    for name in names:
        core = core_condition(name)
        known |= _stems(name) | _stems(" ".join(CONDITION_ALIASES.get(core, [])))
    if "healthy" in " ".join(trial_conditions).casefold():
        return []
    return [condition for condition in trial_conditions if not _stems(condition) & known]


def _age_years(value: str | None) -> float | None:
    match = re.match(rf"{_NUMBER}\s*(year|month|week|day)", value or "", re.I)
    if not match:
        return None
    per_year = {"year": 1, "month": 12, "week": 52, "day": 365}[match.group(2).lower()]
    return float(match.group(1)) / per_year


# --- Matching and summaries -------------------------------------------------------

def _distance_miles(lat1: float, lon1: float, lat2: float, lon2: float) -> float:
    p1, p2 = math.radians(lat1), math.radians(lat2)
    a = math.sin((p2 - p1) / 2) ** 2 + math.cos(p1) * math.cos(p2) * math.sin(math.radians(lon2 - lon1) / 2) ** 2
    return 3958.8 * 2 * math.asin(math.sqrt(a))


def _extract_principal_investigator(contacts: dict) -> dict:
    """Find the Principal Investigator (or Lead Official / Study Contact) from protocol contacts."""
    for official in contacts.get("overallOfficials", []):
        name = official.get("name")
        if name:
            raw_role = official.get("role", "PRINCIPAL_INVESTIGATOR") or "PRINCIPAL_INVESTIGATOR"
            role = raw_role.replace("_", " ").title()
            affiliation = official.get("affiliation") or ""
            return {
                "name": name,
                "role": role,
                "affiliation": affiliation or "Lead Sponsoring Institution",
                "source": "Overall Official",
            }
    for loc in contacts.get("locations", []):
        facility = loc.get("facility") or ""
        city = loc.get("city") or ""
        state = loc.get("state") or ""
        site_name = ", ".join(filter(None, [facility, city, state]))
        for c in loc.get("contacts", []):
            if "INVESTIGATOR" in (c.get("role") or "").upper():
                name = c.get("name")
                if name:
                    raw_role = c.get("role") or "PRINCIPAL_INVESTIGATOR"
                    role = raw_role.replace("_", " ").title()
                    return {
                        "name": name,
                        "role": role,
                        "affiliation": site_name or facility or "Lead Investigation Site",
                        "phone": c.get("phone"),
                        "email": c.get("email"),
                        "source": "Site Principal Investigator",
                    }
    for c in contacts.get("centralContacts", []):
        name = c.get("name")
        if name:
            raw_role = c.get("role") or "Study Director / Central Contact"
            role = raw_role.replace("_", " ").title()
            return {
                "name": name,
                "role": role,
                "affiliation": "Central Study Coordination",
                "phone": c.get("phone"),
                "email": c.get("email"),
                "source": "Central Contact",
            }
    for loc in contacts.get("locations", []):
        facility = loc.get("facility") or ""
        for c in loc.get("contacts", []):
            name = c.get("name")
            if name:
                raw_role = c.get("role") or "Study Site Contact"
                role = raw_role.replace("_", " ").title()
                return {
                    "name": name,
                    "role": role,
                    "affiliation": facility or "Clinical Investigation Site",
                    "phone": c.get("phone"),
                    "email": c.get("email"),
                    "source": "Site Contact",
                }
    return {
        "name": "Principal Investigator & Study Team",
        "role": "Principal Investigator / Lead Study Team",
        "affiliation": "Clinical Investigation Site",
        "source": "Study Registry",
    }


def summarize_study(study: dict, geo: tuple[float, float, float] | None = None) -> dict:
    section = study.get("protocolSection", {})
    ident = section.get("identificationModule", {})
    eligibility = section.get("eligibilityModule", {})
    contacts = section.get("contactsLocationsModule", {})
    locations = []
    for item in contacts.get("locations", []):
        location = {key: item.get(key) for key in ("facility", "city", "state", "country", "status")}
        point = item.get("geoPoint")
        if geo and point:
            location["miles"] = round(_distance_miles(geo[0], geo[1], point["lat"], point["lon"]), 1)
        locations.append(location)
    if geo:
        locations.sort(key=lambda item: item.get("miles", math.inf))
    nct_id = ident.get("nctId", "")
    return {
        "nct_id": nct_id,
        "title": ident.get("briefTitle", ""),
        "official_title": ident.get("officialTitle", ""),
        "url": STUDY_URL.format(nct_id),
        "status": section.get("statusModule", {}).get("overallStatus", ""),
        "phases": section.get("designModule", {}).get("phases", []),
        "study_type": section.get("designModule", {}).get("studyType", ""),
        "conditions": section.get("conditionsModule", {}).get("conditions", []),
        "summary": section.get("descriptionModule", {}).get("briefSummary", ""),
        "interventions": [f"{item.get('type', '').title()}: {item.get('name', '')}"
                          for item in section.get("armsInterventionsModule", {}).get("interventions", [])],
        "eligibility": {key: eligibility.get(key) for key in ("sex", "minimumAge", "maximumAge", "healthyVolunteers")},
        "contacts": [{key: item.get(key) for key in ("name", "phone", "email")} for item in contacts.get("centralContacts", [])],
        "principal_investigator": _extract_principal_investigator(contacts),
        "locations": locations[:5],
        "location_count": len(locations),
    }


def match_study(study: dict, profile: dict) -> dict:
    eligibility = study.get("protocolSection", {}).get("eligibilityModule", {})
    reasons, blockers = [], []

    required_sex = eligibility.get("sex", "ALL")
    if required_sex != "ALL" and profile.get("sex"):
        (reasons if required_sex == profile["sex"] else blockers).append(f"Enrolls {required_sex.lower()} participants only.")
    age = profile.get("age")
    low, high = _age_years(eligibility.get("minimumAge")), _age_years(eligibility.get("maximumAge"))
    if age is not None and (low is not None or high is not None):
        within = (low is None or age >= low) and (high is None or age <= high)
        bounds = f"{eligibility.get('minimumAge', 'any')} to {eligibility.get('maximumAge', 'any')}"
        (reasons if within else blockers).append(f"Age range {bounds}; you are {age}.")

    criteria = split_criteria(eligibility.get("eligibilityCriteria", ""))
    inclusion = [assess_criterion(item, profile) for item in criteria["inclusion"]]
    exclusion = [assess_criterion(item, profile) for item in criteria["exclusion"]]
    blockers += [f"Inclusion not met: {item['text']} {item['basis']}" for item in inclusion if item["result"] == "not_met"]
    blockers += [f"Exclusion applies: {item['text']} {item['basis']}" for item in exclusion if item["result"] == "met"]
    reasons += [f"Inclusion met: {item['text']} {item['basis']}" for item in inclusion if item["result"] == "met"]
    flags = [f"Check with the study team: {item['text']}" for item in exclusion if item["result"] == "mentions_condition"]

    listed = study.get("protocolSection", {}).get("conditionsModule", {}).get("conditions", [])
    listed_stems = _stems(" ".join(listed))
    shared = [item["name"] for item in profile.get("conditions", [])
              if _mentions(" ".join(listed), item["name"]) or _stems(core_condition(item["name"])) <= listed_stems != set()]
    if shared:
        reasons.insert(0, f"Studies {', '.join(shared)}.")
    unrelated = _unrelated_conditions(listed, profile)
    if unrelated:
        flags.insert(0, f"Also studies {', '.join(unrelated)}, which is not in your records.")

    if blockers:
        verdict = "likely_ineligible"
    elif (shared and not flags and any(item["result"] == "met" for item in inclusion)
          and not any(item["result"] in {"unknown", "mentions_condition"} for item in inclusion + exclusion)
          and age is not None and profile.get("sex")):
        verdict = "strong_match"
    else:
        verdict = "possible_match"
    return {
        "verdict": verdict,
        "reasons": reasons,
        "blockers": blockers,
        "flags": flags,
        "inclusion": inclusion,
        "exclusion": exclusion,
        "unreviewed": sum(item["result"] == "unknown" for item in inclusion + exclusion),
    }


VERDICT_ORDER = {"strong_match": 0, "possible_match": 1, "likely_ineligible": 2}


def find_trials(profile: dict, geo: tuple[float, float, float] | None = None, per_condition: int = 25,
                limit: int = 20, include_ineligible: bool = False) -> list[dict]:
    """Search active trials for each of the patient's conditions and pre-screen them."""
    studies: dict[str, tuple[dict, str]] = {}
    for condition in profile.get("conditions", [])[:MAX_CONDITIONS]:
        term = core_condition(condition["name"]) or condition["name"]
        for study in search_studies(condition=term, geo=geo, page_size=per_condition):
            nct_id = study.get("protocolSection", {}).get("identificationModule", {}).get("nctId")
            if nct_id and nct_id not in studies:
                studies[nct_id] = (study, condition["name"])
    results = []
    for study, searched_for in studies.values():
        match = match_study(study, profile)
        if match["verdict"] == "likely_ineligible" and not include_ineligible:
            continue
        results.append({**summarize_study(study, geo), "searched_condition": searched_for, "match": match})
    results.sort(key=lambda item: (VERDICT_ORDER[item["match"]["verdict"]],
                                   -sum(c["result"] == "met" for c in item["match"]["inclusion"])))
    return results[:limit]


def resources_from_json(data) -> list[dict]:
    """Accept a FHIR Bundle, a list of resources, or {"resources": [...]}, as stored by the sync."""
    if isinstance(data, dict) and data.get("resourceType") == "Bundle":
        return [entry["resource"] for entry in data.get("entry", []) if isinstance(entry, dict) and isinstance(entry.get("resource"), dict)]
    if isinstance(data, dict) and isinstance(data.get("resources"), list):
        data = data["resources"]
    if isinstance(data, list):
        return [item for item in data if isinstance(item, dict) and item.get("resourceType")]
    return []


def profile_from_json(data) -> dict:
    """FHIR (Bundle / list / {"resources": [...]}) or a simple {age, sex, conditions, labs} profile."""
    resources = resources_from_json(data)
    return patient_profile(resources) if resources else _profile_from_body(data if isinstance(data, dict) else {})


def stored_resources(source="connected") -> list[dict]:
    if source == "sample":
        resources = storage.load_resources(namespace=SAMPLE_NAMESPACE)
    elif source == "connected":
        connection = storage.load_connection()
        if not connection:
            return []
        connection = connection[0]
        patient_id = connection.get("patient_id")
        if not patient_id or not connection.get("fhir_base_url"):
            return []
        resources = storage.load_resources(namespace=connection["fhir_base_url"])
        # A server namespace can contain previous patients. Never combine them.
        resources = [r for r in resources if
                     (r.get("resourceType") == "Patient" and r.get("id") == patient_id) or
                     (r.get("resourceType") != "Patient" and
                      (r.get("subject") or r.get("patient") or {}).get("reference", "").rstrip("/").endswith("/Patient/" + patient_id)) or
                     (r.get("resourceType") != "Patient" and
                      (r.get("subject") or r.get("patient") or {}).get("reference") == "Patient/" + patient_id)]
    else:
        return []
    return resources


def stored_profile(source="connected") -> dict | None:
    resources = stored_resources(source)
    if not resources:
        return None
    prof = patient_profile(resources)
    try:
        latest_dexa = storage.get_latest_dexa_scan()
        if latest_dexa:
            prof["dexa"] = latest_dexa
            m = latest_dexa.get("measurements", {})
            vat = (m.get("visceralFat") or {}).get("areaCm2", 0)
            bf = m.get("bodyFatPercent", 0)
            if (vat >= 95 or bf >= 27) and not any("Adiposity" in c.get("name", "") or "Visceral" in c.get("name", "") for c in prof.get("conditions", [])):
                prof["conditions"].append({
                    "name": "Visceral Adiposity & Elevated Body Fat (DEXA)",
                    "source": "dexa",
                })
    except Exception:
        pass
    return prof


# --- HTTP routes ------------------------------------------------------------------

router = APIRouter()
trials = router  # Backwards compatibility alias
CORS_ORIGINS = {item.strip() for item in os.getenv("TRIALS_CORS_ORIGINS", "").split(",") if item.strip()}


def trial_json(data: dict, status_code: int = 200, origin: str | None = None) -> JSONResponse:
    res = JSONResponse(content=data, status_code=status_code)
    res.headers["Cache-Control"] = "no-store"
    if origin and origin in CORS_ORIGINS:
        res.headers["Access-Control-Allow-Origin"] = origin
        res.headers["Access-Control-Allow-Headers"] = "Content-Type"
        res.headers["Access-Control-Allow-Methods"] = "GET, POST, OPTIONS"
        res.headers["Vary"] = "Origin"
    return res



def _geo_from(source) -> tuple[float, float, float] | None:
    if not any(source.get(key) not in (None, "") for key in ("lat", "lon")):
        return None
    try:
        lat, lon = float(source.get("lat")), float(source.get("lon"))
    except (TypeError, ValueError):
        raise ValueError("Provide both latitude and longitude as numbers.")
    if not (-90 <= lat <= 90 and -180 <= lon <= 180):
        raise ValueError("Latitude or longitude is out of range.")
    try:
        miles = float(source.get("miles", 100))
    except (TypeError, ValueError):
        raise ValueError("Radius must be a number.")
    if not math.isfinite(miles):
        raise ValueError("Radius must be finite.")
    miles = min(max(miles, 1), 500)
    return lat, lon, miles


def _profile_from_body(body: dict) -> dict:
    """Accept a profile from a frontend that holds its own FHIR data."""
    labs = body.get("labs") or {}
    if not isinstance(labs, dict) or not isinstance(body.get("conditions", []), list):
        raise ValueError("Expected labs to be an object and conditions to be a list.")
    conditions = [{"name": str(name), "source": "client"} for name in body.get("conditions", []) if str(name).strip()]
    profile = {
        "age": body.get("age") if isinstance(body.get("age"), (int, float)) and 0 <= body["age"] <= 130 else None,
        "sex": str(body.get("sex", "")).upper() or None,
        "labs": {key: float(labs[key]) if isinstance(labs.get(key), (int, float)) and math.isfinite(labs[key]) else None for key in LAB_PATTERNS},
        "medications": [],
    }
    profile["conditions"] = conditions or [{"name": name, "source": "labs"} for name in _inferred_conditions(profile["labs"])]
    return profile


def _run(profile: dict | None, geo, include_ineligible: bool, origin: str | None = None):
    if not profile:
        return trial_json({"error": "No synced patient data yet. Connect and sync a health record first."}, 404, origin)
    if not profile["conditions"]:
        return trial_json({"profile": profile, "trials": [], "note": "No active conditions found to search for."}, 200, origin)
    try:
        results = find_trials(profile, geo=geo, include_ineligible=include_ineligible)
    except (requests.RequestException, ValueError):
        return trial_json({"error": "ClinicalTrials.gov could not be reached. Try again shortly."}, 502, origin)
    return trial_json({"profile": profile, "searches": planned_searches(profile, geo), "trials": results}, 200, origin)


@router.get("/api/trials/profile")
def api_profile(request: Request, source: str = "connected"):
    origin = request.headers.get("origin")
    profile = stored_profile(source)
    if profile is None:
        return trial_json({"error": "No records for this source. Connect and sync, or load the fictional sample."}, 404, origin)
    return trial_json({"profile": profile, "searches": planned_searches(profile)}, origin=origin)


@router.get("/api/trials")
def api_trials(request: Request, source: str = "connected", consent: str = None, lat: str = None, lon: str = None, miles: str = None, all: str = None):
    """Match the locally synced patient. Optional query: lat, lon, miles, all=1."""
    origin = request.headers.get("origin")
    if consent != "yes":
        return trial_json({"error": "Confirm sharing the displayed search topics with ClinicalTrials.gov first."}, 400, origin)
    geo_dict = {"lat": lat, "lon": lon, "miles": miles}
    try:
        geo = _geo_from(geo_dict)
    except ValueError as exc:
        return trial_json({"error": str(exc)}, 400, origin)
    return _run(stored_profile(source), geo, all == "1", origin)


@router.post("/api/trials/match")
async def api_match(request: Request):
    """Match FHIR records or a simple profile sent by a frontend."""
    origin = request.headers.get("origin")
    try:
        body = await request.json()
    except Exception:
        body = None
    if not isinstance(body, (dict, list)):
        return trial_json({"error": "Provide a FHIR Bundle, resource list, or profile JSON."}, 400, origin)
    try:
        profile = profile_from_json(body)
    except ValueError as exc:
        return trial_json({"error": str(exc)}, 400, origin)
    options = body if isinstance(body, dict) else {}
    try:
        geo = _geo_from(options) or _geo_from(dict(request.query_params))
    except ValueError as exc:
        return trial_json({"error": str(exc)}, 400, origin)
    return _run(profile, geo, options.get("all") is True or request.query_params.get("all") == "1", origin)


@router.post("/api/trials/inquire")
async def api_inquire(request: Request):
    """Save and intermediate a patient inquiry to a trial's Principal Investigator."""
    origin = request.headers.get("origin")
    try:
        body = await request.json()
    except Exception:
        body = None
    if not isinstance(body, dict):
        return trial_json({"error": "Invalid JSON body provided."}, 400, origin)

    nct_id = str(body.get("nct_id", "")).strip().upper()
    if not NCT_PATTERN.match(nct_id):
        return trial_json({"error": "Invalid or missing NCT study identifier."}, 400, origin)

    message = str(body.get("message", "")).strip()
    if not message:
        return trial_json({"error": "Please enter a message to intermediate with the study team."}, 400, origin)

    pi_info = body.get("principal_investigator") or {}
    if not isinstance(pi_info, dict):
        pi_info = {}

    inquiry_record = {
        "nct_id": nct_id,
        "trial_title": str(body.get("trial_title", "")).strip(),
        "pi_name": str(body.get("pi_name") or pi_info.get("name") or "Principal Investigator").strip(),
        "pi_role": str(body.get("pi_role") or pi_info.get("role") or "Principal Investigator").strip(),
        "pi_affiliation": str(body.get("pi_affiliation") or pi_info.get("affiliation") or "").strip(),
        "message": message,
        "patient_notes": str(body.get("patient_notes", "")).strip(),
        "intermediation_status": "queued_for_intermediation",
        "source": str(body.get("source", "connected")),
        "created_at": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
    }

    inquiry_id = storage.save_trial_inquiry(inquiry_record)

    return trial_json({
        "success": True,
        "inquiry_id": inquiry_id,
        "nct_id": nct_id,
        "intermediary_status": "queued_for_intermediation",
        "message": f"Inquiry successfully received. Nudge Lab will intermediate your message with {inquiry_record['pi_name']} while safeguarding your direct contact details.",
        "record": {
            "id": inquiry_id,
            "nct_id": nct_id,
            "pi_name": inquiry_record["pi_name"],
            "created_at": inquiry_record["created_at"],
        },
    }, 201, origin)


@router.get("/api/trials/inquiries")
def api_list_inquiries(request: Request, nct_id: str | None = None):
    """Retrieve saved trial inquiries."""
    origin = request.headers.get("origin")
    records = storage.list_trial_inquiries(nct_id)
    return trial_json({"inquiries": records}, 200, origin)


@router.get("/api/trials/{nct_id}")
def api_trial(nct_id: str, request: Request, source: str = "connected"):
    origin = request.headers.get("origin")
    try:
        study = get_study(nct_id.upper())
    except ValueError as exc:
        return trial_json({"error": str(exc)}, 400, origin)
    except requests.HTTPError as exc:
        status = exc.response.status_code if exc.response is not None else 502
        return trial_json({"error": "Study not found." if status == 404 else "ClinicalTrials.gov request failed."}, 404 if status == 404 else 502, origin)
    except requests.RequestException:
        return trial_json({"error": "ClinicalTrials.gov could not be reached. Try again shortly."}, 502, origin)
    profile = stored_profile(source)
    try:
        geo = _geo_from(dict(request.query_params))
    except ValueError as exc:
        return trial_json({"error": str(exc)}, 400, origin)
    return trial_json({
        "trial": summarize_study(study, geo),
        "match": match_study(study, profile) if profile else None,
    }, origin=origin)




TRIALS_PAGE = """<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Clinical Trials</title><style>
:root{font:16px/1.5 system-ui,sans-serif;color-scheme:light dark}body{max-width:1050px;margin:36px auto;padding:0 20px}
.muted{opacity:.72}.card{border:1px solid #8885;border-radius:12px;padding:20px;margin:18px 0}.warning{border-left:4px solid #d99000;padding:10px 14px;background:#d9900018}
.badge{display:inline-block;border-radius:999px;padding:2px 10px;font-size:.85rem;background:#635bff22}.strong_match{background:#1a7f3722}.likely_ineligible{background:#d1242f22}
details{margin-top:8px}li{margin:4px 0}
</style></head><body><p><a href="/">← Dashboard</a></p><h1>Clinical trials you may qualify for</h1>
<p class="warning">This is an automated pre-screen of recruiting studies on ClinicalTrials.gov, not medical advice or a confirmed eligibility decision. Only the condition names below are sent to ClinicalTrials.gov. Talk with your clinician or the study team before acting.</p>
{% if error %}<p class="warning">{{ error }}</p>{% else %}
<p>Searched for: {% for item in profile.conditions %}<span class="badge">{{ item.name }}{% if item.source == 'labs' %} (from labs){% endif %}</span> {% else %}none{% endfor %}</p>
{% for trial in trials %}<section class="card"><span class="badge {{ trial.match.verdict }}">{{ trial.match.verdict.replace('_', ' ') }}</span>
<h2><a href="{{ trial.url }}" target="_blank" rel="noopener">{{ trial.title }}</a></h2>
<p class="muted">{{ trial.nct_id }} · {{ trial.status.replace('_', ' ').lower() }}{% if trial.phases %} · {{ trial.phases|join(', ') }}{% endif %} · {{ trial.location_count }} sites</p>
<p>{{ trial.summary[:600] }}{% if trial.summary|length > 600 %}…{% endif %}</p>
{% if trial.match.reasons %}<p><strong>Why it may fit</strong></p><ul>{% for item in trial.match.reasons %}<li>{{ item }}</li>{% endfor %}</ul>{% endif %}
{% if trial.match.blockers %}<p><strong>Possible barriers</strong></p><ul>{% for item in trial.match.blockers %}<li>{{ item }}</li>{% endfor %}</ul>{% endif %}
{% if trial.match.flags %}<p><strong>Ask the study team</strong></p><ul>{% for item in trial.match.flags %}<li>{{ item }}</li>{% endfor %}</ul>{% endif %}
<details><summary>Details ({{ trial.match.unreviewed }} criteria need review by the study team)</summary>
{% if trial.interventions %}<p><strong>Interventions:</strong> {{ trial.interventions|join('; ') }}</p>{% endif %}
<p><strong>Eligibility:</strong> {{ trial.eligibility.sex or 'ALL' }}, {{ trial.eligibility.minimumAge or 'no minimum age' }} to {{ trial.eligibility.maximumAge or 'no maximum age' }}</p>
{% if trial.locations %}<p><strong>Sites:</strong></p><ul>{% for site in trial.locations %}<li>{{ site.facility }}, {{ site.city }}{% if site.state %}, {{ site.state }}{% endif %}, {{ site.country }}{% if site.miles is defined %} ({{ site.miles }} mi){% endif %}</li>{% endfor %}</ul>{% endif %}
{% if trial.contacts %}<p><strong>Contact:</strong> {% for c in trial.contacts %}{{ c.name }}{% if c.phone %} · {{ c.phone }}{% endif %}{% if c.email %} · {{ c.email }}{% endif %}{% if not loop.last %}; {% endif %}{% endfor %}</p>{% endif %}
</details></section>
{% else %}<p>No recruiting trials matched. Try again after your next sync.</p>{% endfor %}{% endif %}
</body></html>"""


@router.get("/trials")
def trials_page(source: str = None):
    dest = ("/sample" if source == "sample" else "/app") + "#trials"
    return RedirectResponse(url=dest, status_code=302)



INCLUSION_MARKS = {"met": "✓", "not_met": "✗", "mentions_condition": "⚑", "unknown": "·"}
# For exclusions, "met" means the exclusion applies to the patient.
EXCLUSION_MARKS = {"met": "✗", "not_met": "✓", "mentions_condition": "⚑", "unknown": "·"}


def _wrap(text: str, indent: str, width: int = 110) -> str:
    import textwrap
    return textwrap.fill(" ".join(text.split()), width=width, initial_indent=indent, subsequent_indent=" " * len(indent) + "  ")


def describe_profile(profile: dict, searches: list[dict], sent: bool = True) -> str:
    labs = ", ".join(f"{key}={value:g}" for key, value in profile["labs"].items() if value is not None) or "none"
    lines = ["PROFILE (what the matcher read from your JSON)",
             f"  age: {profile.get('age')}   sex: {profile.get('sex')}",
             f"  labs: {labs}",
             f"  medications: {', '.join(profile.get('medications') or []) or 'none'}",
             "  conditions:"]
    lines += [f"    - {item['name']}  [{item['source']}]" for item in profile["conditions"]] or ["    (none)"]
    lines.append("\nSEARCHES SENT TO CLINICALTRIALS.GOV" if sent else "\nSEARCHES THAT WOULD BE SENT (none sent with --profile-only)")
    lines += [f"  {item['from']!r} -> query.cond={item['query']!r}\n    {item['url']}" for item in searches] or ["  (none: no conditions)"]
    return "\n".join(lines)


def describe_trial(trial: dict, criteria: bool = True) -> str:
    match = trial["match"]
    eligibility = trial["eligibility"]
    nearest = trial["locations"][0] if trial["locations"] else {}
    where = ", ".join(filter(None, [nearest.get("facility"), nearest.get("city"), nearest.get("state") or nearest.get("country")]))
    if "miles" in nearest:
        where += f" ({nearest['miles']} mi)"
    lines = [f"\n{'━' * 110}", f"[{match['verdict'].replace('_', ' ').upper()}] {trial['nct_id']}  {trial['url']}",
             _wrap(trial["title"], "  "),
             f"  status {trial['status']} | {', '.join(trial['phases']) or 'no phase'} | sex {eligibility.get('sex') or 'ALL'}, "
             f"age {eligibility.get('minimumAge') or 'any'} to {eligibility.get('maximumAge') or 'any'} | {trial['location_count']} sites",
             _wrap(f"conditions: {', '.join(trial['conditions'])}", "  ")]
    if where:
        lines.append(f"  nearest site: {where}")
    if trial["summary"]:
        lines.append(_wrap(f"summary: {trial['summary'][:500]}{'…' if len(trial['summary']) > 500 else ''}", "  "))
    for title, items in (("why it may fit", match["reasons"]), ("barriers", match["blockers"]), ("check with study team", match["flags"])):
        if items:
            lines.append(f"  {title}:")
            lines += [_wrap(item, "    - ") for item in items]
    if criteria:
        for title, items, marks in (("INCLUSION", match["inclusion"], INCLUSION_MARKS), ("EXCLUSION", match["exclusion"], EXCLUSION_MARKS)):
            lines.append(f"  {title} (as written on ClinicalTrials.gov)")
            for item in items:
                lines.append(_wrap(item["text"], f"    {marks[item['result']]} "))
                if item["basis"]:
                    lines.append(f"        → {item['basis']}")
    return "\n".join(lines)


def main(argv: list[str] | None = None) -> None:
    """Try patient JSON against live ClinicalTrials.gov data and see how every criterion was read."""
    import argparse
    import json
    import sys

    parser = argparse.ArgumentParser(
        description="Pre-screen recruiting ClinicalTrials.gov studies for a patient JSON.",
        epilog="Legend: ✓ meets / clear of  ✗ fails / exclusion applies  ⚑ mentions your condition  · not checkable",
    )
    parser.add_argument("source", help="JSON file, '-' for stdin, or inline JSON. FHIR Bundle, resource list, or "
                                       '{"age":..,"sex":..,"conditions":[..],"labs":{"egfr":..,"a1c":..,"bmi":..,"systolic":..}}')
    parser.add_argument("--lat", type=float)
    parser.add_argument("--lon", type=float)
    parser.add_argument("--miles", type=float, default=100)
    parser.add_argument("--limit", type=int, default=5, help="trials to show (default 5)")
    parser.add_argument("--all", action="store_true", help="include likely ineligible trials")
    parser.add_argument("--nct", help="explain one trial (e.g. NCT05759468) instead of searching")
    parser.add_argument("--brief", action="store_true", help="hide the line-by-line criteria")
    parser.add_argument("--profile-only", action="store_true", help="show what was read from the JSON and the queries; no API calls")
    parser.add_argument("--json", action="store_true", help="print raw JSON output instead")
    args = parser.parse_args(argv)

    if args.source == "-":
        data = json.load(sys.stdin)
    elif args.source.lstrip().startswith(("{", "[")):
        data = json.loads(args.source)
    else:
        with open(args.source, encoding="utf-8") as handle:
            data = json.load(handle)
    profile = profile_from_json(data)
    geo = (args.lat, args.lon, args.miles) if args.lat is not None and args.lon is not None else None
    searches = planned_searches(profile, geo)

    if args.nct:
        study = get_study(args.nct.upper())
        trials_found = [{**summarize_study(study, geo), "searched_condition": None, "match": match_study(study, profile)}]
    elif args.profile_only:
        trials_found = []
    else:
        trials_found = find_trials(profile, geo=geo, limit=args.limit, include_ineligible=args.all)

    if args.json:
        print(json.dumps({"profile": profile, "searches": searches, "trials": trials_found}, indent=2, ensure_ascii=False))
        return
    print(describe_profile(profile, searches, sent=not args.profile_only))
    if args.profile_only:
        print("\nRun again without --profile-only to fetch and score matching trials.")
    else:
        print(f"\n{len(trials_found)} trial(s) shown. Legend: ✓ meets/clear  ✗ fails/excluded  ⚑ mentions your condition  · not checkable")
        for trial in trials_found:
            print(describe_trial(trial, criteria=not args.brief))


if __name__ == "__main__":
    main()
