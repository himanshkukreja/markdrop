import type { Metadata } from "next";
import { ButtonLink, Icon, MarkdropMark } from "@/components/landing/ds";
import { SnapPage, SnapSection } from "@/components/marketing/snap/Snap";
import { Feature, LoopShot, Mat, More, parts as p } from "@/components/marketing/snap/Parts";
import { docsUrl } from "@/components/shell/links";
import { DOCS_PAGES } from "@/lib/docsLinks";
import { HeroSwap, SWAP_SCRIPT } from "./HeroSwap";
import { WorkspaceCta } from "./WorkspaceCta";
import s from "./enterprise.module.css";

export const metadata: Metadata = {
  title: "Custom domains & white-labelling — Markdrop",
  description:
    "Serve your docs and files from your own domain with your own branding. Custom domains, white-label preview cards, a view-only mode, folders and team roles.",
  // Override the site-wide card from the root layout so this page previews as itself.
  openGraph: {
    title: "Custom domains & white-labelling — Markdrop",
    description: "Serve your docs and files from your own domain with your own branding.",
  },
  twitter: {
    card: "summary",
    title: "Custom domains & white-labelling — Markdrop",
    description: "Serve your docs and files from your own domain with your own branding.",
  },
};

/** D17: a markdrop.in address, shown as text. This one is the live reply-to of every Markdrop email
 *  (backend config `email_reply_to`). Pending the owner's pick of a dedicated address (Q4). */
const CONTACT = "himanshu@markdrop.in";
const CONTACT_HREF = `mailto:${CONTACT}?subject=${encodeURIComponent("Markdrop for our team")}`;

const docs = (k: keyof typeof DOCS_PAGES) => docsUrl(DOCS_PAGES[k]);

/** Numbered like the pins on the hero's swap: 1 the address, 2 the tab, 3 the colour, 4 the link preview. */
const HERO_POINTS = ["Your own hostname, like docs.example.com", "Your name and favicon in the tab", "Your colour across the page", "Your brand on link previews"];

const RECORDED = "Recorded in Markdrop's workspace settings, with fictional data.";

/** What workspace admins can and can't see (docs: workspaces/privacy, members-and-roles, faq). */
const CAN_SEE = [
  { t: "What's filed in the workspace", d: "The items the team can open, by folder." },
  { t: "Who belongs, and each role", d: "Members and pending invitations." },
  { t: "Domains, branding and privacy", d: "Only admins and the owner change them." },
];
const NEVER_SEE = [
  { t: "A member's own files", d: "Nothing moves into a workspace until its owner puts it there." },
  { t: "Items set to Only people added", d: "Not even admins, and no analytics for items they don't own." },
  { t: "The text of an encrypted document", d: "The key never reaches our servers; signing in never unlocks it." },
];

function Ctas() {
  return (
    <>
      <WorkspaceCta />
      <ButtonLink href={CONTACT_HREF} variant="secondary" data-cta="ent_contact">
        Talk to us
      </ButtonLink>
    </>
  );
}

function Boundary() {
  return (
    <div className={`${p.panel} ${s.boundary}`}>
      <div className={s.side}>
        <h3>
          <span aria-hidden="true">
            <Icon name="eye" />
          </span>
          Workspace admins can see
        </h3>
        <ul>
          {CAN_SEE.map((it) => (
            <li key={it.t}>
              <Icon name="check" />
              <span>
                <b>{it.t}</b>
                {it.d}
              </span>
            </li>
          ))}
        </ul>
      </div>
      <div className={s.side} data-never="">
        <h3>
          <span aria-hidden="true">
            <Icon name="eyeOff" />
          </span>
          They never see
        </h3>
        <ul>
          {NEVER_SEE.map((it) => (
            <li key={it.t}>
              <Icon name="minus" />
              <span>
                <b>{it.t}</b>
                {it.d}
              </span>
            </li>
          ))}
        </ul>
      </div>
      <p className={s.caveats}>
        <b>Worth knowing:</b> a subdomain like docs.acme.com is simplest (an apex domain needs an A record). View only applies on your own domains,
        never on markdrop.in.
      </p>
    </div>
  );
}

/**
 * /enterprise: workspaces on your own domain, under your own brand, for teams. Seven one-viewport
 * sections that snap from 1024 × 640 (SnapPage / Feature, components/marketing/snap): the hero (the
 * brand swap), your domain, your brand, people and roles, who sees what, the privacy boundary, and
 * the closing CTA. The loops are the real workspace settings (series video 06, fictional Acme);
 * facts follow docs workspaces/* and sharing/*. Static: the CTA learns sign-in after mount.
 */
export default function EnterprisePage() {
  return (
    <SnapPage>
      {/* Runs before the figure paints: a returning visitor never sees the start frame. */}
      <script dangerouslySetInnerHTML={{ __html: SWAP_SCRIPT }} />

      <Feature
        id="top"
        hero
        eyebrow="For teams"
        title={
          <>
            Your domain.
            <br />
            <span className={p.accent}>Your brand.</span>
          </>
        }
        lede="A workspace keeps your team's documents and files in folders, with a role for everyone, and publishes them from your own domain, under your own name."
        extra={
          <ol className={s.heroPoints}>
            {HERO_POINTS.map((t, i) => (
              <li key={t}>
                <span aria-hidden="true" className={s.pin}>
                  {i + 1}
                </span>
                <span>{t}</span>
              </li>
            ))}
          </ol>
        }
        actions={<Ctas />}
        visual={
          <div className={s.swapFit}>
            <div className={s.swapBox}>
              <HeroSwap />
            </div>
          </div>
        }
      />

      <Feature
        id="domains"
        rev
        eyebrow="Custom domains"
        title="Your domain, from two DNS records."
        lede="Add a hostname you control, paste two records where your DNS lives, then choose Check DNS. Nothing changes for readers until both are in place."
        points={[
          { icon: "shield", title: "An ownership record (TXT)", text: "proves it's yours; a routing record (CNAME, or A for an apex) points it here." },
          { icon: "globe", title: "Your DNS provider, spotted:", text: "Cloudflare and others get the values written the way they expect." },
          { icon: "link", title: "Up to 25 domains a workspace,", text: "and every markdrop.in link keeps working." },
          { icon: "refresh", title: "Kept honest:", text: "if the records stop pointing here for three days, the domain stops serving until you fix them." },
        ]}
        actions={
          <More href={docs("customDomain")} cta="ent_domain_docs">
            Add your domain
          </More>
        }
        visual={
          <LoopShot
            name="ent-domain"
            w={1032}
            h={888}
            addr={
              <>
                <b>markdrop.in</b>/workspaces/acme
              </>
            }
            tag="docs.acme.com"
            tagIcon="globe"
            caption={RECORDED}
            label="Acme's workspace settings: Add domain with the hostname docs.acme.com, serving Documents and files; then its card, Awaiting DNS, with the steps Added, DNS records, Verified and Live, Your DNS is at Cloudflare, and the ownership (TXT) and routing (CNAME to edge.markdrop.in) records to copy; then docs.acme.com is live."
          />
        }
      />

      <Feature
        id="brand"
        eyebrow="White-label"
        title="Your name on every page."
        lede="On your domain, pages carry your site name, logo, favicon and colour, and so do the previews people paste in chats."
        points={[
          { icon: "image", title: "Logo and favicon:", text: "PNG, JPEG, WebP or GIF, saved as soon as they upload." },
          { icon: "palette", title: "Your accent colour", text: "for buttons, links and highlights. Leave it blank for Markdrop's blue." },
          { icon: "link", title: "White-label preview cards:", text: "no “Published with Markdrop” on cards and titles." },
          { icon: "eyeOff", title: "View only:", text: "no controls for signed-out visitors, on your own domains only." },
        ]}
        actions={
          <More href={docs("branding")} cta="ent_brand_docs">
            Branding
          </More>
        }
        visual={
          <LoopShot
            name="ent-brand"
            w={1032}
            h={864}
            addr={
              <>
                <b>markdrop.in</b>/workspaces/acme
              </>
            }
            tag="Look and domain"
            tagIcon="palette"
            caption={RECORDED}
            label="Acme's Look and domain settings: the favicon and logo, the logo background, the accent colour changed to #0E7490 and White-label preview cards switched on, with How your links look updating beside them: the docs.acme.com tab and the link preview card in Acme's colour. Then Save changes."
          />
        }
      />

      <Feature
        id="people"
        rev
        eyebrow="Workspaces"
        title="Your team, with a role each."
        lede="Invite people by email. Nobody joins until they accept, and an invitation only works for the address it was sent to."
        points={[
          { icon: "users", title: "Can view, Can edit, Admin, Owner:", text: "one role across the workspace, up to 200 members." },
          { icon: "lock", title: "Open, Team or Locked.", text: "Locked makes visitors sign in on every address, markdrop.in links included." },
          { icon: "folder", title: "Folders, 8 levels deep,", text: "shape the addresses (docs.acme.com/guides/setup). They never grant access." },
        ]}
        actions={
          <More href={docs("members")} cta="ent_people_docs">
            Members and roles
          </More>
        }
        visual={
          <LoopShot
            name="ent-people"
            w={1032}
            h={864}
            addr={
              <>
                <b>markdrop.in</b>/workspaces/acme
              </>
            }
            tag="People"
            tagIcon="users"
            caption={RECORDED}
            label="Acme's People tab: Privacy set to Team (Open and Locked beside it) and the members Riya (Owner), Maya (Admin), Alex (Can edit) and Sam (Can view); Invite people opens, two addresses are typed, Can edit is chosen and Send invitation sends 2 invitations."
          />
        }
      />

      <Feature
        id="access"
        eyebrow="Access"
        title="Check what anyone else sees."
        lede="Each item is open to Only people added, the Acme team, or Anyone with the link. People you add by email always get in."
        points={[
          { icon: "eye", title: "Preview as", text: "a visitor, a member or a named email, with the reason each hidden item is hidden." },
          { icon: "folder", title: "A shared folder link", text: "lists only what each visitor could already open." },
          { icon: "key", title: "Sign-in on your domain", text: "is read-only, works on that one domain and lasts 12 hours." },
        ]}
        actions={
          <More href={docs("previewAs")} cta="ent_access_docs">
            Check what someone else sees
          </More>
        }
        visual={
          <LoopShot
            name="ent-preview"
            w={1280}
            h={800}
            addr={
              <>
                <b>markdrop.in</b>/workspaces/acme/sales
              </>
            }
            tag="Preview as"
            tagIcon="eye"
            caption={RECORDED}
            label="Acme's Sales folder with five items, each with its access (Only people added, Acme team, Anyone with the link); Preview as Anyone with the link shows they'll see 1 of 5 items, the Enterprise security FAQ, and lists the four hidden from them with the reason and a Let anyone open button."
          />
        }
      />

      <Feature
        id="privacy"
        rev
        even
        eyebrow="The privacy boundary"
        title="What admins see, and what they don't."
        lede="Admins run people, domains and branding. They don't get into anyone's own files."
        points={[
          { icon: "key", title: "End-to-end encryption for documents:", text: "sealed in the browser, the key stays in the link." },
          { icon: "archive", title: "Delete the workspace", text: "and every item goes back to its owner, with the same link and analytics." },
        ]}
        actions={
          <More href={docs("workspacePrivacy")} cta="ent_privacy_docs">
            Workspace privacy
          </More>
        }
        visual={
          <Mat>
            <Boundary />
          </Mat>
        }
      />

      <SnapSection id="start" labelledBy="start-h">
        <div className={p.close}>
          <span aria-hidden="true" style={{ display: "inline-flex", alignItems: "center", gap: 14, color: "var(--text-muted)" }}>
            <MarkdropMark size={44} />
            <Icon name="arrowRight" size={18} />
            <span className={s.tenantMark} style={{ width: 44, height: 44, borderRadius: 10, fontSize: 22 }}>
              A
            </span>
          </span>
          <h2 id="start-h" className={p.h2}>
            Put your name on it.
          </h2>
          <p className={p.lede}>Create a workspace, add your domain and invite your team. Or tell us what you need first.</p>
          <div className={p.actions}>
            <Ctas />
          </div>
          <p className={s.contact}>
            Or write to <a href={CONTACT_HREF}>{CONTACT}</a>
          </p>
        </div>
      </SnapSection>
    </SnapPage>
  );
}
