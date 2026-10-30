"""Zipped sites (services/bundle.py): what is skipped doesn't count towards the caps."""

from __future__ import annotations

import unittest
import zipfile
from io import BytesIO
from unittest import mock

from app.services import bundle


def make_zip(entries: dict[str, bytes], *, compression=zipfile.ZIP_DEFLATED) -> bytes:
    buf = BytesIO()
    with zipfile.ZipFile(buf, "w", compression) as zf:
        for name, data in entries.items():
            zf.writestr(name, data)
    return buf.getvalue()


class Skipping(unittest.TestCase):
    def test_hidden_macos_and_unsupported_entries_are_dropped(self):
        entry, files = bundle.extract(make_zip({
            "site/index.html": b"<h1>hi</h1>",
            "site/app.js": b"1",
            "site/.DS_Store": b"x",
            "site/.git/config": b"x",
            "site/.git/objects/ab/cdef": b"x",
            "__MACOSX/site/._index.html": b"x",
            "site/notes.docx": b"x",
            "site/Makefile": b"x",
        }))
        self.assertEqual(entry, "index.html")
        # The single wrapping folder is stripped once the skipped entries are gone.
        self.assertEqual(sorted(p for p, _, _ in files), ["app.js", "index.html"])
        self.assertEqual(dict((p, m) for p, _, m in files)["app.js"], "text/javascript")

    def test_skipped_entries_dont_count_towards_the_file_limit(self):
        entries = {"index.html": b"<p>ok</p>"}
        entries.update({f".git/objects/{i:04d}": b"x" for i in range(bundle.MAX_ENTRIES + 50)})
        entries.update({f"__MACOSX/._{i}": b"x" for i in range(20)})
        entries.update({f"raw/{i}.bin": b"x" for i in range(20)})
        entry, files = bundle.extract(make_zip(entries, compression=zipfile.ZIP_STORED))
        self.assertEqual((entry, [p for p, _, _ in files]), ("index.html", ["index.html"]))

    def test_too_many_served_files_is_still_refused(self):
        entries = {"index.html": b"<p>ok</p>"}
        entries.update({f"img/{i}.png": b"x" for i in range(bundle.MAX_ENTRIES)})
        with self.assertRaisesRegex(bundle.BundleError, "too many files"):
            bundle.extract(make_zip(entries, compression=zipfile.ZIP_STORED))

    def test_skipped_entries_dont_count_towards_the_size_limits(self):
        big = b"\0" * (2 * 1024 * 1024)
        with mock.patch.object(bundle, "MAX_ENTRY_BYTES", 1024 * 1024), \
                mock.patch.object(bundle, "MAX_TOTAL_UNCOMPRESSED", 3 * 1024 * 1024):
            entry, files = bundle.extract(make_zip({
                "index.html": b"<p>ok</p>",
                "movie.mov": big,               # unsupported, over the per-file cap
                ".cache/blob.png": big,         # hidden, over the per-file cap
                "__MACOSX/._movie.mov": big,
            }))
            self.assertEqual([p for p, _, _ in files], ["index.html"])
            # A served file over the per-file cap is refused, as before.
            with self.assertRaisesRegex(bundle.BundleError, "larger than 1 MB"):
                bundle.extract(make_zip({"index.html": b"<p>ok</p>", "hero.png": big}))
            # And so is a site whose served files add up to more than the total.
            with self.assertRaisesRegex(bundle.BundleError, "expands to"):
                bundle.extract(make_zip({"index.html": b"<p>ok</p>",
                                         **{f"{i}.png": b"\0" * 900_000 for i in range(4)}}))

    def test_unsafe_paths_and_only_skipped_files(self):
        _, files = bundle.extract(make_zip({"index.html": b"ok", "../evil.html": b"x", "/abs.html": b"x"}))
        self.assertEqual(sorted(p for p, _, _ in files), ["abs.html", "index.html"])
        with self.assertRaisesRegex(bundle.BundleError, "no usable files"):
            bundle.extract(make_zip({".hidden.html": b"x", "__MACOSX/index.html": b"x", "a.exe": b"x"}))
        with self.assertRaisesRegex(bundle.BundleError, "index.html"):
            bundle.extract(make_zip({"style.css": b"x"}))


if __name__ == "__main__":
    unittest.main()
