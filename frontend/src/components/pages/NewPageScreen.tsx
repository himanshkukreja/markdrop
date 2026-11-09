"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { Badge, EmptyState, MarkdropLoader } from "@/components/ui";
import { useAuth } from "@/contexts/AuthContext";
import { useQueryFlags } from "@/lib/useQueryFlags";
import { TemplateGallery } from "./TemplateGallery";

/**
 * /pages/new (the Create menu's "Page"): the template gallery, then the editor. `?workspace=`,
 * `?folder=` and `?parent=` file the page like the workspace views do; `?team=` puts it in a team's space. Pages need an account.
 */
export function NewPageScreen() {
  const router = useRouter();
  const { user, loading } = useAuth();
  const q = useQueryFlags();
  const [open, setOpen] = useState(true);

  useEffect(() => {
    if (!loading && !user) router.replace(`/login?next=${encodeURIComponent(`/pages/new${window.location.search}`)}`);
  }, [loading, user, router]);

  if (loading || !user || !q.ready) {
    return (
      <div className="flex min-h-[40vh] items-center justify-center">
        <MarkdropLoader label="Opening" delay={300} />
      </div>
    );
  }
  return (
    <>
      <EmptyState icon="layers" title={<span className="inline-flex items-center gap-2">New page <Badge tone="info" size="sm" upper>Beta</Badge></span>} description="Pick a template or start blank. You write pages with blocks, and they're published at their own link like every Markdrop document." className="py-16" />
      <TemplateGallery
        open={open}
        onClose={() => {
          setOpen(false);
          router.push("/dashboard");
        }}
        workspace={q.get("workspace")}
        folder={q.get("folder")}
        parent={q.get("parent")}
        team={q.get("team")}
      />
    </>
  );
}

export default NewPageScreen;
