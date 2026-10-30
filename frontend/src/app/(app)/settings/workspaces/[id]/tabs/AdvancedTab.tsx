"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Button, ConfirmDialog, Field, Select, useToast } from "@/components/ui";
import { ReadMore } from "@/components/ReadMore";
import { teamName } from "@/components/workspace/folder/items";
import { deleteWorkspace, removeMember, updateWorkspace, type ItemAccess, type WorkspaceSettings } from "@/lib/workspaces";
import { SwitchRow } from "../../../settings-shared";
import { Locked, lockProps, type WsTabProps } from "../ws-shared";

/**
 * Advanced (Settings board): the individual switches behind Privacy — what new items start as,
 * whether members can share folders, whether visitors must sign in — then leaving or deleting the
 * workspace. Each switch saves on its own; Privacy on the People tab shows "Custom" when they don't
 * match one of its presets.
 */
export default function AdvancedTab({ id, ws, isOwner, isAdmin, meId, setWs }: WsTabProps) {
  const toast = useToast();
  const router = useRouter();
  const [saving, setSaving] = useState<"" | "default" | "share" | "auth">("");
  const [confirm, setConfirm] = useState<"leave" | "delete" | null>(null);
  const team = teamName(ws);
  const current: ItemAccess = ws.settings.default_access ?? ws.default_access ?? "workspace";

  async function save(key: "default" | "share" | "auth", patch: Partial<WorkspaceSettings>, done: string) {
    if (!isAdmin) return;
    setSaving(key);
    try {
      // The settings PUT replaces the whole object: send every field back as it came.
      setWs(await updateWorkspace(id, { settings: { ...ws.settings, default_access: current, ...patch } }));
      toast.success(done);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "That didn't save. Try again.");
    } finally {
      setSaving("");
    }
  }

  return (
    <div className="flex min-w-0 flex-col gap-5">
      <section aria-label="Switches" className="flex min-w-0 flex-col gap-4 rounded-xl border border-border bg-surface p-5">
        <p className="text-[13px] leading-5 text-text-secondary">The fine-grained switches behind Privacy. Most workspaces never need these.</p>
        <Field label="New items start as" hint="A starting point only. Each item keeps its own setting.">
          <Select
            value={current}
            disabled={!isAdmin || saving === "default"}
            onChange={(e) => {
              const v = e.target.value as ItemAccess;
              void save("default", { default_access: v }, "New items start differently now. Nothing already here changed.");
            }}
            options={[
              { value: "private", label: "Only people added" },
              { value: "workspace", label: `${team} team` },
              { value: "link", label: "Anyone with the link" },
            ]}
            className="max-w-[280px]"
          />
        </Field>
        <Locked locked={!isAdmin}>
          <div>
            <SwitchRow
              id="ws-members-share"
              label="Members can share folders with a link"
              hint="Admins always can. A folder link never opens anything by itself."
              checked={ws.settings.members_can_share_folders !== false}
              disabled={saving === "share"}
              locked={!isAdmin}
              onChange={(on) => void save("share", { members_can_share_folders: on }, on ? "Members can share folders." : "Only admins share folders now.")}
            />
          </div>
        </Locked>
        <Locked locked={!isAdmin}>
          <div>
            <SwitchRow
              id="ws-require-auth"
              label="Visitors must sign in to open anything"
              hint={<>Enforced everywhere, including markdrop.in links. No public links. <ReadMore topic="domainSignIn" /></>}
              checked={ws.settings.require_auth_to_view}
              disabled={saving === "auth"}
              locked={!isAdmin}
              onChange={(on) => void save("auth", { require_auth_to_view: on }, on ? "Visitors now need to sign in." : "Links work for anyone they're open to again.")}
            />
          </div>
        </Locked>
      </section>

      {!isOwner && (
        <section aria-labelledby="ws-leave-h" className="flex min-w-0 flex-wrap items-center gap-3 rounded-xl border border-border bg-surface p-5">
          <div className="min-w-0 flex-[1_1_320px]">
            <h2 id="ws-leave-h" className="text-body-strong text-text">Leave workspace</h2>
            <p className="mt-0.5 text-[13px] text-text-muted">You lose access to it right away. Files you added stay there, and you still own them.</p>
          </div>
          <Button variant="secondary" iconLeft="logOut" onClick={() => setConfirm("leave")}>Leave {ws.name}…</Button>
        </section>
      )}

      {/* Owner only. An admin runs a workspace; only the owner ends it. */}
      <section aria-labelledby="ws-delete-h" className="flex min-w-0 flex-wrap items-center gap-3 rounded-xl border border-border bg-surface p-5">
        <div className="min-w-0 flex-[1_1_320px]">
          <h2 id="ws-delete-h" className="text-body-strong text-text">Delete workspace</h2>
          <p className="mt-0.5 text-[13px] text-text-muted">Files go back to the people who own them, as private. Your domain stops serving.</p>
        </div>
        <Locked locked={!isOwner} reason="Only the owner can delete it">
          <Button variant="secondary" iconLeft="trash" {...lockProps(!isOwner)} onClick={isOwner ? () => setConfirm("delete") : lockProps(true).onClick}>
            Delete {ws.name}…
          </Button>
        </Locked>
      </section>

      <ConfirmDialog
        open={confirm === "leave"}
        onClose={() => setConfirm(null)}
        title={`Leave ${ws.name}?`}
        body="You lose access to it right away. To come back, an admin has to invite you again."
        confirmLabel="Leave workspace"
        onConfirm={async () => {
          if (!meId) return;
          await removeMember(id, meId);
          setConfirm(null);
          toast.success(`You left ${ws.name}.`);
          router.push("/dashboard");
        }}
      />

      <ConfirmDialog
        open={confirm === "delete"}
        onClose={() => setConfirm(null)}
        title={`Delete ${ws.name}?`}
        body="Removes the workspace, its members, folders and domains. Files are not deleted: they go back to the people who own them, with the same links and analytics. Anything open to the team becomes “Only people added”."
        typeToConfirm={ws.name}
        confirmLabel="Delete permanently"
        onConfirm={async () => {
          await deleteWorkspace(id, ws.name.trim());
          setConfirm(null);
          toast.success(`${ws.name} was deleted.`);
          router.push("/dashboard");
        }}
      />
    </div>
  );
}
