"use client";

import { useState } from "react";
import { useToast } from "@/components/ui";
import { docsErrorMessage, updateSite, type SettingsPatch } from "@/lib/docsSites";
import { useSite } from "../SiteContext";

/**
 * Saving a setting from a Settings section: PATCH the guide, take the answer as the site, and say
 * so in a toast (or keep the error for the section's alert). `saving` names what is being saved,
 * so one control can show its own spinner. Admins only: for everyone else it does nothing.
 */
export function usePatch() {
  const { site, setSite, isAdmin } = useSite();
  const toast = useToast();
  const [saving, setSaving] = useState("");
  const [error, setError] = useState("");

  async function patch(key: string, body: { name?: string; slug?: string; settings?: SettingsPatch }, done: React.ReactNode): Promise<boolean> {
    if (!isAdmin) return false;
    setSaving(key);
    setError("");
    try {
      setSite(await updateSite(site.id, body));
      toast.success(done);
      return true;
    } catch (e) {
      setError(docsErrorMessage(e, "That didn't save. Try again."));
      return false;
    } finally {
      setSaving("");
    }
  }

  return { patch, saving, error, setError, locked: !isAdmin };
}

export default usePatch;
