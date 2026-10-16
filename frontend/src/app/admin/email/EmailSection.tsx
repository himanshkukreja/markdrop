"use client";

import { useCallback, useEffect, useState } from "react";
import { isUnauthorized, readQuery, useOnUnauthorized, writeQuery } from "../shared";
import { emailApi, type Info, type TemplatesResponse } from "./api";
import CampaignPage from "./CampaignPage";
import Home from "./Home";

/**
 * Admin → Email: campaigns, senders and the campaign editor/report, in one section.
 *
 * URL state (read after mount, never useSearchParams):
 *   ?tab=email                         home, campaigns
 *   ?tab=email&et=senders              home, senders and suppressions
 *   ?tab=email&campaign=new&template=… a new draft from a template
 *   ?tab=email&campaign=<id>&ct=…      a campaign; ct = compose|audience|preview|send|report|content
 */

export interface View { campaign: string | null; ct: string | null; et: string | null; template: string | null }
export type Navigate = (patch: Partial<View>, opts?: { push?: boolean; replace?: boolean }) => void;

function readView(): View {
  const q = readQuery();
  return { campaign: q.get("campaign"), ct: q.get("ct"), et: q.get("et"), template: q.get("template") };
}

export default function EmailSection({ token }: { token: string }) {
  const onUnauthorized = useOnUnauthorized();
  const [view, setView] = useState<View | null>(null);
  const [info, setInfo] = useState<Info | null>(null);
  const [infoError, setInfoError] = useState<string | null>(null);
  const [meta, setMeta] = useState<TemplatesResponse | null>(null);
  const [metaError, setMetaError] = useState<string | null>(null);

  useEffect(() => {
    setView(readView());
    const onPop = () => setView(readView());
    window.addEventListener("popstate", onPop);
    return () => window.removeEventListener("popstate", onPop);
  }, []);

  const fail = useCallback((e: unknown, set: (m: string) => void) => {
    if (isUnauthorized(e)) onUnauthorized();
    else set(e instanceof Error ? e.message : "Request failed");
  }, [onUnauthorized]);

  const loadInfo = useCallback(async () => {
    try {
      setInfo(await emailApi.info(token));
      setInfoError(null);
    } catch (e) {
      fail(e, setInfoError);
    }
  }, [token, fail]);

  const loadMeta = useCallback(async () => {
    try {
      setMeta(await emailApi.templates(token));
      setMetaError(null);
    } catch (e) {
      fail(e, setMetaError);
    }
  }, [token, fail]);

  useEffect(() => { void loadInfo(); void loadMeta(); }, [loadInfo, loadMeta]);

  const navigate: Navigate = useCallback((patch, opts) => {
    const next = { ...readView(), ...patch };
    writeQuery({ campaign: next.campaign, ct: next.ct, et: next.et, template: next.template }, !opts?.replace);
    setView(next);
    if (!opts?.replace) window.scrollTo({ top: 0 });
  }, []);

  if (!view) return null;
  if (view.campaign) {
    return (
      <CampaignPage
        key={view.campaign === "new" ? `new:${view.template ?? ""}` : view.campaign}
        token={token}
        id={view.campaign}
        templateId={view.template}
        tab={view.ct}
        info={info}
        meta={meta}
        metaError={metaError}
        reloadMeta={loadMeta}
        navigate={navigate}
        refreshInfo={loadInfo}
      />
    );
  }
  return (
    <Home
      token={token}
      tab={view.et === "senders" ? "senders" : "campaigns"}
      info={info}
      infoError={infoError}
      meta={meta}
      metaError={metaError}
      reload={loadInfo}
      reloadMeta={loadMeta}
      navigate={navigate}
    />
  );
}
