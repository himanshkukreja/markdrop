/** Class-name join usable in server components (the UI barrel's `cx` is a client reference there). */
export function cx(...a: Array<string | false | null | undefined | 0>): string {
  return a.filter(Boolean).join(" ");
}
