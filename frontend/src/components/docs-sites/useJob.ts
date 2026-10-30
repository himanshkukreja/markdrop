"use client";

import { useEffect, useRef, useState } from "react";
import { docsErrorMessage, getJob, type Job } from "@/lib/docsSites";

/**
 * Polls `GET /docs-sites/<site>/jobs/<job>` every `interval` ms while the job is queued or running
 * (paused while the tab is hidden), and stops when it's done or failed.
 */
export function useJob(siteId: string, jobId: string | null, interval = 2000) {
  const [job, setJob] = useState<Job | null>(null);
  const [error, setError] = useState("");
  const timer = useRef<number | null>(null);

  useEffect(() => {
    setJob(null);
    setError("");
    if (!jobId) return;
    let live = true;
    let failures = 0;
    const tick = async () => {
      if (!live) return;
      if (document.visibilityState === "hidden") {
        timer.current = window.setTimeout(tick, interval);
        return;
      }
      try {
        const j = await getJob(siteId, jobId);
        if (!live) return;
        failures = 0;
        setJob(j);
        setError("");
        if (j.status === "queued" || j.status === "running") timer.current = window.setTimeout(tick, interval);
      } catch (e) {
        if (!live) return;
        failures++;
        setError(docsErrorMessage(e, "We lost track of this job."));
        // Back off on errors, give up after a while (the page offers a retry).
        if (failures < 8) timer.current = window.setTimeout(tick, interval * Math.min(8, 2 ** failures));
      }
    };
    void tick();
    return () => {
      live = false;
      if (timer.current) window.clearTimeout(timer.current);
    };
  }, [siteId, jobId, interval]);

  return { job, error };
}
