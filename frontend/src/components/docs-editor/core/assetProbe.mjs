/**
 * "Is there a dark-theme version of this image?" asked once per address, a few at a time.
 *
 * Every figure in the editor looks for `x.dark.<ext>` beside its image. In the studio that address
 * is an API request (the asset preview redirect), and an imported page can hold a dozen figures:
 * asking for all of them at once, again on every visit, was enough to trip the API's per-address
 * limit, and the requests that came next (the next page, its lock) were refused before reaching
 * the API, which the browser reports as a network error. Here each address is asked about once
 * (the answer is kept for the session), at most `concurrency` at a time.
 *
 * `load(url)` resolves true when the image loads, false when it doesn't (it never rejects).
 */
export function createProbe(load, { concurrency = 2 } = {}) {
  const known = new Map(); // url → Promise<boolean>
  const queue = [];
  let running = 0;

  const pump = () => {
    while (running < concurrency && queue.length) {
      const { url, resolve } = queue.shift();
      running++;
      Promise.resolve()
        .then(() => load(url))
        .catch(() => false)
        .then((ok) => {
          running--;
          resolve(!!ok);
          pump();
        });
    }
  };

  return {
    /** Whether `url` loads (asked once; later calls share the first answer). */
    probe(url) {
      let p = known.get(url);
      if (!p) {
        p = new Promise((resolve) => queue.push({ url, resolve }));
        known.set(url, p);
        pump();
      }
      return p;
    },
    /** We know the answer already (an upload just put a file there). */
    set(url, ok) {
      known.set(url, Promise.resolve(!!ok));
    },
    /** How many are waiting or loading (tests). */
    get pending() {
      return queue.length + running;
    },
  };
}
