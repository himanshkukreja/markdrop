/** File-type glyph shared by the send and receive views. */

const KINDS: { test: RegExp; color: string; d: string }[] = [
  {
    test: /^image\/|\.(jpe?g|png|gif|svg|webp|heic|heif|avif|bmp|tiff?)$/i,
    color: "text-pink-400",
    d: "M2.25 15.75l5.159-5.159a2.25 2.25 0 013.182 0l5.159 5.159m-1.5-1.5l1.409-1.409a2.25 2.25 0 013.182 0l2.909 2.909M3.75 21h16.5A1.5 1.5 0 0021.75 19.5V4.5a1.5 1.5 0 00-1.5-1.5H3.75a1.5 1.5 0 00-1.5 1.5v15a1.5 1.5 0 001.5 1.5zm10.5-11.25h.008v.008h-.008V9.75zm.375 0a.375.375 0 11-.75 0 .375.375 0 01.75 0z",
  },
  {
    test: /^video\/|\.(mp4|mov|avi|mkv|webm|m4v)$/i,
    color: "text-purple-400",
    d: "M15.75 10.5l4.72-4.72a.75.75 0 011.28.53v11.38a.75.75 0 01-1.28.53l-4.72-4.72M4.5 18.75h9a2.25 2.25 0 002.25-2.25v-9a2.25 2.25 0 00-2.25-2.25h-9A2.25 2.25 0 002.25 7.5v9a2.25 2.25 0 002.25 2.25z",
  },
  {
    test: /^audio\/|\.(mp3|wav|ogg|flac|m4a|aac)$/i,
    color: "text-yellow-400",
    d: "M9 9l10.5-3m0 6.553v3.75a2.25 2.25 0 01-1.632 2.163l-1.32.377a1.803 1.803 0 11-.99-3.467l2.31-.66a2.25 2.25 0 001.632-2.163zm0 0V2.25L9 5.25v10.303m0 0v3.75a2.25 2.25 0 01-1.632 2.163l-1.32.377a1.803 1.803 0 01-.99-3.467l2.31-.66A2.25 2.25 0 009 15.553z",
  },
  {
    test: /zip|compressed|tar|\.(zip|tar|gz|tgz|rar|7z)$/i,
    color: "text-orange-400",
    d: "M20.25 7.5l-.625 10.632a2.25 2.25 0 01-2.247 2.118H6.622a2.25 2.25 0 01-2.247-2.118L3.75 7.5m6 4.125l2.25 2.25m0 0l2.25 2.25M12 13.875l2.25-2.25M12 13.875l-2.25 2.25M3.375 7.5h17.25c.621 0 1.125-.504 1.125-1.125v-1.5c0-.621-.504-1.125-1.125-1.125H3.375c-.621 0-1.125.504-1.125 1.125v1.5c0 .621.504 1.125 1.125 1.125z",
  },
];

const DOC = "M19.5 14.25v-2.625a3.375 3.375 0 00-3.375-3.375h-1.5A1.125 1.125 0 0113.5 7.125v-1.5a3.375 3.375 0 00-3.375-3.375H8.25m2.25 0H5.625c-.621 0-1.125.504-1.125 1.125v17.25c0 .621.504 1.125 1.125 1.125h12.75c.621 0 1.125-.504 1.125-1.125V11.25a9 9 0 00-9-9z";

export function isImage(name: string, mime: string): boolean {
  return /^image\/(jpeg|png|gif|webp|avif|bmp|svg\+xml)$/i.test(mime) ||
    /\.(jpe?g|png|gif|webp|avif|bmp)$/i.test(name);
}

export default function FileIcon({ name, mime, className = "w-5 h-5" }: { name: string; mime: string; className?: string }) {
  const kind = KINDS.find((k) => k.test.test(mime) || k.test.test(name));
  return (
    <svg className={`${className} ${kind?.color ?? (name.toLowerCase().endsWith(".pdf") ? "text-red-400" : "text-blue-400")}`}
      fill="none" stroke="currentColor" strokeWidth="1.6" viewBox="0 0 24 24" aria-hidden>
      <path strokeLinecap="round" strokeLinejoin="round" d={kind?.d ?? DOC} />
    </svg>
  );
}

/** "Direct" / "Relayed" pill — tells the user which path their bytes took. */
export function RouteBadge({ route }: { route: "direct" | "relay" | null }) {
  if (!route) return null;
  const relay = route === "relay";
  return (
    <span
      title={relay
        ? "No direct path between the two networks, so bytes pass through an encrypted relay. The relay can't read them."
        : "Bytes are going straight from one device to the other."}
      className={`inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[11px] font-medium ring-1 ${
        relay
          ? "bg-sky-500/10 text-sky-600 dark:text-sky-300 ring-sky-500/25"
          : "bg-emerald-500/10 text-emerald-600 dark:text-emerald-300 ring-emerald-500/25"
      }`}
    >
      <svg className="w-3 h-3" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
        {relay
          ? <path d="M4 12h4l2-5 4 10 2-5h4" />
          : <path d="M5 12h14m-5-5l5 5-5 5" />}
      </svg>
      {relay ? "Relayed" : "Direct"}
    </span>
  );
}
