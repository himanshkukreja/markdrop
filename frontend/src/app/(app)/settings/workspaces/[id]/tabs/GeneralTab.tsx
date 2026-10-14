"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { Button, Card, ConfirmDialog, Field, Input, useToast } from "@/components/ui";
import { deleteWorkspace, removeMember, updateWorkspace } from "@/lib/workspaces";
import { SwitchRow } from "../../../settings-shared";
import { Locked, lockProps, type WsTabProps } from "../ws-shared";

/** General: name, access, leave (non-owners) and the owner's danger zone. */
export default function GeneralTab({ id, ws, isOwner, isAdmin, meId, setWs }: WsTabProps) {
  const toast = useToast();
  const router = useRouter();
  const [name, setName] = useState(ws.name);
  const [nameError, setNameError] = useState("");
  const [savingName, setSavingName] = useState(false);
  const [savingAccess, setSavingAccess] = useState(false);
  const [confirm, setConfirm] = useState<"leave" | "delete" | null>(null);

  useEffect(() => setName(ws.name), [ws.name]);
  const dirty = name.trim() !== ws.name.trim();

  async function saveName(e: React.FormEvent) {
    e.preventDefault();
    if (!isAdmin) return;
    const n = name.trim();
    if (!n) { setNameError("Give the workspace a name."); return; }
    setSavingName(true);
    try {
      setWs(await updateWorkspace(id, { name: n }));
      toast.success("Workspace renamed.");
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Couldn't rename the workspace. Try again.");
    } finally {
      setSavingName(false);
    }
  }

  async function setAccess(on: boolean) {
    setSavingAccess(true);
    try {
      setWs(await updateWorkspace(id, { settings: { ...ws.settings, require_auth_to_view: on } }));
      toast.success(on ? "Readers now need to sign in." : "Anyone with a link can read again.");
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Couldn't change access. Try again.");
    } finally {
      setSavingAccess(false);
    }
  }

  return (
    <div className="flex min-w-0 flex-col gap-6">
      <Card title="Workspace name" description="Shown in your rail, invitations and the library.">
        <form onSubmit={saveName} className="flex min-w-0 flex-col gap-3 sm:flex-row sm:items-start" noValidate>
          <Field label="Name" error={nameError || undefined} className="min-w-0 flex-1">
            <Input
              value={name}
              maxLength={80}
              readOnly={!isAdmin}
              aria-disabled={!isAdmin || undefined}
              onChange={(e) => { setName(e.target.value); if (nameError) setNameError(""); }}
            />
          </Field>
          <Locked locked={!isAdmin}>
            <Button type="submit" variant="secondary" className="sm:mt-7" loading={savingName} disabled={isAdmin && !dirty} {...lockProps(!isAdmin)}>
              Save
            </Button>
          </Locked>
        </form>
      </Card>

      <Card title="Access">
        <Locked locked={!isAdmin}>
          <div>
            <SwitchRow
              id="ws-require-auth"
              label="Require sign-in to read this workspace's documents"
              hint="Enforced everywhere, including markdrop.in links."
              checked={ws.settings.require_auth_to_view}
              disabled={savingAccess}
              locked={!isAdmin}
              onChange={setAccess}
            />
          </div>
        </Locked>
      </Card>

      {!isOwner && (
        <Card title="Leave workspace" description="You lose access to its library and settings right away. Documents you shared into it stay there, and you still own them.">
          <Button variant="secondary" iconLeft="logOut" onClick={() => setConfirm("leave")}>Leave workspace</Button>
        </Card>
      )}

      {/* Owner only. An admin runs a workspace; only the owner ends it. */}
      {isOwner && (
        <section aria-labelledby="ws-danger" className="flex min-w-0 flex-col gap-3 rounded-xl border border-danger/40 bg-surface p-5">
          <h3 id="ws-danger" className="text-h4 text-danger">Delete workspace</h3>
          <p className="max-w-[60ch] text-body text-text-secondary">
            Removes the workspace, its members, folders and domains. Shared documents are not deleted. They go back to the people who own them, with the same links and analytics.
          </p>
          <div>
            <Button variant="danger" iconLeft="trash" onClick={() => setConfirm("delete")}>Delete workspace</Button>
          </div>
        </section>
      )}

      <ConfirmDialog
        open={confirm === "leave"}
        onClose={() => setConfirm(null)}
        title={`Leave ${ws.name}?`}
        body="You lose access to its library and settings right away. To come back, an admin has to invite you again."
        confirmLabel="Leave workspace"
        onConfirm={async () => {
          if (!meId) return;
          await removeMember(id, meId);
          setConfirm(null);
          toast.success(`You left ${ws.name}.`);
          router.push("/settings/workspaces");
        }}
      />

      <ConfirmDialog
        open={confirm === "delete"}
        onClose={() => setConfirm(null)}
        title={`Delete ${ws.name}?`}
        body="Removes the workspace, its members, folders and domains. Shared documents are not deleted. They go back to the people who own them, with the same links and analytics."
        typeToConfirm={ws.name}
        confirmLabel="Delete permanently"
        onConfirm={async () => {
          await deleteWorkspace(id, ws.name.trim());
          setConfirm(null);
          toast.success(`${ws.name} was deleted.`);
          router.push("/settings/workspaces");
        }}
      />
    </div>
  );
}
