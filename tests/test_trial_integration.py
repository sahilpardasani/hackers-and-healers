import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch
from cryptography.fernet import Fernet
import app as service
import clinicaltrial as ct
from sample_data import SAMPLE_NAMESPACE, sample_resources


class TrialIntegrationTests(unittest.TestCase):
    def setUp(self):
        temp = tempfile.TemporaryDirectory()
        self.addCleanup(temp.cleanup)
        for p in (patch.object(service.storage, 'DB_PATH', Path(temp.name) / 'test.sqlite3'),
                  patch.dict(service.os.environ, {'DATA_ENCRYPTION_KEY': Fernet.generate_key().decode()})):
            p.start(); self.addCleanup(p.stop)
        self.client = service.app.test_client()

    def test_profile_never_mixes_sample_other_server_or_other_patient(self):
        service.storage.save_resources(sample_resources(), namespace=SAMPLE_NAMESPACE)
        service.storage.save_connection({'fhir_base_url': 'https://ehr.test/R4', 'patient_id': 'active'})
        service.storage.save_resources([
            {'resourceType': 'Patient', 'id': 'active', 'gender': 'male'},
            {'resourceType': 'Patient', 'id': 'previous', 'gender': 'female'},
            {'resourceType': 'Condition', 'id': 'c1', 'subject': {'reference': 'Patient/active'}, 'code': {'text': 'Hypertension'}},
            {'resourceType': 'Condition', 'id': 'c2', 'subject': {'reference': 'Patient/previous'}, 'code': {'text': 'Other patient diagnosis'}},
        ], namespace='https://ehr.test/R4')
        with patch.object(ct.requests, 'get') as network:
            profile = self.client.get('/api/trials/profile').get_json()['profile']
            sample = self.client.get('/api/trials/profile?source=sample').get_json()['profile']
            network.assert_not_called()
        self.assertEqual(profile['sex'], 'MALE')
        self.assertEqual([c['name'] for c in profile['conditions']], ['Hypertension'])
        self.assertNotEqual(sample['conditions'], profile['conditions'])
        service.storage.clear_connection()
        self.assertEqual(self.client.get('/api/trials/profile').status_code, 404)

    def test_search_requires_consent_and_sample_stays_isolated(self):
        service.storage.save_resources(sample_resources(), namespace=SAMPLE_NAMESPACE)
        with patch.object(ct, 'find_trials', return_value=[]) as find:
            self.assertEqual(self.client.get('/api/trials?source=sample').status_code, 400)
            find.assert_not_called()
            response = self.client.get('/api/trials?source=sample&consent=yes')
            self.assertEqual(response.status_code, 200)
            self.assertEqual(response.headers['Cache-Control'], 'no-store')
            self.assertTrue(find.call_args.args[0]['conditions'])

    def test_units_and_invalid_observations_are_not_used(self):
        resources = [{'resourceType': 'Observation', 'status': 'final',
                      'code': {'coding': [{'code': '4548-4'}]},
                      'valueQuantity': {'value': 53, 'unit': 'mmol/mol'}}]
        self.assertIsNone(ct.patient_profile(resources)['labs']['a1c'])
        resources[0]['valueQuantity'] = {'value': 7, 'unit': '%'}
        resources[0]['status'] = 'entered-in-error'
        self.assertIsNone(ct.patient_profile(resources)['labs']['a1c'])

    def test_api_failure_bad_json_and_geo_are_safe(self):
        self.assertEqual(self.client.post('/api/trials/match', json='invalid').status_code, 400)
        self.assertEqual(self.client.post('/api/trials/match', json={'labs': [] , 'conditions': 'oops'}).status_code, 400)
        with patch.object(ct, 'find_trials', side_effect=ct.requests.Timeout):
            r = self.client.post('/api/trials/match', json={'conditions': ['Hypertension']})
            self.assertEqual(r.status_code, 502)
            self.assertNotIn('Traceback', r.get_data(as_text=True))
        self.assertEqual(self.client.get('/api/trials?consent=yes&lat=abc&lon=1').status_code, 400)
        self.assertEqual(self.client.get('/api/trials?consent=yes&lat=1&lon=1&miles=nan').status_code, 400)

    def test_list_bundle_input_and_tab_redirect(self):
        with patch.object(ct, 'find_trials', return_value=[]):
            r = self.client.post('/api/trials/match', json=[{'resourceType': 'Condition', 'code': {'text': 'Hypertension'}}])
            self.assertEqual(r.status_code, 200)
        self.assertEqual(self.client.get('/trials?source=sample').location, '/sample#trials')

    def test_condition_sync_has_no_incremental_date_filter(self):
        self.assertEqual(service.SYNC_QUERIES['conditions'], ('Condition', {'category': 'problem-list-item'}, None))


if __name__ == '__main__':
    unittest.main()
