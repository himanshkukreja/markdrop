"""Teams: anyone in the workspace joins an OPEN team themselves (Browse teams › Join); private teams and adding
other people stay with leads and admins (services/teams.add_members)."""

from __future__ import annotations

from tests.test_teams import TeamsWorld


class Join(TeamsWorld):
    async def test_self_join_open_team_only(self):
        eng, sales = f"{self.base}/teams/{self.eng}", f"{self.base}/teams/{self.sales}"
        # wm isn't in Eng (open): joins it.
        r = await self.http.post(f"{eng}/members", headers=self.session("wm"), json={"user_ids": [self.uid["wm"]]})
        self.assertEqual(r.status_code, 200, r.text)
        self.assertIn(self.uid["wm"], [m["id"] for m in r.json()["members"]])
        # …but can't add someone else to it.
        r = await self.http.post(f"{eng}/members", headers=self.session("wm"), json={"user_ids": [self.uid["wa"]]})
        self.assertEqual(r.status_code, 403)
        r = await self.http.post(f"{eng}/members", headers=self.session("wm"), json={"user_ids": [self.uid["wm"], self.uid["wa"]]})
        self.assertEqual(r.status_code, 403)
        # A private team: no self-join.
        r = await self.http.post(f"{sales}/members", headers=self.session("wv"), json={"user_ids": [self.uid["wv"]]})
        self.assertIn(r.status_code, (403, 404))   # an outsider doesn't learn more than its card
