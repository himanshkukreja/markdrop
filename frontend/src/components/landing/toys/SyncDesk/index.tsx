import LazyIsland from "../../LazyIsland";
import View from "./View";
import { initialState } from "./model";

/**
 * Landing section 4: Sync Desk ("Edit in VS Code. The page keeps up."). Server component: the
 * heading, lead, stage and CTAs render as static HTML from `View(initialState)`; the game chunk
 * replaces it when the section nears the viewport.
 */
export default function SyncDesk() {
  return (
    <section id="sync-desk" aria-labelledby="sync-desk-title" className="w-full overflow-x-clip">
      <div className="mx-auto max-w-marketing px-4 py-16 sm:px-6 lg:py-24">
        <LazyIsland name="sync-desk">
          <View state={initialState} />
        </LazyIsland>
      </div>
    </section>
  );
}
