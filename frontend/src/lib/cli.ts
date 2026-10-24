/**
 * How to install the markdrop CLI (cli/README.md), shared by the share page's CLI guide and the
 * /mcp page. Plain data with no imports, so server components can read it too.
 */
export const CLI_INSTALL: Array<{ os: string; cmd: string }> = [
  { os: "macOS", cmd: "brew install himanshkukreja/tap/markdrop" },
  { os: "Linux and macOS", cmd: "curl -fsSL https://github.com/himanshkukreja/markdrop/releases/latest/download/install.sh | sh" },
  { os: "Windows (PowerShell)", cmd: "irm https://github.com/himanshkukreja/markdrop/releases/latest/download/install.ps1 | iex" },
];
