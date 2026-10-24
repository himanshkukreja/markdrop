"""Signalling room lifecycle: a dropped sender's room is held, a stopped sender's is not.

Runs the real websocket route in-process. TURN lookup is stubbed and no share
metadata is sent, so nothing here reaches a database or Cloudflare.
"""

from __future__ import annotations

import unittest
from unittest import mock

from tests import _email_env as env  # noqa: F401  (pins settings first)

from starlette.testclient import TestClient

from app.main import app
from app.routers import share
from app.services import turn

HK = "a" * 32


async def _stun():
    return [{"urls": ["stun:stun.l.google.com:19302"]}]


class RoomLifecycle(unittest.TestCase):
    def setUp(self):
        share._rooms.clear()
        self.turn = mock.patch.object(turn, "get_ice_servers", _stun)
        self.turn.start()
        self.client = TestClient(app)

    def tearDown(self):
        self.turn.stop()
        share._rooms.clear()

    def host(self, room: str):
        ws = self.client.websocket_connect(f"/ws/share/{room}?role=host&v=2&hk={HK}")
        conn = ws.__enter__()
        self.assertEqual(conn.receive_json()["type"], "config")
        return ws, conn

    def test_dropped_sender_is_held(self):
        ws, _ = self.host("dropped001")
        ws.__exit__(None, None, None)
        snap = share.room_snapshot("dropped001")
        self.assertIsNotNone(snap)
        self.assertTrue(snap["held"])
        self.assertFalse(snap["host_online"])

    def test_stopped_sender_releases_the_room(self):
        ws, conn = self.host("stopped001")
        with self.client.websocket_connect("/ws/share/stopped001?role=guest") as guest:
            self.assertEqual(guest.receive_json()["type"], "config")
            self.assertEqual(conn.receive_json()["type"], "guest-joined")
            conn.send_json({"type": "bye"})
            self.assertEqual(guest.receive_json()["type"], "room-closed")
        ws.__exit__(None, None, None)
        self.assertIsNone(share.room_snapshot("stopped001"))
        with self.client.websocket_connect("/ws/share/stopped001?role=guest") as late:
            self.assertEqual(late.receive_json()["type"], "no-host")


if __name__ == "__main__":
    unittest.main()
