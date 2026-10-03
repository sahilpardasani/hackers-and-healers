import re
import unittest
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
TEMPLATE = (ROOT / "templates" / "index.html").read_text()
STYLES = (ROOT / "static" / "styles.css").read_text()
SCRIPT = (ROOT / "static" / "app.js").read_text()


class FrontendContractTests(unittest.TestCase):
    def test_onboarding_keeps_explicit_consent_gate(self):
        self.assertIn('id="consent"', TEMPLATE)
        self.assertIn("I understand Patient Agency doesn’t provide medical advice.", TEMPLATE)
        self.assertIn('id="connect-button"', TEMPLATE)
        self.assertIn('disabled', TEMPLATE)

    def test_tabs_have_accessible_tabpanel_contract(self):
        targets = re.findall(r'data-tab-target="([^"]+)"', TEMPLATE)
        self.assertEqual(targets, ["today", "journey", "progress", "visit", "my-data"])
        for target in targets:
            self.assertIn(f'aria-controls="panel-{target}"', TEMPLATE)
            self.assertIn(f'aria-labelledby="tab-{target}"', TEMPLATE)
            self.assertIn(f'data-tab-panel="{target}"', TEMPLATE)
        self.assertIn('role="tablist"', TEMPLATE)
        self.assertIn('role="tabpanel"', TEMPLATE)

    def test_demo_preview_is_keyboard_addressable(self):
        self.assertIn('role="dialog"', TEMPLATE)
        self.assertIn('aria-modal="true"', TEMPLATE)
        self.assertIn('data-close-demo', TEMPLATE)
        self.assertIn("event.key === 'Escape'", SCRIPT)
        self.assertIn("lastFocused?.focus()", SCRIPT)

    def test_local_checkins_and_notes_restore(self):
        self.assertIn("patient-agency.logs.v1", SCRIPT)
        self.assertIn("patient-agency.answers.v1", SCRIPT)
        self.assertIn("patient-agency.visit-notes.v1", SCRIPT)
        self.assertIn("aria-pressed", SCRIPT)
        self.assertIn("addEventListener('input'", SCRIPT)

    def test_responsive_focus_and_reduced_motion_styles_exist(self):
        self.assertIn(":focus-visible", STYLES)
        self.assertIn("@media(max-width:700px)", STYLES)
        self.assertIn("prefers-reduced-motion", STYLES)
        self.assertIn(".skip-link", STYLES)


if __name__ == "__main__":
    unittest.main()
