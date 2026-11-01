"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Button, ConfirmDialog, useToast } from "@/components/ui";
import { deleteSite, primaryAddress, unpublishSite } from "@/lib/docsSites";
import { useStudio } from "../studio/StudioContext";
import { useSite } from "../SiteContext";
import { SectionHeader, SettingsCard } from "./SettingsShell";
import { SECTIONS } from "./sections";

/** Settings › Take it down: unpublish (keeps everything) or delete (typed confirmation). Admins only. */
export default function DangerSection() {
  const { site, setSite, isAdmin, listHref } = useSite();
  const { reloadAll } = useStudio();
  const toast = useToast();
  const router = useRouter();
  const [confirm, setConfirm] = useState<"unpublish" | "delete" | null>(null);
  const host = primaryAddress(site);

  return (
    <>
      <SectionHeader title="Take it down" description={SECTIONS.find((s) => s.id === "danger")?.blurb} />
      {!isAdmin ? (
        <SettingsCard>
          <p className="text-body text-text-secondary">Only Guides admins can unpublish or delete a guide.</p>
        </SettingsCard>
      ) : (
        <SettingsCard
          id="danger"
          tone="danger"
          title="Take the guide down"
          description="Unpublish keeps your pages and history; delete removes everything."
          aside={
            <>
              <Button variant="secondary" size="sm" disabled={site.status !== "live"} title={site.status !== "live" ? "The guide isn't live" : undefined} onClick={() => setConfirm("unpublish")}>Unpublish</Button>
              <Button variant="danger" size="sm" onClick={() => setConfirm("delete")}>Delete guide</Button>
            </>
          }
        />
      )}

      <ConfirmDialog
        open={confirm === "unpublish"}
        onClose={() => setConfirm(null)}
        title={<>Unpublish <span className="ph-sensitive ph-mask">{site.name}</span>?</>}
        body={<><span className="ph-sensitive ph-mask">{host}</span> stops showing the guide. Your pages, drafts and publish history stay, and publishing again puts it back.</>}
        confirmLabel="Unpublish"
        onConfirm={async () => {
          setSite(await unpublishSite(site.id));
          setConfirm(null);
          toast.success("The guide is unpublished.");
        }}
      />
      <ConfirmDialog
        open={confirm === "delete"}
        onClose={() => setConfirm(null)}
        title={<>Delete <span className="ph-sensitive ph-mask">{site.name}</span>?</>}
        body={<>Every page, version and publish goes, and <span className="ph-sensitive ph-mask">{host}</span> stops working. This can&apos;t be undone.</>}
        typeToConfirm={site.name}
        confirmLabel="Delete guide"
        onConfirm={async () => {
          await deleteSite(site.id);
          toast.success(<><span className="ph-sensitive ph-mask">{site.name}</span> was deleted.</>);
          void reloadAll();
          router.replace(listHref);
        }}
      />
    </>
  );
}
