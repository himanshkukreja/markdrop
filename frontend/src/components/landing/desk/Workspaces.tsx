import { docsUrl } from "@/components/shell/links";
import { DOCS_PAGES } from "@/lib/docsLinks";
import { Icon } from "../ds";
import s from "./Sections.module.css";

/** Acme's workspace, as a folder on the desk (fictional data, the same Acme as the desk samples). */
const FOLDERS = [
  { name: "Launch", files: [{ name: "Launch notes", kind: "Document", path: "launch/notes" }, { name: "Pricing calculator", kind: "HTML page", path: "launch/pricing" }], open: true },
  { name: "Sales", count: "12 files" },
  { name: "Support", count: "31 files" },
];

const MEMBERS = [
  { initials: "MA", name: "Maya", role: "Owner" },
  { initials: "RI", name: "Riya", role: "Admin" },
  { initials: "AL", name: "Alex", role: "Can edit" },
  { initials: "SA", name: "Sam", role: "Can view" },
];

/**
 * 4 · Workspaces. A team's documents and files in folders, with roles, on its own domain and brand.
 * The desk object is Acme's folder: its domain on the tab, folders inside, the people and their
 * roles clipped to the front. Server HTML, no script; the drawing is aria-hidden (the copy says it).
 */
export default function Workspaces() {
  return (
    <section id="workspaces" aria-labelledby="workspaces-h" className={s.section}>
      <div className={`${s.split} ${s.splitRev}`}>
        <div className={s.copy}>
          <span className={s.eyebrow}>Workspaces</span>
          <h2 id="workspaces-h" className={s.h2}>
            Your team&apos;s links, in one place.
          </h2>
          <p className={s.lede}>A workspace keeps your team&apos;s documents and files in folders, with a role for everyone. Publish them on your own domain, under your own name.</p>
          <ul className={s.points}>
            <li>
              <Icon name="folder" />
              <span>
                <b>Folders, nested up to 8 deep.</b> One folder link lists everything inside it.
              </span>
            </li>
            <li>
              <Icon name="users" />
              <span>
                <b>Roles:</b> Can view, Can edit, Admin and Owner.
              </span>
            </li>
            <li>
              <Icon name="globe" />
              <span>
                <b>Your own domain</b>, like docs.acme.com: two DNS records, and your markdrop.in links keep working.
              </span>
            </li>
            <li>
              <Icon name="palette" />
              <span>
                <b>Your name, logo and accent colour</b> on your domain and its link previews.
              </span>
            </li>
          </ul>
          <div className={s.links}>
            <a className={s.more} href={docsUrl(DOCS_PAGES.createWorkspace)} data-cta="workspaces_docs">
              How workspaces work
              <Icon name="arrowRight" />
            </a>
          </div>
        </div>

        <div className={s.wsVisual} aria-hidden="true">
          <div className={s.folder}>
            <span className={s.folderTab}>
              <span className={s.brandMark}>A</span>
              docs.acme.com
            </span>
            <div className={s.folderBody}>
              <div className={s.folderHead}>
                <span className={s.brandMark} data-big="">
                  A
                </span>
                <span>
                  <b>Acme</b>
                  <span>Workspace · 4 members</span>
                </span>
              </div>
              <ul className={s.tree}>
                {FOLDERS.map((f) => (
                  <li key={f.name}>
                    <span className={s.treeRow} data-open={f.open ? "" : undefined}>
                      <Icon name="folder" />
                      <b>{f.name}</b>
                      <span>{f.count ?? `${f.files?.length} files`}</span>
                    </span>
                    {f.files && (
                      <ul>
                        {f.files.map((x) => (
                          <li key={x.name} className={s.treeFile}>
                            <Icon name={x.kind === "Document" ? "doc" : "code"} />
                            <span>
                              <b>{x.name}</b>
                              <span>docs.acme.com/{x.path}</span>
                            </span>
                            <em>{x.kind}</em>
                          </li>
                        ))}
                      </ul>
                    )}
                  </li>
                ))}
              </ul>
            </div>
          </div>
          <div className={s.roster}>
            <span className={s.rosterHead}>Members</span>
            {MEMBERS.map((m) => (
              <span key={m.name} className={s.member}>
                <span className={s.avatar}>{m.initials}</span>
                <b>{m.name}</b>
                <em>{m.role}</em>
              </span>
            ))}
          </div>
          <span className={s.wsNote}>
            your domain,
            <br />
            your logo.
          </span>
        </div>
      </div>
    </section>
  );
}
