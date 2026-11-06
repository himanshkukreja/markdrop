"use client";

/**
 * Home's "turn on notifications" card (feat/push-prompts): one tap runs the same flow as Settings ›
 * Account › Notifications on your devices; "Not now" hides it for good on this device. Shown in the
 * installed app and in a browser tab alike, only where a click can turn push on (usePushPrompt).
 * Phones: the buttons share a row under the text; wider: beside it. 44 px targets on touch.
 */
import { useId } from "react";
import { Button, Icon } from "@/components/ui";
import { usePushPrompt } from "./usePushPrompt";
import "./pushPrompt.css";

export function PushPromptCard() {
  const { show, busy, turnOn, dismiss } = usePushPrompt("home");
  const titleId = useId();
  if (!show) return null;
  return (
    <section className="md-pushcard" aria-labelledby={titleId} data-testid="push-prompt-home">
      <span className="md-pushcard__icon" aria-hidden><Icon name="bell" size={18} /></span>
      <div className="md-pushcard__text">
        <h2 id={titleId} className="md-pushcard__title">Get notified when someone mentions you or needs your sign-off</h2>
        <p className="md-pushcard__desc">On this device, even when Markdrop is closed. Your browser asks you once.</p>
      </div>
      <div className="md-pushcard__actions">
        <Button variant="primary" iconLeft="bell" loading={busy} onClick={() => void turnOn()}>Turn on</Button>
        <Button variant="ghost" disabled={busy} onClick={dismiss}>Not now</Button>
      </div>
    </section>
  );
}

export default PushPromptCard;
