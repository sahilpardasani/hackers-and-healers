import unittest
from scripts.export_camila_sandbox import make_bundle, SANDBOX, TEST_PATIENT


class SandboxExportTests(unittest.TestCase):
    def setUp(self):
        self.connection = {'fhir_base_url': SANDBOX, 'patient_id': TEST_PATIENT}
        self.patient = {'resourceType': 'Patient', 'id': TEST_PATIENT, 'name': [{'family': 'REMOVE'}],
                        'identifier': [{'value': 'REMOVE'}], 'telecom': [{'value': 'REMOVE'}], 'gender': 'female'}

    def test_only_known_sandbox_patient_allowed(self):
        for c in [{**self.connection, 'fhir_base_url': 'https://hospital.example/FHIR/R4'},
                  {**self.connection, 'patient_id': 'somebody-else'}]:
            with self.assertRaises(ValueError): make_bundle(c, [self.patient])

    def test_removes_identifiers_and_other_patients(self):
        obs = {'resourceType': 'Observation', 'id': 'original', 'subject': {'reference': 'Patient/' + TEST_PATIENT},
               'code': {'text': 'A1c'}, 'valueQuantity': {'value': 5.9, 'unit': '%'}, 'note': [{'text': 'REMOVE'}]}
        other = {**obs, 'id': 'other', 'subject': {'reference': 'Patient/other'}}
        b = make_bundle(self.connection, [self.patient, obs, other, {'resourceType': 'OperationOutcome'}])
        self.assertEqual(len(b['entry']), 2)
        self.assertNotIn('REMOVE', str(b))
        self.assertNotIn(TEST_PATIENT, str(b))
        self.assertEqual(b['entry'][1]['resource']['subject']['reference'], 'Patient/camila-sandbox-001')
        self.assertEqual(obs['id'], 'original')

    def test_appointment_keeps_only_test_patient_participant(self):
        apt = {'resourceType': 'Appointment', 'id': 'apt', 'status': 'booked', 'participant': [
            {'actor': {'reference': 'Patient/' + TEST_PATIENT, 'display': 'REMOVE'}, 'status': 'accepted'},
            {'actor': {'reference': 'Practitioner/doctor', 'display': 'REMOVE'}, 'status': 'accepted'}]}
        out = make_bundle(self.connection, [self.patient, apt])['entry'][1]['resource']
        self.assertEqual(len(out['participant']), 1)
        self.assertNotIn('REMOVE', str(out))
