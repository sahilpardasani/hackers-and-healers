import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from cryptography.fernet import Fernet

import app as service
from sample_data import SAMPLE_NAMESPACE


class SampleDataTests(unittest.TestCase):
    def test_sample_import_is_idempotent_isolated_and_visible(self):
        with tempfile.TemporaryDirectory() as directory, \
                patch.object(service.storage, "DB_PATH", Path(directory) / "test.sqlite3"), \
                patch.dict(service.os.environ, {"DATA_ENCRYPTION_KEY": Fernet.generate_key().decode()}), \
                patch.object(service.requests, "get") as network_get, \
                patch.object(service.requests, "post") as network_post:
            existing = {"fhir_base_url": "https://example.test/FHIR/R4", "patient_id": "other", "access_token": "test-token"}
            service.storage.save_connection(existing)
            service.storage.save_resources([{"resourceType": "Patient", "id": "other", "name": [{"text": "Other Patient"}]}], namespace=existing["fhir_base_url"])
            client = service.app.test_client()
            for _ in range(2):
                response = client.post("/sample/load", follow_redirects=True)
                self.assertEqual(response.status_code, 200)
                self.assertIn(b"Maya Demo", response.data)
                self.assertIn(b"Sample records loaded", response.data)
                self.assertNotIn(b"Other Patient", response.data)
                self.assertNotIn(b"Sync now", response.data)
            self.assertEqual(service.storage.record_counts(SAMPLE_NAMESPACE), {"Patient": 1, "Observation": 8, "Condition": 2, "MedicationRequest": 3})
            self.assertEqual(service.storage.load_connection()[0], existing)
            bundle = client.get("/sample.json").get_json()
            self.assertEqual(len(bundle["entry"]), 14)
            self.assertEqual(bundle["meta"]["tag"][0]["code"], "synthetic")
            normal_page = client.get("/").data
            self.assertIn(b"Other Patient", normal_page)
            self.assertNotIn(b"Maya Demo", normal_page)
            network_get.assert_not_called()
            network_post.assert_not_called()


if __name__ == "__main__":
    unittest.main()
