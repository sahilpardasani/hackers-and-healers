"""Print a minimized fixture for Epic's documented Camila test patient only.

Never export production records or connection credentials. Redirecting arbitrary
patient data to Git is not supported. The original encrypted store is unchanged.
"""
from copy import deepcopy
import json
from pathlib import Path
import sys

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

SANDBOX = "https://fhir.epic.com/interconnect-fhir-oauth/api/FHIR/R4"
TEST_PATIENT = "erXuFYUfucBZaryVksYEcMg3"  # Epic's publicly documented sandbox ID.
FIELDS = {
    "Patient": {"active", "birthDate", "gender", "deceasedBoolean"},
    "Observation": {"status", "category", "code", "subject", "effectiveDateTime", "issued", "valueQuantity", "component", "interpretation"},
    "MedicationRequest": {"status", "intent", "category", "courseOfTherapyType", "medicationReference", "medicationCodeableConcept", "subject", "authoredOn", "reasonCode", "dosageInstruction", "dispenseRequest"},
    "Appointment": {"status", "appointmentType", "serviceCategory", "serviceType", "start", "end", "minutesDuration", "created", "participant"},
}
DROP = {"identifier", "extension", "meta", "address", "telecom", "note", "contained", "performer", "requester", "recorder", "patientInstruction", "generalPractitioner", "managingOrganization"}


def _belongs(resource):
    if resource.get("resourceType") == "Patient":
        return resource.get("id") == TEST_PATIENT
    refs = [(resource.get("subject") or {}).get("reference", "")]
    refs += [p.get("actor", {}).get("reference", "") for p in resource.get("participant", [])]
    return any(ref == f"Patient/{TEST_PATIENT}" or ref.endswith(f"/Patient/{TEST_PATIENT}") for ref in refs)


def make_bundle(connection, records):
    if connection.get("fhir_base_url", "").rstrip("/") != SANDBOX or connection.get("patient_id") != TEST_PATIENT:
        raise ValueError("Export refused: expected the documented Epic sandbox Camila patient.")
    selected = [r for r in records if r.get("resourceType") in FIELDS and _belongs(r)]
    if sum(r["resourceType"] == "Patient" for r in selected) != 1:
        raise ValueError("Export refused: exactly one matching sandbox Patient is required.")
    ids = {f'{r["resourceType"]}/{r["id"]}': f'{r["resourceType"]}/camila-sandbox-{i:03d}' for i, r in enumerate(selected, 1)}

    def clean(value):
        if isinstance(value, list):
            return [clean(v) for v in value]
        if not isinstance(value, dict):
            return value
        out = {}
        for key, v in value.items():
            if key in DROP:
                continue
            if key == "reference":
                relative = v.removeprefix(SANDBOX + "/")
                if relative in ids:
                    out[key] = ids[relative]
                continue
            out[key] = clean(v)
        return out

    output = []
    for original in selected:
        r = deepcopy(original)
        kind = r["resourceType"]
        if kind == "Appointment":
            r["participant"] = [p for p in r.get("participant", []) if _belongs({"participant": [p]})]
            for p in r["participant"]:
                p.get("actor", {}).pop("display", None)
        safe = clean({k: v for k, v in r.items() if k in FIELDS[kind]})
        safe.update(resourceType=kind, id=ids[f'{kind}/{r["id"]}'].split("/")[1])
        if kind == "Patient":
            safe["name"] = [{"use": "usual", "text": "Camila — Epic sandbox test patient", "given": ["Camila"]}]
        output.append(safe)
    return {"resourceType": "Bundle", "type": "collection", "id": "camila-epic-sandbox-minimized",
            "meta": {"tag": [{"system": "urn:patient-agency:data-source", "code": "epic-sandbox-test-data", "display": "Minimized sandbox fixture; not a real patient or complete chart"}]},
            "entry": [{"resource": r} for r in output]}


if __name__ == "__main__":
    from dotenv import load_dotenv
    load_dotenv(Path(__file__).resolve().parents[1] / ".env")
    import storage
    saved = storage.load_connection()
    if not saved:
        raise SystemExit("Export refused: no sandbox connection.")
    connection = saved[0]
    # Validate provenance before reading any namespace's records.
    if connection.get("fhir_base_url", "").rstrip("/") != SANDBOX or connection.get("patient_id") != TEST_PATIENT:
        raise SystemExit("Export refused: not the documented Camila sandbox account.")
    bundle = make_bundle(connection, storage.load_resources(namespace=SANDBOX))
    print(json.dumps(bundle, ensure_ascii=False, indent=2))
