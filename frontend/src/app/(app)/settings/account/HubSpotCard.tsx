"use client";

import { useEffect, useState } from "react";
import { Card, useToast } from "@/components/ui";
import { hubspotMe, hubspotSetMe, type HubSpotMe } from "@/lib/hubspot";
import { SwitchRow } from "../settings-shared";

/**
 * Settings › Account › HubSpot (backend services/hubspot_notify.py): your own pre-call briefs and the Slack message
 * after your calls (Log to HubSpot, Create tasks). Shown only to members of a workspace's HubSpot team; both are
 * on until you turn them off here (or with Stop these on the message).
 */
export function HubSpotCard() {
  const toast = useToast();
  const [me, setMe] = useState<HubSpotMe | null>(null);
  const [busy, setBusy] = useState<"" | "precall" | "approve">("");

  useEffect(() => { hubspotMe().then(setMe, () => setMe(null)); }, []);
  if (!me || me.teams.length === 0) return null;

  const save = async (key: "precall" | "approve", on: boolean) => {
    setBusy(key);
    try {
      setMe(await hubspotSetMe({ [key]: on }));
      toast.success(on ? "Turned on." : "Turned off.");
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "That didn't save.");
    } finally { setBusy(""); }
  };
  const teams = me.teams.map((t) => `${t.team}${t.workspace ? ` (${t.workspace})` : ""}`).join(", ");

  return (
    <Card title="HubSpot" id="hubspot" description={`You're in the HubSpot team: ${teams}.`}>
      <div className="flex flex-col gap-3" data-testid="hubspot-me">
        <SwitchRow id="hubspot-precall" label="Pre-call briefs" checked={me.precall} disabled={busy === "precall"}
          hint="Before your HubSpot meetings: the deal, the last call and what was promised, in Slack and your Markdrop inbox."
          onChange={(on) => void save("precall", on)} />
        <SwitchRow id="hubspot-approve" label="Slack message after your calls" checked={me.approve} disabled={busy === "approve"}
          hint="When your call's summary is ready: Log to HubSpot and Create tasks, right in Slack."
          onChange={(on) => void save("approve", on)} />
      </div>
    </Card>
  );
}
