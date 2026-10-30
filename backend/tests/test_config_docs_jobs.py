"""Every docs job setting is also declared on the app's Settings, whose .env forbids unknown keys."""
import unittest

from app.config import Settings
from app.services.docs_jobs import DocsJobsSettings


class DocsJobsSettingsDeclaredTests(unittest.TestCase):
    def test_every_job_setting_is_declared_on_the_app_settings(self):
        missing = [n for n in DocsJobsSettings.model_fields if n not in Settings.model_fields]
        self.assertEqual(missing, [], "add these to app/config.Settings, or the API won't start with them in .env")

    def test_same_defaults(self):
        for name, field in DocsJobsSettings.model_fields.items():
            self.assertEqual(Settings.model_fields[name].default, field.default, name)
