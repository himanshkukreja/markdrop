"use client";

/**
 * "Organize meetings" (workspace admins), from the Meetings hub's ⋯ menu: what will happen (N meetings →
 * M series folders + Other meetings, how many move, get a series, transcripts tucked away), then the
 * run's live progress ("Organizing 34 of 80…") and its summary. The run is a background job on the
 * server (POST /meetings/organize answers at once; the hub polls it: MeetingsHub), so closing this
 * changes nothing. A dialog on desktop, a bottom sheet on phones.
 */
import { useEffect, useState } from "react";
import { Alert, Button, Dialog, Drawer, Icon, Progress, Skeleton } from "@/components/ui";
import { PHONE_QUERY, useMediaQuery } from "@/components/kit/publish-utils";
import { getOrganize, organizeMeetings, type OrganizeJob, type OrganizePreview } from "@/lib/meetings";
import "./organize.css";

export interface OrganizeMeetingsProps {
  open: boolean;
  onClose: () => void;
  workspaceId: string;
  /** The run this page is following (started or joined here); null shows the preview. */
  job: OrganizeJob | null;
  onJob: (job: OrganizeJob) => void;
  folderHref: string | null;
}

const plural = (n: number, one: string, many = `${one}s`) => `${n.toLocaleString()} ${n === 1 ? one : many}`;
const MAX_FOLDERS = 6;

export function OrganizeMeetings({ open, onClose, workspaceId, job, onJob, folderHref }: OrganizeMeetingsProps) {
  const phone = useMediaQuery(PHONE_QUERY);
  const [preview, setPreview] = useState<OrganizePreview | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [starting, setStarting] = useState(false);

  useEffect(() => {
    if (!open) return;
    setError(null);
    let live = true;
    getOrganize(workspaceId).then((r) => {
      if (!live) return;
      setPreview(r.preview);
      if (r.job?.state === "running") onJob(r.job);   // already going (another tab, another admin): follow it
    }).catch((e) => { if (live) setError(e instanceof Error ? e.message : "Couldn't load what organizing would do."); });
    return () => { live = false; };
    // onJob is the hub's setter; reading it once per open is enough.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, workspaceId]);

  const start = async () => {
    setStarting(true);
    setError(null);
    try {
      onJob((await organizeMeetings(workspaceId)).job);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Couldn't start organizing. Try again.");
    } finally {
      setStarting(false);
    }
  };

  const state = job ? job.state : "preview";
  const title = { preview: "Organize meetings", running: "Organizing meetings", done: "Meetings organized", failed: "Organizing stopped" }[state];
  const description = state === "preview"
    ? "File every meeting the way new ones are filed. Nothing is deleted and every link keeps working."
    : state === "running" ? "This runs on the server: you can close this window, and the list refreshes when it's done." : undefined;

  let body: React.ReactNode;
  let footer: React.ReactNode;
  if (job?.state === "running") {
    body = <Running job={job} />;
    footer = <Button variant="secondary" onClick={onClose} data-testid="organize-close">Close</Button>;
  } else if (job?.state === "done") {
    body = <Summary job={job} />;
    footer = (
      <>
        {folderHref && <Button variant="secondary" iconLeft="folder" href={folderHref}>Open the Meetings folder</Button>}
        <Button onClick={onClose} data-testid="organize-done">Done</Button>
      </>
    );
  } else if (job?.state === "failed") {
    body = <Alert tone="danger">{job.message || "Organizing the meetings stopped. Try again."}</Alert>;
    footer = (
      <>
        <Button variant="secondary" onClick={onClose}>Close</Button>
        <Button iconLeft="refresh" onClick={() => void start()} loading={starting}>Try again</Button>
      </>
    );
  } else {
    body = (
      <>
        {error && <Alert tone="danger" className="mb-3">{error}</Alert>}
        {preview ? <Preview p={preview} /> : !error && <PreviewSkeleton />}
      </>
    );
    footer = (
      <>
        <Button variant="secondary" onClick={onClose}>Cancel</Button>
        <Button iconLeft="listTree" onClick={() => void start()} loading={starting} disabled={!preview || preview.meetings === 0}
          data-testid="organize-start">
          {preview ? `Organize ${plural(preview.meetings, "meeting")}` : "Organize"}
        </Button>
      </>
    );
  }

  const content = <div className="mt-org" data-state={state} data-testid="organize-dialog">{body}</div>;
  if (phone) {
    return (
      <Drawer open={open} onClose={onClose} side="bottom" title={title} description={description} footer={footer}>
        {content}
      </Drawer>
    );
  }
  return (
    <Dialog open={open} onClose={onClose} size="md" title={title} description={description} footer={footer}
      glyph={<Icon name={state === "done" ? "checkCircle" : state === "failed" ? "alertCircle" : "listTree"} />}>
      {content}
    </Dialog>
  );
}

function Preview({ p }: { p: OrganizePreview }) {
  if (p.meetings === 0) return <p className="mt-org__empty">There are no meetings to organize yet.</p>;
  const shown = p.series_names.slice(0, MAX_FOLDERS);
  const more = p.series - shown.length;
  return (
    <>
      <div className="mt-org__flow" aria-label={`${plural(p.meetings, "meeting")} into ${plural(p.series, "series folder")} and Other meetings`}>
        <div className="mt-org__stat"><b>{p.meetings.toLocaleString()}</b><span>{p.meetings === 1 ? "meeting" : "meetings"}</span></div>
        <Icon name="arrowRight" className="mt-org__arrow" />
        <div className="mt-org__stat"><b>{p.series.toLocaleString()}</b><span>series {p.series === 1 ? "folder" : "folders"}</span></div>
        <span className="mt-org__plus" aria-hidden>+</span>
        <div className="mt-org__stat"><b>{p.other.toLocaleString()}</b><span>in Other meetings</span></div>
      </div>

      <div className="mt-org__tree" aria-label="Your Meetings folder afterwards">
        <div className="mt-org__root"><Icon name="folder" /> Meetings</div>
        <ul>
          {shown.map((s) => (
            <li key={s.name}><Icon name="folder" /><span className="mt-org__name">{s.name}</span><span className="mt-org__n">{s.count}</span></li>
          ))}
          {more > 0 && <li className="mt-org__more"><Icon name="more" /><span className="mt-org__name">{plural(more, "more series", "more series")}</span></li>}
          <li><Icon name="folder" /><span className="mt-org__name">Other meetings</span><span className="mt-org__n">{p.other}</span></li>
        </ul>
      </div>

      <ul className="mt-org__what">
        <li>
          <Icon name={p.to_move ? "arrowRight" : "checkCircle"} />
          <span>{p.to_move ? <><b>{plural(p.to_move, "meeting")}</b> move into {p.to_move === 1 ? "its" : "their"} folder, with {p.to_move === 1 ? "its" : "their"} transcript</> : "Every meeting is already in its folder"}</span>
        </li>
        {p.series_set > 0 && (
          <li><Icon name="layers" /><span><b>{plural(p.series_set, "meeting")}</b> {p.series_set === 1 ? "joins a series" : "join a series"}: a name that came up on two or more days</span></li>
        )}
        <li><Icon name="image" /><span>Each series gets its own cover, on pages nobody chose a cover for</span></li>
        {p.transcripts_to_hide > 0 && (
          <li><Icon name="eyeOff" /><span><b>{plural(p.transcripts_to_hide, "transcript")}</b> tucked under {p.transcripts_to_hide === 1 ? "its" : "their"} meeting page instead of listed beside it</span></li>
        )}
      </ul>
      <p className="mt-org__note"><Icon name="shield" /> A series someone set by hand stays as it is. Safe to run again.</p>
    </>
  );
}

function PreviewSkeleton() {
  return (
    <div className="mt-org__skel" aria-busy>
      <Skeleton variant="rect" height={72} />
      <Skeleton variant="rect" height={120} />
      <Skeleton height={16} width="70%" />
    </div>
  );
}

function Running({ job }: { job: OrganizeJob }) {
  const preparing = job.phase === "prepare" || job.done === 0;
  const label = preparing && job.done === 0 ? "Getting ready…" : `Organizing ${job.done.toLocaleString()} of ${job.total.toLocaleString()} meetings…`;
  return (
    <div className="mt-org__run" data-testid="organize-progress" aria-live="polite">
      <Progress value={job.done} max={Math.max(1, job.total)} label={label} showValue indeterminate={preparing && job.done === 0}
        valueText={`${job.done} of ${job.total} meetings`} />
      <ul className="mt-org__live">
        <li><b>{job.filed.toLocaleString()}</b> moved</li>
        <li><b>{job.series_set.toLocaleString()}</b> put in a series</li>
        <li><b>{job.covers.toLocaleString()}</b> {job.covers === 1 ? "cover" : "covers"} set</li>
        {job.errors > 0 && <li className="mt-org__bad"><b>{job.errors}</b> couldn't be organized</li>}
      </ul>
    </div>
  );
}

function Summary({ job }: { job: OrganizeJob }) {
  const others = job.folders - job.series;
  return (
    <div className="mt-org__done" data-testid="organize-summary">
      <p className="mt-org__headline">
        {job.filed
          ? <>{plural(job.filed, "meeting")} of {job.total.toLocaleString()} filed into {plural(job.folders, "folder")}.</>
          : <>Every meeting was already in its folder ({plural(job.total, "meeting")}).</>}
      </p>
      <dl className="mt-org__grid">
        <div><dt>Meetings</dt><dd>{job.total.toLocaleString()}</dd></div>
        <div><dt>Moved</dt><dd>{job.filed.toLocaleString()}</dd></div>
        <div><dt>Series</dt><dd>{job.series.toLocaleString()}</dd></div>
        <div><dt>Folders</dt><dd>{job.folders.toLocaleString()}</dd></div>
        <div><dt>Covers set</dt><dd>{job.covers.toLocaleString()}</dd></div>
        {job.transcripts_hidden > 0 && <div><dt>Transcripts tucked</dt><dd>{job.transcripts_hidden.toLocaleString()}</dd></div>}
      </dl>
      {others > 0 && job.series > 0 && <p className="mt-org__note"><Icon name="folder" /> {plural(job.series, "series folder")} and Other meetings, inside Meetings.</p>}
      {job.duplicates_removed > 0 && (
        <p className="mt-org__note"><Icon name="checkCircle" /> {plural(job.duplicates_removed, "empty extra folder")} removed.</p>
      )}
      {job.errors > 0 && (
        <Alert tone="warning" title={`${plural(job.errors, "meeting")} couldn't be organized`}>
          <ul className="mt-org__errs">
            {job.error_samples.map((e, i) => <li key={i}><b>{e.title}</b>: {e.error}</li>)}
          </ul>
          Run Organize meetings again to retry them.
        </Alert>
      )}
    </div>
  );
}
