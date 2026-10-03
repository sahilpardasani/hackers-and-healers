import unittest

from dashboard import appointment_views, condition_views, coverage_views, medication_views, observation_views, patient_view


class DashboardViewTests(unittest.TestCase):
    def setUp(self):
        self.resources = [
            {"resourceType": "Patient", "name": [{"use": "official", "given": ["Camilla"], "family": "Example"}], "birthDate": "1990-04-05", "gender": "female"},
            {"resourceType": "Observation", "category": [{"coding": [{"code": "laboratory"}]}], "code": {"text": "Hemoglobin A1c"}, "valueQuantity": {"value": 5.8, "unit": "%"}, "effectiveDateTime": "2026-09-01"},
            {"resourceType": "Observation", "category": [{"coding": [{"code": "vital-signs"}]}], "code": {"text": "Weight"}, "valueQuantity": {"value": 70, "unit": "kg"}, "effectiveDateTime": "2026-09-02"},
            {"resourceType": "Condition", "code": {"text": "Prediabetes"}, "clinicalStatus": {"text": "Active"}, "onsetDateTime": "2025-01-01"},
            {"resourceType": "MedicationRequest", "status": "active", "medicationCodeableConcept": {"text": "Example medication"}, "dosageInstruction": [{"text": "Take once daily"}], "authoredOn": "2026-08-01"},
            {"resourceType": "Appointment", "status": "booked", "start": "2026-10-15T10:00:00Z", "serviceType": [{"concept": {"text": "Primary care"}}]},
            {"resourceType": "Coverage", "status": "active", "type": {"text": "Example Health Plan"}, "period": {"start": "2026-01-01"}},
        ]

    def test_patient_and_record_views_are_populated(self):
        self.assertEqual(patient_view(self.resources)["name"], "Camilla Example")
        self.assertEqual(len(observation_views(self.resources)[0]), 1)
        self.assertEqual(observation_views(self.resources)[1][0]["value"], "70 kg")
        self.assertEqual(condition_views(self.resources)[0]["display"], "Prediabetes")
        self.assertEqual(medication_views(self.resources)[0]["details"], "Take once daily")
        self.assertEqual(appointment_views(self.resources)[0]["display"], "Primary care")
        self.assertEqual(coverage_views(self.resources)[0]["display"], "Example Health Plan")


if __name__ == "__main__":
    unittest.main()
