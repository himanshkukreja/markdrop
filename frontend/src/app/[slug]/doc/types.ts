/** DocumentView's props. The contract `page.tsx` and the tenant route render with — unchanged. */
export interface DocumentViewProps {
  slug: string;
  title: string | null;
  content: string;
  url: string;
  createdAt: string;
  expiresAt: string | null;
  views?: number;
  editSecret?: string;
  isPasswordProtected?: boolean;
  /**
   * Which gate the anonymous server render hit, if any. "password" is a shared
   * secret anyone may type; "signin" means the document is not public and the
   * reader has to be somebody. They are different questions and must not be
   * asked with the same box.
   */
  gate?: "password" | "signin" | null;
  /** Absolute sign-in URL. Set only on a workspace domain, which has no
   *  `/login` of its own. */
  signInUrl?: string | null;
  isOwned?: boolean;
  syncedWithVscode?: boolean;
  /** `content` is a sealed envelope; the key is in the URL fragment, not here. */
  encrypted?: boolean;
  /** Only ever set on a workspace's own domain. "minimal" behaves like "full" (D24). */
  viewerChrome?: "full" | "minimal" | "none";
}
