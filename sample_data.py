"""Load the repository's fictional Maya FHIR fixture, without OAuth."""

import json
from pathlib import Path

SAMPLE_NAMESPACE = "urn:patient-agency:synthetic:maya-demo-001"
FIXTURE_PATH = Path(__file__).resolve().parent / "fixtures" / "maya-synthetic.json"


def sample_resources():
    bundle = json.loads(FIXTURE_PATH.read_text(encoding="utf-8"))
    return [entry["resource"] for entry in bundle["entry"]]
