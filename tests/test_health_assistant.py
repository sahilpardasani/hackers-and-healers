import json
import tempfile
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch, MagicMock
from cryptography.fernet import Fernet
import app as service
import health_assistant as ha
from sample_data import SAMPLE_NAMESPACE, sample_resources


class HealthAssistantTests(unittest.TestCase):
    def setUp(self):
        directory = tempfile.TemporaryDirectory()
        self.addCleanup(directory.cleanup)
        for p in [patch.object(service.storage, 'DB_PATH', Path(directory.name) / 'test.sqlite3'),
                  patch.dict(service.os.environ, {'DATA_ENCRYPTION_KEY': Fernet.generate_key().decode(), 'NVIDIA_API_KEY': 'test-key'})]:
            p.start(); self.addCleanup(p.stop)
        service.storage.save_resources(sample_resources(), namespace=SAMPLE_NAMESPACE)
        self.client = service.app.test_client()

    def preview(self):
        r = self.client.post('/api/health/context', json={'source': 'sample'})
        self.assertEqual(r.status_code, 200)
        return r.get_json()

    def payload(self):
        return {'source': 'sample', 'question': 'Explain my results', 'consent_nvidia': True,
                'preview_token': self.preview()['preview_token']}

    def test_preview_is_local_and_excludes_direct_identifiers(self):
        with patch.object(ha, '_complete') as llm, patch.object(ha.ct, 'find_trials') as trials:
            data = self.preview()
            text = json.dumps(data['context'])
            for private in ['Maya', 'maya-demo-001', '1994-03-14', 'test-key', 'access_token']:
                self.assertNotIn(private, text)
            self.assertTrue(data['context']['recent_observations'])
            llm.assert_not_called(); trials.assert_not_called()

    def test_both_consents_enforced_before_network(self):
        body = self.payload()
        with patch.object(ha, '_complete') as llm, patch.object(ha.ct, 'find_trials') as trials:
            self.assertEqual(self.client.post('/api/health/ask', json={**body, 'consent_nvidia': False}).status_code, 400)
            self.assertEqual(self.client.post('/api/health/ask', json={**body, 'include_trials': True}).status_code, 400)
            llm.assert_not_called(); trials.assert_not_called()

    def test_changed_context_requires_new_preview(self):
        body = self.payload()
        with patch.object(ha, '_context', return_value={'changed': True}), patch.object(ha, '_complete') as llm:
            self.assertEqual(self.client.post('/api/health/ask', json=body).status_code, 409)
            llm.assert_not_called()

    def test_provider_errors_never_leak_details(self):
        body = self.payload()
        with patch.object(ha, '_complete', side_effect=ValueError('PRIVATE PROVIDER CONTENT')):
            r = self.client.post('/api/health/ask', json=body)
            self.assertEqual(r.status_code, 502)
            self.assertNotIn('PRIVATE', r.get_data(as_text=True))
        with patch.dict(service.os.environ, {'NVIDIA_API_KEY': ''}):
            self.assertEqual(self.client.post('/api/health/ask', json=body).status_code, 503)

    def test_trial_failure_does_not_fabricate_trials(self):
        body = {**self.payload(), 'include_trials': True, 'consent_trials': True}
        with patch.object(ha.ct, 'find_trials', side_effect=ha.ct.requests.Timeout), patch.object(ha, '_complete', return_value=('Explanation', [])) as llm:
            r = self.client.post('/api/health/ask', json=body)
            self.assertEqual(r.status_code, 200)
            self.assertEqual(r.get_json()['trials'], [])
            self.assertTrue(r.get_json()['warnings'])
            self.assertEqual(llm.call_args.args[2], [])

    def test_success_is_private_and_does_not_persist_transcript(self):
        before = service.storage.record_counts(SAMPLE_NAMESPACE)
        with patch.object(ha, '_complete', return_value=('An explanation, not a diagnosis.', [])):
            r = self.client.post('/api/health/ask', json=self.payload())
            self.assertEqual(r.status_code, 200)
            self.assertEqual(r.headers['Cache-Control'], 'no-store')
        self.assertEqual(before, service.storage.record_counts(SAMPLE_NAMESPACE))

    def test_untrusted_origins_and_oversized_questions_rejected(self):
        self.assertEqual(self.client.post('/api/health/context', json={}, headers={'Origin': 'https://evil.example'}).status_code, 403)
        self.assertEqual(self.client.post('/api/health/ask', json={**self.payload(), 'question': 'x' * 1201}).status_code, 400)

    def test_nvidia_transport_and_hallucination_rejection(self):
        mock_client = MagicMock()
        completion = SimpleNamespace(choices=[SimpleNamespace(finish_reason='stop', message=SimpleNamespace(content=json.dumps({'answer': 'See NCT99999999', 'recommended_trial_ids': ['NCT99999999']})))])
        mock_client.__enter__.return_value.chat.completions.create.return_value = completion
        with patch.object(ha, 'OpenAI', return_value=mock_client) as factory:
            with self.assertRaises(ValueError): ha._complete({'profile': {}}, 'Explain', [])
            self.assertEqual(factory.call_args.kwargs['base_url'], 'https://integrate.api.nvidia.com/v1')
            sent = mock_client.__enter__.return_value.chat.completions.create.call_args.kwargs
            self.assertEqual(sent['model'], 'z-ai/glm-5.3')
            self.assertNotIn('test-key', json.dumps(sent))
            self.assertFalse(sent['stream'])
            self.assertEqual(sent['reasoning_effort'], 'low')
            self.assertEqual(sent['max_tokens'], 4096)

    def test_verified_trial_cards_use_retrieved_ids(self):
        trial = {'nct_id': 'NCT12345678', 'title': 'Fictional test study', 'status': 'RECRUITING',
                 'conditions': ['Prediabetes'], 'summary': 'Test fixture', 'match': {}, 'eligibility': {}}
        body = {**self.payload(), 'include_trials': True, 'consent_trials': True}
        with patch.object(ha.ct, 'find_trials', return_value=[trial]), patch.object(ha, '_complete', return_value=('Discuss this with the study team.', ['NCT12345678'])):
            r = self.client.post('/api/health/ask', json=body)
            self.assertEqual(r.status_code, 200)
            self.assertEqual(r.get_json()['trials'][0]['url'], 'https://clinicaltrials.gov/study/NCT12345678')

    def test_invalid_source_and_truncated_model_output_rejected(self):
        self.assertEqual(self.client.post('/api/health/context', json={'source': []}).status_code, 400)
        mock_client = MagicMock()
        mock_client.__enter__.return_value.chat.completions.create.return_value = SimpleNamespace(
            choices=[SimpleNamespace(finish_reason='length', message=SimpleNamespace(content='partial'))])
        with patch.object(ha, 'OpenAI', return_value=mock_client):
            with self.assertRaises(ValueError):
                ha._complete({}, 'Explain', [])

    def test_provider_failure_preserves_trials_as_search_only(self):
        trial = {'nct_id': 'NCT12345678', 'title': 'Fictional test study', 'status': 'RECRUITING',
                 'conditions': [], 'summary': '', 'match': {}, 'eligibility': {}}
        body = {**self.payload(), 'include_trials': True, 'consent_trials': True}
        with patch.object(ha.ct, 'find_trials', return_value=[trial]), patch.object(ha, '_complete', side_effect=ValueError('PRIVATE')):
            r = self.client.post('/api/health/ask', json=body)
            self.assertEqual(r.status_code, 200)
            data = r.get_json()
            self.assertFalse(data['explanation_available'])
            self.assertIn('not AI recommendations', data['answer'])
            self.assertEqual(data['trials'][0]['nct_id'], trial['nct_id'])
            self.assertNotIn('PRIVATE', r.get_data(as_text=True))


if __name__ == '__main__':
    unittest.main()
