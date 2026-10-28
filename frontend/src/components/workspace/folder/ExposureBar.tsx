"use client";

/**
 * "Who can open what's in here" (Main board): three counts of the items filed directly in this
 * folder that the caller can open, by who can open them, and what new items here start as. The
 * counts come from the server (`exposure` on /tree) and never include what the caller can't read.
 * Phones get the three counts alone, as small badges (Mobile board).
 */
import { useEffect, useState } from "react";
import { Alert, Badge, Button, Dialog, RadioGroup, useToast } from "@/components/ui";
import { updateFolder, type Exposure, type ItemAccess, type TreeFolder } from "@/lib/workspaces";
import { workspaceChanged } from "@/lib/workspaceStore";
import { accessLabel } from "./items";

export function ExposureBar({
  exposure, team, startsAs, onChange, phone,
}: {
  exposure: Exposure;
  team: string;
  /** The folder's effective default; null hides the "New items here start as" part. */
  startsAs: ItemAccess | null;
  /** Admins: opens the dialog to change it (or the workspace settings at the top level). */
  onChange?: (() => void) | null;
  phone: boolean;
}) {
  const pw = exposure.password ?? 0;
  if (phone) {
    return (
      <ul className="m-0 flex list-none flex-wrap gap-1.5 p-0" aria-label="Who can open what's in here">
        <li><Badge tone="info" size="sm" icon="globe">{exposure.link} public</Badge></li>
        <li><Badge size="sm" icon="user">{exposure.workspace} team</Badge></li>
        <li><Badge size="sm" icon="lock">{exposure.private} private</Badge></li>
      </ul>
    );
  }
  return (
    <section
      aria-label="Who can open what's in here"
      className="flex min-w-0 flex-wrap items-center gap-2 rounded-xl border border-border bg-surface px-3.5 py-2.5"
    >
      <span className="mr-1 text-[13px] leading-5 text-text-secondary">Who can open what&apos;s in here:</span>
      <Badge tone="info" icon="globe" title={pw ? `${pw} of them ask for a password` : undefined}>
        {exposure.link} anyone with the link
        {pw ? <span className="md-visually-hidden">, {pw} of them with a password</span> : null}
      </Badge>
      <Badge icon="user">{exposure.workspace} {team} team</Badge>
      <Badge icon="lock">{exposure.private} only people added</Badge>
      {startsAs && (
        <span className="ml-auto text-caption text-text-muted">
          New items here start as <strong className="font-semibold text-text">{accessLabel(startsAs, team)}</strong>
          {onChange && (
            <>
              {" · "}
              <button type="button" onClick={onChange} className="md-focus cursor-pointer rounded-sm bg-transparent p-0 font-semibold text-accent-text underline-offset-3 hover:underline">
                Change<span className="md-visually-hidden"> what new items start as</span>
              </button>
            </>
          )}
        </span>
      )}
    </section>
  );
}

/** Exposure computed from the rows on screen, for a backend that doesn't send it yet. */
export function exposureOf(items: Array<{ access: ItemAccess; has_password?: boolean }>): Exposure {
  const e: Exposure = { link: 0, workspace: 0, private: 0, password: 0 };
  for (const it of items) {
    e[it.access] += 1;
    if (it.access === "link" && it.has_password) e.password! += 1;
  }
  return e;
}

/**
 * "New items in Guides start as…" (admins). A starting point only: it never changes what is
 * already in the folder. "Same as the workspace" clears the folder's own choice.
 */
export function FolderDefaultDialog({
  workspaceId, folder, team, workspaceDefault, onClose,
}: {
  workspaceId: string;
  folder: TreeFolder | null;
  team: string;
  workspaceDefault: ItemAccess;
  onClose: () => void;
}) {
  const toast = useToast();
  const [value, setValue] = useState<string>("inherit");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  useEffect(() => {
    if (folder) { setValue(folder.default_access ?? "inherit"); setError(""); setBusy(false); }
  }, [folder]);

  async function save() {
    if (!folder) return;
    setBusy(true);
    setError("");
    try {
      await updateFolder(workspaceId, folder.id, { default_access: value === "inherit" ? null : (value as ItemAccess) });
      workspaceChanged(workspaceId);
      toast.success(`New items in “${folder.name}” start as ${accessLabel(value === "inherit" ? workspaceDefault : (value as ItemAccess), team)}`);
      onClose();
    } catch (e) {
      setError(e instanceof Error && e.message ? e.message : "That didn't save. Try again.");
      setBusy(false);
    }
  }

  return (
    <Dialog
      open={!!folder}
      onClose={onClose}
      dismissible={!busy}
      title={folder ? `New items in “${folder.name}” start as` : "New items start as"}
      description="A starting point only. Each item keeps its own setting, and nothing already here changes."
      footer={
        <>
          <Button variant="ghost" onClick={onClose} disabled={busy}>Cancel</Button>
          <Button variant="primary" onClick={() => void save()} loading={busy}>Save</Button>
        </>
      }
    >
      <div className="flex flex-col gap-3">
        <RadioGroup
          name="md-folder-default"
          aria-label="New items start as"
          value={value}
          onChange={setValue}
          options={[
            { value: "inherit", label: `Same as the workspace (${accessLabel(workspaceDefault, team)})` },
            { value: "private", label: "Only people added", description: "The person who adds it, and people they add." },
            { value: "workspace", label: `${team} team`, description: `Anyone in ${team}, after signing in.` },
            { value: "link", label: "Anyone with the link", description: "No sign-in needed." },
          ]}
        />
        {error && <Alert tone="danger">{error}</Alert>}
      </div>
    </Dialog>
  );
}
