"""ffprobe metadata and ffmpeg posters (services/media.py).

The probe and poster tests run the real binaries against a tiny MP4 made with
ffmpeg's lavfi test source, and are skipped when ffmpeg isn't installed. The
rest is pure parsing, or media.process against FakeR2 with the binaries mocked.
"""

from __future__ import annotations

import io
import os
import shutil
import subprocess
import tempfile
import unittest
from unittest import mock

from tests._files_env import FilesTestCase, settings

from app.services import media

FFMPEG = shutil.which("ffmpeg") or ("/opt/homebrew/bin/ffmpeg" if os.path.exists("/opt/homebrew/bin/ffmpeg") else None)
FFPROBE = shutil.which("ffprobe") or ("/opt/homebrew/bin/ffprobe" if os.path.exists("/opt/homebrew/bin/ffprobe") else None)


class Parse(unittest.TestCase):
    def test_video_and_audio(self):
        data = {
            "format": {"duration": "83.250000"},
            "streams": [
                {"codec_type": "video", "codec_name": "hevc", "width": 3840, "height": 2160},
                {"codec_type": "audio", "codec_name": "aac"},
            ],
        }
        self.assertEqual(media.parse_probe(data), {"duration_s": 83.25, "width": 3840, "height": 2160,
                                                   "video_codec": "hevc", "audio_codec": "aac"})

    def test_portrait_phone_video_reports_display_size(self):
        for stream_extra in ({"side_data_list": [{"side_data_type": "Display Matrix", "rotation": -90}]},
                             {"tags": {"rotate": "90"}}):
            data = {"format": {"duration": "3"}, "streams": [
                {"codec_type": "video", "codec_name": "h264", "width": 1920, "height": 1080, **stream_extra}]}
            m = media.parse_probe(data)
            self.assertEqual((m["width"], m["height"]), (1080, 1920))

    def test_audio_with_cover_art(self):
        data = {"format": {"duration": "200.5"}, "streams": [
            {"codec_type": "audio", "codec_name": "mp3"},
            {"codec_type": "video", "codec_name": "mjpeg", "width": 500, "height": 500,
             "disposition": {"attached_pic": 1}},
        ]}
        self.assertEqual(media.parse_probe(data), {"duration_s": 200.5, "width": None, "height": None,
                                                   "video_codec": None, "audio_codec": "mp3"})

    def test_nothing_playable(self):
        self.assertIsNone(media.parse_probe({"format": {}, "streams": [{"codec_type": "data"}]}))
        self.assertIsNone(media.parse_probe({}))
        self.assertIsNone(media.parse_probe("nope"))  # type: ignore[arg-type]
        m = media.parse_probe({"format": {"duration": "N/A"}, "streams": [
            {"codec_type": "audio", "codec_name": "opus", "duration": "4.5"}]})
        self.assertEqual(m["duration_s"], 4.5)

    def test_poster_time(self):
        self.assertEqual(media.poster_time(None), 0.0)
        self.assertEqual(media.poster_time(120), 1.0)
        self.assertEqual(media.poster_time(4), 0.4)

    def test_poster_key_is_beside_the_video(self):
        key = media.poster_key_for("art/u123/abcdef.mp4")
        self.assertTrue(key.startswith("art/u123/") and key.endswith(".poster.jpg"))
        self.assertNotIn("abcdef", key)


@unittest.skipUnless(FFMPEG and FFPROBE, "ffmpeg/ffprobe not installed")
class RealBinaries(unittest.IsolatedAsyncioTestCase):
    @classmethod
    def setUpClass(cls):
        cls.tmp = tempfile.mkdtemp(prefix="md-media-")
        cls.mp4 = os.path.join(cls.tmp, "x.mp4")
        subprocess.run([FFMPEG, "-v", "error", "-y", "-f", "lavfi", "-i", "testsrc=size=640x360:rate=30",
                        "-f", "lavfi", "-i", "sine=frequency=440:sample_rate=44100", "-t", "2",
                        "-pix_fmt", "yuv420p", "-c:v", "libx264", "-c:a", "aac", "-shortest", cls.mp4],
                       check=True, timeout=60)
        cls.hls = os.path.join(cls.tmp, "evil.mp4")
        with open(cls.hls, "w") as f:  # a playlist pretending to be a video
            f.write("#EXTM3U\n#EXT-X-TARGETDURATION:1\n#EXTINF:1,\nfile:///etc/passwd\n#EXT-X-ENDLIST\n")

    @classmethod
    def tearDownClass(cls):
        shutil.rmtree(cls.tmp, ignore_errors=True)

    def setUp(self):
        for p in (mock.patch.object(settings, "ffprobe_path", FFPROBE),
                  mock.patch.object(settings, "ffmpeg_path", FFMPEG)):
            p.start()
            self.addCleanup(p.stop)

    async def test_probe(self):
        m = await media.probe(self.mp4, "video/mp4")
        self.assertEqual((m["width"], m["height"], m["video_codec"], m["audio_codec"]), (640, 360, "h264", "aac"))
        self.assertAlmostEqual(m["duration_s"], 2.0, delta=0.1)

    async def test_poster(self):
        jpg = await media.poster(self.mp4, "video/mp4", 2.0)
        self.assertTrue(jpg and jpg.startswith(b"\xff\xd8"))
        from PIL import Image

        self.assertEqual(Image.open(io.BytesIO(jpg)).size, (640, 360))
        self.assertIsNone(await media.poster(self.mp4, "audio/mpeg", 2.0))

    async def test_probe_and_poster_over_http(self):
        # The production path reads a presigned URL; this serves the file from
        # loopback to exercise the same arguments (protocol whitelist, timeouts).
        import functools
        import http.server
        import threading

        class Quiet(http.server.SimpleHTTPRequestHandler):
            def log_message(self, *args):
                pass

        handler = functools.partial(Quiet, directory=self.tmp)
        server = http.server.ThreadingHTTPServer(("127.0.0.1", 0), handler)
        threading.Thread(target=server.serve_forever, daemon=True).start()
        try:
            url = f"http://127.0.0.1:{server.server_address[1]}/x.mp4?X-Amz-Signature=abc&x=1"
            m = await media.probe(url, "video/mp4")
            self.assertEqual((m["width"], m["height"]), (640, 360))
            jpg = await media.poster(url, "video/mp4", m["duration_s"])
            self.assertTrue(jpg and jpg.startswith(b"\xff\xd8"))
        finally:
            server.shutdown()
            server.server_close()

    async def test_demuxer_is_pinned(self):
        # Probed as an mp4 (-f mov), a playlist is just a broken file: no metadata,
        # no poster, and no attempt to open what it points at.
        self.assertIsNone(await media.probe(self.hls, "video/mp4"))
        self.assertIsNone(await media.poster(self.hls, "video/mp4", 1.0))

    async def test_unknown_type_is_not_probed(self):
        self.assertIsNone(await media.probe(self.mp4, "application/pdf"))


class Missing(unittest.IsolatedAsyncioTestCase):
    async def test_missing_binaries_degrade_to_none(self):
        with mock.patch.object(settings, "ffprobe_path", "/nonexistent/ffprobe"), \
                mock.patch.object(settings, "ffmpeg_path", "/nonexistent/ffmpeg"):
            self.assertIsNone(media.binary("ffprobe"))
            self.assertIsNone(await media.probe("https://r2.example/x.mp4", "video/mp4"))
            self.assertIsNone(await media.poster("https://r2.example/x.mp4", "video/mp4", 3.0))


class Process(FilesTestCase):
    """media.process records what it learns on the version row and the document."""

    M = {"duration_s": 2.0, "width": 640, "height": 360, "video_codec": "h264", "audio_codec": "aac"}

    async def asyncSetUp(self):
        await super().asyncSetUp()
        res = await self.upload(b"video-bytes" * 100, "clip.mp4")
        self.slug = res["slug"]
        self.raw = await self.doc(self.slug)

    async def run_process(self, raw=None):
        raw = raw or self.raw
        with mock.patch.object(media, "probe", mock.AsyncMock(return_value=self.M)), \
                mock.patch.object(media, "poster", mock.AsyncMock(return_value=b"\xff\xd8poster")):
            return await media.process(self.db, str(raw["_id"]), raw["file_version"], raw["blob_key"], raw["mime"])

    async def test_records_media_and_poster(self):
        self.assertEqual(await self.run_process(), self.M)
        raw = await self.doc(self.slug)
        self.assertEqual(raw["media"], self.M)
        self.assertTrue(raw["poster_key"].endswith(".poster.jpg"))
        self.assertTrue(self.r2.objects[raw["poster_key"]]["public"])
        row = (await self.rows(self.slug))[0]
        self.assertEqual((row["media"], row["poster_key"]), (self.M, raw["poster_key"]))
        info = (await self.http.get(f"/api/v1/files/{self.slug}", headers=self.auth)).json()
        self.assertEqual(info["media"], self.M)
        self.assertTrue(info["poster_url"].endswith(raw["poster_key"]))

    async def test_private_video_gets_a_private_poster(self):
        await self.db["documents"].update_one({"slug": self.slug}, {"$set": {"access_level": "private"}})
        await self.run_process()
        raw = await self.doc(self.slug)
        self.assertFalse(self.r2.objects[raw["poster_key"]]["public"])

    async def test_file_replaced_before_the_poster_was_ready(self):
        old = self.raw
        await self.upload(b"newer" * 100, "clip2.mp4", target_slug=self.slug)
        await self.run_process(old)
        raw = await self.doc(self.slug)
        self.assertIsNone(raw.get("media"))  # the document describes the new file
        row = (await self.rows(self.slug))[0]
        self.assertEqual(row["media"], self.M)  # the old version keeps its facts
        self.assertFalse(self.r2.objects[row["poster_key"]]["public"])

    async def test_not_probed_when_nothing_known(self):
        with mock.patch.object(media, "probe", mock.AsyncMock(return_value=None)):
            self.assertIsNone(await media.process(self.db, str(self.raw["_id"]), 1, self.raw["blob_key"], "video/mp4"))
        self.assertIsNone((await self.doc(self.slug)).get("poster_key"))
