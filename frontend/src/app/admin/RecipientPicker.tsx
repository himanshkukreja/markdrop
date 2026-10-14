"use client";

import { useEffect, useState } from "react";
import { Combobox, type ComboboxSuggestion } from "@/components/kit/Combobox";
import { adminListUsers } from "@/lib/api";

/**
 * Address field with type-ahead over real accounts, chosen addresses held as tags (the kit
 * Combobox: ARIA combobox + listbox, Backspace removes the last tag, Escape closes the list).
 *
 * The previous free-text textarea made a typo silently become "nobody" — the address just fails to
 * match a user and is dropped from the audience. Picking from the account list makes the common
 * case unmissable, while still allowing a typed address for anyone not yet in the suggestions.
 */
export default function RecipientPicker({
  token,
  value,
  onChange,
}: {
  token: string;
  value: string[];
  onChange: (emails: string[]) => void;
}) {
  const [query, setQuery] = useState("");
  const [suggestions, setSuggestions] = useState<ComboboxSuggestion[]>([]);

  // One character is too little to be useful and floods the endpoint; two is where a suggestion
  // starts to mean something. Debounced 220ms.
  useEffect(() => {
    const q = query.trim();
    if (q.length < 2) {
      setSuggestions([]);
      return;
    }
    let cancelled = false;
    const t = setTimeout(async () => {
      try {
        const r = await adminListUsers(token, 1, q);
        if (!cancelled) {
          setSuggestions(r.users.map((u) => ({
            email: u.email,
            name: u.name ?? undefined,
            role: `${u.document_count} doc${u.document_count === 1 ? "" : "s"}`,
          })));
        }
      } catch {
        /* suggestions are a convenience, not a requirement */
      }
    }, 220);
    return () => {
      cancelled = true;
      clearTimeout(t);
    };
  }, [query, token]);

  return (
    <Combobox
      label="Recipients"
      placeholder="Start typing a name or email"
      tags={value}
      onTagsChange={(tags) => onChange(Array.from(new Set(tags.map((e) => e.trim().toLowerCase()))))}
      suggestions={suggestions}
      onQueryChange={setQuery}
      hint="Pick from your accounts, or type a full address and press Enter. Anyone who has unsubscribed is skipped even if listed here."
    />
  );
}
