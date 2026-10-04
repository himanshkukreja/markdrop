/**
 * "iPhone · Safari", "Mac · Chrome" — how a recipient appears in the sender's
 * list. Derived from the recipient's own user agent and sent by the recipient
 * over the encrypted channel; the server never sees it. Coarse on purpose: it
 * tells the sender which of their contacts is which, nothing more.
 */
export function deviceLabel(ua: string = typeof navigator !== "undefined" ? navigator.userAgent : ""): string {
  const ipadOS = typeof navigator !== "undefined" && navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1;
  const os =
    /iPhone|iPod/.test(ua) ? "iPhone"
    : /iPad/.test(ua) || ipadOS ? "iPad"
    : /Android/.test(ua) ? (/Mobile/.test(ua) ? "Android phone" : "Android tablet")
    : /CrOS/.test(ua) ? "Chromebook"
    : /Mac OS X|Macintosh/.test(ua) ? "Mac"
    : /Windows/.test(ua) ? "Windows PC"
    : /Linux/.test(ua) ? "Linux"
    : "Device";
  const browser =
    /Edg\//.test(ua) ? "Edge"
    : /SamsungBrowser/.test(ua) ? "Samsung Internet"
    : /OPR\//.test(ua) ? "Opera"
    : /Firefox|FxiOS/.test(ua) ? "Firefox"
    : /CriOS|Chrome\//.test(ua) ? "Chrome"
    : /Safari\//.test(ua) ? "Safari"
    : "";
  return browser ? `${os} · ${browser}` : os;
}
