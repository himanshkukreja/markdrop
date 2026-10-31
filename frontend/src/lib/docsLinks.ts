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
  // Markdrop Guides (the guide builder at /guides; its own tab on docs.markdrop.in)
  guidesOverview: "/guides/overview",
  studioCreate: "/guides/create-a-site",
  studioAddress: "/guides/create-a-site#the-address",
  studioImport: "/guides/import-from-gitbook",
  studioImportReport: "/guides/import-from-gitbook#check-the-report",
  studioGithub: "/guides/github-sync",
  studioEditor: "/guides/editor",
  studioLocks: "/guides/editor#one-editor-per-page",
  studioPages: "/guides/pages-and-navigation",
  studioRedirects: "/guides/pages-and-navigation#redirects",
  studioHistory: "/guides/history",
  studioThemes: "/guides/themes",
  studioBrand: "/guides/brand-and-style",
  studioCustomCss: "/guides/brand-and-style#custom-css",
  studioPublish: "/guides/publishing",
  studioRestore: "/guides/publishing#restore-an-earlier-publish",
  studioReviews: "/guides/reviews",
  studioRoles: "/guides/members-and-roles",
  studioSiteRoles: "/guides/members-and-roles#a-different-role-on-one-guide",
  studioSettings: "/guides/site-settings",
  studioDomain: "/guides/site-settings#your-own-domain",
  studioAccess: "/guides/site-settings#who-can-read-it",
  studioAskAi: "/guides/ask-ai",
  studioInsights: "/guides/insights",
  studioInsightsOff: "/guides/insights#turn-it-off",
  studioReaders: "/guides/what-readers-get",
  studioSelfHost: "/guides/self-hosting",
  studioFaq: "/guides/faq",
} as const;

export type DocsTopic = keyof typeof DOCS_PAGES;
