from __future__ import annotations

import contextlib
import io
import json
import unittest

from jouzu import __version__
from jouzu.__main__ import main


class JouzuCliTests(unittest.TestCase):
    def test_version_metadata(self) -> None:
        self.assertEqual(__version__, "0.0.1")

    def test_doctor_reports_reservation_status(self) -> None:
        output = io.StringIO()
        with contextlib.redirect_stdout(output):
            result = main(["doctor"])
        self.assertEqual(result, 0)
        self.assertEqual(json.loads(output.getvalue())["status"], "package-name-reservation")


if __name__ == "__main__":
    unittest.main()
