export default function LandingFooter() {
  const cols: { heading: string; links: { label: string; href: string; external?: boolean }[] }[] = [
    {
      heading: "Product",
      links: [
        { label: "New document", href: "/new" },
        { label: "Upload a file", href: "/upload" },
        { label: "Send a file", href: "/share" },
        { label: "Dashboard", href: "/dashboard" },
      ],
    },
    {
      heading: "Developers",
      links: [
        { label: "VS Code extension", href: "https://marketplace.visualstudio.com/items?itemName=HimanshuKukreja.markdrop", external: true },
        { label: "GitHub", href: "https://github.com/himanshkukreja/markdrop", external: true },
        { label: "File-sharing docs", href: "https://github.com/himanshkukreja/markdrop/blob/main/FILESHARE.md", external: true },
      ],
    },
  ];

  return (
    <footer className="mt-8 border-t border-gray-200 dark:border-gray-800 pt-10 pb-8">
      <div className="flex flex-col sm:flex-row gap-8 sm:justify-between">
        <div className="max-w-xs">
          <a href="/" className="text-xl font-bold tracking-tight text-gray-900 dark:text-white">
            mark<span className="text-blue-500 dark:text-blue-400">drop</span>
          </a>
          <p className="mt-3 text-sm text-gray-500 dark:text-gray-400">
            Docs and files as links that render. Write with no account, upload with a free one, open in any browser.
          </p>
        </div>
        <div className="flex gap-12">
          {cols.map((col) => (
            <div key={col.heading}>
              <h4 className="text-xs font-semibold uppercase tracking-wide text-gray-400 dark:text-gray-500">{col.heading}</h4>
              <ul className="mt-3 space-y-2">
                {col.links.map((l) => (
                  <li key={l.label}>
                    <a
                      href={l.href}
                      {...(l.external ? { target: "_blank", rel: "noopener noreferrer" } : {})}
                      className="text-sm text-gray-600 dark:text-gray-400 hover:text-blue-600 dark:hover:text-blue-400 transition-colors"
                    >
                      {l.label}
                    </a>
                  </li>
                ))}
              </ul>
            </div>
          ))}
        </div>
      </div>
      <div className="mt-10 pt-6 border-t border-gray-200 dark:border-gray-800 text-xs text-gray-400 dark:text-gray-600">
        © {new Date().getFullYear()} Markdrop · MIT licensed · Made for people who hate friction.
      </div>
    </footer>
  );
}
