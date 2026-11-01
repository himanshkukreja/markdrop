"use client";

import { useEffect, useId, useState } from "react";
import { Alert, Field, IconButton, Input, Meter, Switch, Tag } from "@/components/ui";
import { ReadMore } from "@/components/ReadMore";
import { num } from "../format";
import { useSite } from "../SiteContext";
import { LockedNote, SectionHeader, SettingsCard } from "./SettingsShell";
import { SECTIONS } from "./sections";
import usePatch from "./usePatch";

const MAX_SUGGESTIONS = 5;

/** Settings › Ask AI: on or off, this month's answers, the name readers see, suggested questions. */
export default function AskAiSection() {
  const { site } = useSite();
  const { patch, saving, error, setError, locked } = usePatch();
  const uid = useId();
  const s = site.settings;
  const [aiName, setAiName] = useState(s.ai.name ?? "");
  const [suggestion, setSuggestion] = useState("");
  useEffect(() => { setAiName(s.ai.name ?? ""); }, [s.ai.name]);

  const suggestions = s.ai.suggestions ?? [];
  const addSuggestion = () => {
    const q = suggestion.trim();
    // One change at a time: each sends the whole list, so a second one built on the same list would undo the first.
    if (!q || saving === "ai" || suggestions.length >= MAX_SUGGESTIONS || suggestions.includes(q)) return;
    void patch("ai", { settings: { ai: { suggestions: [...suggestions, q] } } }, "Suggested question added.").then((ok) => ok && setSuggestion(""));
  };
  const aiUsed = site.counts?.ai_answers_this_month ?? site.ai_used ?? 0;
  const aiLimit = site.limits?.ai_answers_per_month ?? 1000;

  return (
    <>
      <SectionHeader title="Ask AI" description={SECTIONS.find((s) => s.id === "ask-ai")?.blurb} />
      <LockedNote />
      {error && <Alert tone="danger" onDismiss={() => setError("")}>{error}</Alert>}

      <SettingsCard
        id="ai"
        title="Ask AI on your guide"
        description={<>Answers come from your published pages, with a link to the exact section each part came from. <ReadMore topic="studioAskAi" /></>}
        aside={<Switch aria-label="Ask AI" label={s.ai.enabled ? "On" : "Off"} checked={s.ai.enabled} disabled={locked || saving === "ai"} onChange={(e) => void patch("ai", { settings: { ai: { enabled: e.target.checked } } }, e.target.checked ? "Ask AI is on." : "Ask AI is off.")} />}
      >
        <Meter size="sm" value={aiUsed} max={aiLimit} threshold={0.9} label={`This month: ${num(aiUsed)} of ${num(aiLimit)} answers`} valueText={`${aiUsed} of ${aiLimit} answers`} />
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          <Field label="Name readers see" htmlFor={`${uid}-ainame`}>
            <Input
              value={aiName}
              maxLength={40}
              disabled={locked}
              placeholder="Ask AI"
              onChange={(e) => setAiName(e.target.value)}
              onKeyDown={(e) => { if (e.key === "Enter") e.currentTarget.blur(); }}
              onBlur={() => { if (aiName.trim() !== (s.ai.name ?? "")) void patch("ai", { settings: { ai: { name: aiName.trim() || null } } }, "Name saved."); }}
            />
          </Field>
          <Field label="Suggested questions" htmlFor={`${uid}-sugg`} hint={suggestions.length >= MAX_SUGGESTIONS ? "Up to 5. Remove one to add another." : "Shown before someone types. Up to 5. Press Enter to add."}>
            <Input
              value={suggestion}
              maxLength={120}
              disabled={locked || suggestions.length >= MAX_SUGGESTIONS}
              placeholder="e.g. How do I reset my password?"
              onChange={(e) => setSuggestion(e.target.value)}
              onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); addSuggestion(); } }}
              suffix={suggestion.trim() ? <IconButton icon="plus" label="Add question" size="sm" onClick={addSuggestion} /> : undefined}
            />
          </Field>
        </div>
        {suggestions.length > 0 && (
          <ul className="ph-no-capture flex flex-wrap gap-2" aria-label="Suggested questions">
            {suggestions.map((q) => (
              <li key={q}>
                <Tag removeLabel={`Remove "${q}"`} onRemove={locked ? undefined : () => saving !== "ai" && void patch("ai", { settings: { ai: { suggestions: suggestions.filter((x) => x !== q) } } }, "Suggested question removed.")}>{q}</Tag>
              </li>
            ))}
          </ul>
        )}
        <p className="text-[13px] text-text-muted">At the limit, readers get links to ask Claude or ChatGPT with the page attached instead.</p>
      </SettingsCard>
    </>
  );
}
