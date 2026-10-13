import { Breadcrumb, DocumentRow, FileIcon, Icon } from "@/components/ui";
import type { FileRenderer } from "@/components/ui";
import type { TenantFolderDocument, TenantFolderRef } from "./folderIndex";
import { TenantFooter } from "./TenantFooter";
import { TenantHandoff } from "./TenantHandoff";
import { TenantHeader } from "./TenantHeader";

export interface TenantFolderIndexProps {
  /** The site's name (h1 at the root; the first breadcrumb elsewhere). */
  siteName: string;
  /** The folder being listed; null at the site root. */
  folder: TenantFolderRef | null;
  /** Ancestors of `folder`, root first (names for the breadcrumb). */
  trail?: TenantFolderRef[];
  folders: TenantFolderRef[];
  documents: TenantFolderDocument[];
  /** The tenant path of this page, for the sign-in return trip. */
  returnPath: string;
}

const DATE = new Intl.DateTimeFormat("en", { day: "numeric", month: "short", year: "numeric", timeZone: "UTC" });

function dateOf(d: TenantFolderDocument): string | null {
  const raw = d.updated_at || d.created_at;
  if (!raw) return null;
  const t = new Date(raw);
  return Number.isNaN(t.getTime()) ? null : DATE.format(t);
}

const hrefOf = (segments: string[]) => "/" + segments.map(encodeURIComponent).join("/");

const RENDERERS: FileRenderer[] = ["pdf", "sheet", "docx", "text", "video", "html", "image", "zip"];

function Tile({ doc }: { doc: TenantFolderDocument }) {
  if (doc.kind === "artifact") {
    const renderer = RENDERERS.includes(doc.renderer as FileRenderer) ? (doc.renderer as FileRenderer) : undefined;
    return (
      <span className="md-docrow__icon bg-surface-inset">
        <FileIcon name={doc.original_filename ?? undefined} mime={doc.mime ?? undefined} renderer={renderer} size={18} />
      </span>
    );
  }
  return (
    <span className="md-docrow__icon text-accent-text">
      <Icon name="doc" />
    </span>
  );
}

/**
 * A folder on a workspace's own domain (REVAMP_PLAN 7.22 "Tenant folder index"): the tenant
 * header, the folder's name as the page's h1, then its subfolders and documents as plain rows.
 * Readers get no row menus and no access controls. Server-rendered; the rows are links.
 */
export function TenantFolderIndex({ siteName, folder, trail = [], folders, documents, returnPath }: TenantFolderIndexProps) {
  const title = folder?.name ?? siteName;
  const crumbs = folder
    ? [
        { label: siteName, href: "/" },
        ...trail.map((t) => ({ label: t.name, href: hrefOf(t.path) })),
        { label: folder.name },
      ]
    : null;
  const empty = folders.length === 0 && documents.length === 0;
  const count = documents.length;

  return (
    <>
      <TenantHandoff />
      <TenantHeader returnPath={returnPath} />
      <main id="main" tabIndex={-1} className="w-full min-w-0 flex-1 px-4 py-8 outline-none sm:px-6 sm:py-12">
        <div className="mx-auto flex w-full min-w-0 max-w-app flex-col gap-6">
          <div className="flex min-w-0 flex-col gap-2">
            {crumbs && <Breadcrumb items={crumbs} className="min-w-0 flex-wrap" />}
            <h1 dir="auto" className="text-h1 text-text [overflow-wrap:anywhere]">{title}</h1>
            {!empty && (
              <p className="text-body text-text-secondary">
                {count === 1 ? "1 document" : `${count} documents`}
                {folders.length > 0 && ` · ${folders.length === 1 ? "1 folder" : `${folders.length} folders`}`}
              </p>
            )}
          </div>

          {empty ? (
            <div className="flex flex-col items-center gap-3 rounded-xl border border-dashed border-border-strong px-6 py-12 text-center">
              <span className="grid size-12 place-items-center rounded-lg bg-surface text-text-muted" aria-hidden>
                <Icon name="folder" size={22} />
              </span>
              <p className="text-body-strong text-text">Nothing here yet</p>
            </div>
          ) : (
            <>
              {folders.length > 0 && (
                <section aria-labelledby="tenant-folders" className="flex min-w-0 flex-col gap-2">
                  <h2 id="tenant-folders" className="text-eyebrow text-text-muted">Folders</h2>
                  <ul className="flex min-w-0 flex-col gap-2">
                    {folders.map((f) => (
                      <li key={f.path.join("/")} className="min-w-0">
                        <DocumentRow
                          title={f.name}
                          meta={
                            typeof f.document_count === "number"
                              ? f.document_count === 1 ? "1 document" : `${f.document_count} documents`
                              : <span className="font-mono">{hrefOf(f.path)}</span>
                          }
                          href={hrefOf(f.path)}
                          tile={
                            <span className="md-docrow__icon text-accent-text">
                              <Icon name="folder" />
                            </span>
                          }
                          hideOpen
                        />
                      </li>
                    ))}
                  </ul>
                </section>
              )}
              {documents.length > 0 && (
                <section aria-labelledby="tenant-docs" className="flex min-w-0 flex-col gap-2">
                  <h2 id="tenant-docs" className="text-eyebrow text-text-muted">Documents</h2>
                  <ul className="flex min-w-0 flex-col gap-2">
                    {documents.map((d) => {
                      const when = dateOf(d);
                      const kind = d.kind === "artifact" ? d.type_label || "File" : "Document";
                      return (
                        <li key={d.slug} className="min-w-0">
                          <DocumentRow
                            title={d.title || d.slug}
                            meta={when ? `${kind} · Updated ${when}` : kind}
                            href={hrefOf([...(d.folder_path ?? folder?.path ?? []), d.slug])}
                            tile={<Tile doc={d} />}
                            hideOpen
                          />
                        </li>
                      );
                    })}
                  </ul>
                </section>
              )}
            </>
          )}
        </div>
      </main>
      <TenantFooter />
    </>
  );
}

export default TenantFolderIndex;
