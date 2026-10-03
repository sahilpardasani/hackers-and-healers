from datetime import date
import json
from pathlib import Path
import unittest
from unittest.mock import patch

import app as service
import clinicaltrial as ct

CRITERIA = """Inclusion Criteria:

* Adults aged 18 years or older
* Chronic kidney disease with eGFR ≥ 25 and \\< 75 mL/min/1.73 m2
* HbA1c between 6.5% and 10.5%

Exclusion Criteria:

* Type 1 diabetes
* Systolic blood pressure > 180 mmHg
* Prior kidney transplantation"""


def study(nct_id="NCT00000001", sex="ALL", minimum_age="18 Years", maximum_age=None, criteria=CRITERIA):
    eligibility = {"eligibilityCriteria": criteria, "sex": sex, "minimumAge": minimum_age}
    if maximum_age:
        eligibility["maximumAge"] = maximum_age
    return {"protocolSection": {
        "identificationModule": {"nctId": nct_id, "briefTitle": "Kidney study"},
        "statusModule": {"overallStatus": "RECRUITING"},
        "conditionsModule": {"conditions": ["Chronic Kidney Disease", "Type 2 Diabetes Mellitus"]},
        "eligibilityModule": eligibility,
        "contactsLocationsModule": {"locations": [
            {"facility": "Far", "city": "Seattle", "country": "United States", "geoPoint": {"lat": 47.6, "lon": -122.3}},
            {"facility": "Near", "city": "Boston", "country": "United States", "geoPoint": {"lat": 42.36, "lon": -71.06}},
        ]},
    }}


def profile(**overrides):
    base = {"age": 58, "sex": "FEMALE", "medications": [],
            "conditions": [{"name": "Chronic kidney disease stage 3a", "source": "record"}],
            "labs": {"egfr": 48.0, "a1c": 7.2, "bmi": None, "systolic": 138.0}}
    return {**base, **overrides}


def observation(code, value, when):
    return {"resourceType": "Observation", "code": {"coding": [{"code": code}]},
            "valueQuantity": {"value": value, "unit": "%" if code == "4548-4" else "mL/min/1.73m2"}, "effectiveDateTime": when}


class ProfileTests(unittest.TestCase):
    def test_profile_uses_latest_labs_active_conditions_and_demographics(self):
        resources = [
            {"resourceType": "Patient", "birthDate": "1968-10-04", "gender": "female"},
            {"resourceType": "Condition", "code": {"text": "Type 2 diabetes mellitus"},
             "clinicalStatus": {"coding": [{"code": "active"}]}},
            {"resourceType": "Condition", "code": {"text": "Acute bronchitis"},
             "clinicalStatus": {"coding": [{"code": "resolved"}]}},
            observation("33914-3", 61, "2024-01-01"), observation("33914-3", 52, "2025-06-01"),
            {"resourceType": "Observation", "effectiveDateTime": "2025-06-01", "code": {"coding": [{"code": "85354-9"}]},
             "component": [{"code": {"coding": [{"code": "8480-6"}]}, "valueQuantity": {"value": 141, "unit": "mmHg"}}]},
        ]
        result = ct.patient_profile(resources, today=date(2026, 10, 3))
        self.assertEqual((result["age"], result["sex"]), (57, "FEMALE"))
        self.assertEqual([item["name"] for item in result["conditions"]], ["Type 2 diabetes mellitus"])
        self.assertEqual((result["labs"]["egfr"], result["labs"]["systolic"]), (52, 141))

    def test_conditions_are_inferred_from_labs_without_a_problem_list(self):
        result = ct.patient_profile([observation("33914-3", 45, "2025-01-01"), observation("4548-4", 6.0, "2025-01-01")])
        self.assertEqual([item["name"] for item in result["conditions"]], ["Chronic Kidney Disease", "Prediabetes"])
        self.assertTrue(all(item["source"] == "labs" for item in result["conditions"]))


class CriteriaTests(unittest.TestCase):
    def test_split_unescapes_and_separates_sections(self):
        sections = ct.split_criteria(CRITERIA)
        self.assertEqual(len(sections["inclusion"]), 3)
        self.assertIn("< 75", sections["inclusion"][1])
        self.assertEqual(sections["exclusion"][0], "Type 1 diabetes")

    def test_lab_thresholds_are_evaluated(self):
        cases = [
            ("eGFR ≥ 25 and \\< 75 mL/min/1.73 m2", 48, "met"),
            ("eGFR ≥ 25 and \\< 75 mL/min/1.73 m2", 20, "not_met"),
            ("eGFR between 30 and 60", 61, "not_met"),
            ("eGFR of 15-59 mL/min/1.73m2", 40, "met"),
            ("estimated glomerular filtration rate less than 30", 29, "met"),
            ("eGFR at least 45 mL/min", None, "unknown"),
            # Another measurement's threshold is not attributed to eGFR.
            ("eGFR ≥ 30 mL/min with urine protein ≥ 150 mg/g", 48, "met"),
            # Conditional clauses are not requirements.
            ("Potassium ≥ 3.0 and ≤ 4.5 mmol/L if eGFR < 45", 48, "unknown"),
            # Alternatives or lettered cohorts may still apply.
            ("(b) eGFR 60-75 mL/min/1.73 m² AND:", 48, "unknown"),
            ("eGFR ≥ 60 or on dialysis", 48, "unknown"),
            ("Obese (BMI>/=30 kg/m2)", None, "unknown"),
            ("For insulin users, screening eGFR ≥ 60", 48, "unknown"),
        ]
        for text, egfr, expected in cases:
            with self.subTest(text=text, egfr=egfr):
                result = ct.assess_criterion(text, profile(labs={"egfr": egfr}))
                self.assertEqual(result["result"], expected)

    def test_a1c_thresholds_in_mmol_per_mol_are_not_compared(self):
        result = ct.assess_criterion("HbA1c ≥ 53 mmol/mol", profile())
        self.assertEqual(result["result"], "unknown")

    def test_chart_wording_is_simplified_for_search(self):
        self.assertEqual(ct.core_condition("Chronic kidney disease stage 3a"), "chronic kidney disease")
        self.assertEqual(ct.core_condition("Type 2 diabetes mellitus with hyperglycemia"), "type 2 diabetes")
        self.assertEqual(ct.core_condition("Essential (primary) hypertension"), "hypertension")

    def test_condition_mentions_use_aliases(self):
        result = ct.assess_criterion("Known CKD requiring dialysis", profile())
        self.assertEqual(result["result"], "mentions_condition")


class MatchTests(unittest.TestCase):
    def test_unknown_criteria_prevent_strong_match_even_if_labs_meet_inclusion(self):
        match = ct.match_study(study(), profile())
        self.assertEqual(match["verdict"], "possible_match")
        self.assertTrue(match["reasons"][0].startswith("Studies Chronic kidney disease"))

    def test_trial_for_a_condition_the_patient_lacks_is_not_a_strong_match(self):
        other = study()
        other["protocolSection"]["conditionsModule"]["conditions"] = ["Multiple Sclerosis", "Hypertension"]
        match = ct.match_study(other, profile(conditions=[{"name": "Essential (primary) hypertension", "source": "record"}]))
        self.assertEqual(match["verdict"], "possible_match")
        self.assertIn("Multiple Sclerosis", match["flags"][0])

    def test_compact_or_related_trial_wording_counts_as_shared(self):
        other = study()
        other["protocolSection"]["conditionsModule"]["conditions"] = ["Type2diabetes", "Diabetic Kidney Disease"]
        t2d = profile(conditions=[{"name": "Type 2 diabetes mellitus with hyperglycemia", "source": "record"}])
        self.assertIn("Studies Type 2 diabetes", ct.match_study(other, t2d)["reasons"][0])
        other["protocolSection"]["conditionsModule"]["conditions"] = ["Type 1 Diabetes"]
        self.assertFalse(ct.match_study(other, t2d)["reasons"][0].startswith("Studies"))

    def test_related_wording_of_a_known_condition_is_not_flagged(self):
        listed = ["Diabetic Kidney Disease", "Renal Insufficiency, Chronic", "Diabetes Mellitus, Type 2", "Obesity"]
        self.assertEqual(ct._unrelated_conditions(listed + ["Type2diabetes"], profile(labs={"egfr": 48.0, "a1c": 7.2, "bmi": 31.0})), [])

    def test_sex_age_and_exclusion_lab_block_a_match(self):
        self.assertEqual(ct.match_study(study(sex="MALE"), profile())["verdict"], "likely_ineligible")
        self.assertEqual(ct.match_study(study(maximum_age="50 Years"), profile())["verdict"], "likely_ineligible")
        high_bp = profile(labs={"egfr": 48.0, "a1c": 7.2, "systolic": 190.0})
        self.assertIn("Exclusion applies", ct.match_study(study(), high_bp)["blockers"][0])

    def test_summary_sorts_sites_by_distance(self):
        summary = ct.summarize_study(study(), geo=(42.35, -71.05, 50))
        self.assertEqual(summary["locations"][0]["facility"], "Near")
        self.assertEqual(summary["url"], "https://clinicaltrials.gov/study/NCT00000001")

    def test_find_trials_dedupes_and_hides_ineligible(self):
        results = {"chronic kidney disease": [study("NCT00000001"), study("NCT00000002", sex="MALE")],
                   "hypertension": [study("NCT00000001")]}
        two = profile(conditions=[{"name": "Chronic kidney disease stage 3a", "source": "record"},
                                  {"name": "Hypertension", "source": "record"}])
        with patch.object(ct, "search_studies", side_effect=lambda condition, **_: results[condition]):
            found = ct.find_trials(two)
        self.assertEqual([item["nct_id"] for item in found], ["NCT00000001"])


class RouteTests(unittest.TestCase):
    def test_sample_bundle_builds_the_expected_profile(self):
        with open(Path(__file__).resolve().parent.parent / "samples" / "sample_patient.json", encoding="utf-8") as handle:
            result = ct.patient_profile(ct.resources_from_json(json.load(handle)), today=date(2026, 10, 3))
        self.assertEqual((result["age"], result["sex"], result["labs"]["egfr"], result["labs"]["systolic"]), (58, "FEMALE", 48, 138))
        self.assertEqual(len(result["conditions"]), 3)  # the resolved condition is ignored

    def test_match_endpoint_accepts_a_fhir_bundle(self):
        bundle = {"resourceType": "Bundle", "entry": [{"resource": {"resourceType": "Patient", "gender": "male"}},
                  {"resource": {"resourceType": "Condition", "code": {"text": "Hypertension"}}}]}
        with patch.object(ct, "find_trials", return_value=[]) as find:
            service.app.test_client().post("/api/trials/match", json=bundle)
        self.assertEqual(find.call_args.args[0]["conditions"][0]["name"], "Hypertension")

    def test_match_endpoint_accepts_a_frontend_profile(self):
        body = {"age": 40, "sex": "female", "conditions": ["Prediabetes"], "labs": {"a1c": 6.1}}
        with patch.object(ct, "find_trials", return_value=[]) as find:
            response = service.app.test_client().post("/api/trials/match", json=body)
        self.assertEqual(response.status_code, 200)
        sent = find.call_args.args[0]
        self.assertEqual((sent["sex"], sent["conditions"][0]["name"], sent["labs"]["a1c"]), ("FEMALE", "Prediabetes", 6.1))

    def test_invalid_nct_id_is_rejected_without_a_request(self):
        with patch.object(ct.requests, "get") as get:
            response = service.app.test_client().get("/api/trials/12345")
        self.assertEqual(response.status_code, 400)
        get.assert_not_called()


if __name__ == "__main__":
    unittest.main()
