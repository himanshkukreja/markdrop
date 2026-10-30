/**
 * Where each feature is explained on docs.markdrop.in. The app's "Read more" links (ReadMore) go
 * through this map, and `npm run docs:check` fails when an entry points at a page or heading that
 * doesn't exist: moving a docs page means updating it here.
 */
export const DOCS_PAGES = {
  // Get started
  accounts: "/get-started/accounts",
  // Documents
  writing: "/documents/writing",
  addresses: "/documents/addresses",
  editSecret: "/documents/edit-key",
  passwordsAndExpiry: "/documents/passwords-and-expiry",
  linkPreviews: "/documents/link-previews",
  readmeBuilder: "/documents/readme-builder",
  // Files
  supportedTypes: "/files/supported-types",
  fileLimits: "/files/limits",
  largeUploads: "/files/large-uploads",
  htmlPages: "/files/html-pages",
  websites: "/files/websites",
  versions: "/files/replace-and-versions",
  videoAndAudio: "/files/video-and-audio",
  // Sharing and access
  whoCanOpen: "/sharing/who-can-open",
  shareWithPeople: "/sharing/share-with-people",
  requestAccess: "/sharing/request-access",
  encryption: "/sharing/end-to-end-encryption",
  // Send (peer to peer)
  sendFiles: "/share/send-files",
  sendTroubleshooting: "/share/troubleshooting",
  // Workspaces
  createWorkspace: "/workspaces/create",
  members: "/workspaces/members-and-roles",
  folders: "/workspaces/folders",
  shareFolder: "/workspaces/share-a-folder",
  branding: "/workspaces/branding",
  customDomain: "/workspaces/custom-domain",
  workspacePrivacy: "/workspaces/privacy",
  previewAs: "/workspaces/privacy#check-what-someone-else-sees",
  domainSignIn: "/workspaces/sign-in-on-your-domain",
  // Analytics
  analytics: "/analytics/overview",
  documentAnalytics: "/analytics/documents-and-pdfs",
  videoAnalytics: "/analytics/video-and-audio",
  liveViewers: "/analytics/live",
  weeklyEmail: "/analytics/weekly-email",
  whatGetsCounted: "/analytics/what-gets-counted",
  // AI apps, CLI, VS Code
  aiOverview: "/ai/overview",
  connectAiApp: "/ai/hosted-mcp",
  localMcp: "/ai/local-mcp",
  cliInstall: "/cli/install",
  vscode: "/vscode/sync",
  // Account
  apiTokens: "/account/api-tokens",
  connectedApps: "/account/connected-apps",
  limits: "/account/limits",
  apiReference: "/api/overview",
  // Docs Studio (the docs-site builder at /docs-studio; its own tab on docs.markdrop.in)
  docsStudio: "/docs-studio/overview",
  studioCreate: "/docs-studio/create-a-site",
  studioAddress: "/docs-studio/create-a-site#the-address",
  studioImport: "/docs-studio/import-from-gitbook",
  studioImportReport: "/docs-studio/import-from-gitbook#check-the-report",
  studioGithub: "/docs-studio/github-sync",
  studioEditor: "/docs-studio/editor",
  studioLocks: "/docs-studio/editor#one-editor-per-page",
  studioPages: "/docs-studio/pages-and-navigation",
  studioRedirects: "/docs-studio/pages-and-navigation#redirects",
  studioHistory: "/docs-studio/history",
  studioThemes: "/docs-studio/themes",
  studioBrand: "/docs-studio/brand-and-style",
  studioCustomCss: "/docs-studio/brand-and-style#custom-css",
  studioPublish: "/docs-studio/publishing",
  studioRestore: "/docs-studio/publishing#restore-an-earlier-publish",
  studioReviews: "/docs-studio/reviews",
  studioRoles: "/docs-studio/members-and-roles",
  studioSiteRoles: "/docs-studio/members-and-roles#a-different-role-on-one-site",
  studioSettings: "/docs-studio/site-settings",
  studioDomain: "/docs-studio/site-settings#your-own-domain",
  studioAccess: "/docs-studio/site-settings#who-can-read-it",
  studioAskAi: "/docs-studio/ask-ai",
  studioReaders: "/docs-studio/what-readers-get",
  studioSelfHost: "/docs-studio/self-hosting",
  studioFaq: "/docs-studio/faq",
} as const;

export type DocsTopic = keyof typeof DOCS_PAGES;
