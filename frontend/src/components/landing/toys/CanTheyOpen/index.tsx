import LazyIsland from "../../LazyIsland";
import View, { TITLE_ID } from "./View";
import { initialState } from "./model";

/**
 * Landing section 8 of 8, "Can they open it?": the last section before the footer. The server
 * renders the full first frame (heading, lead, both lanes, score and the CTAs as real links); the
 * game loads when the section nears the viewport and takes over the same markup.
 */
export default function CanTheyOpen() {
  return (
    <section id="can-they-open" aria-labelledby={TITLE_ID}>
      <LazyIsland name="can-they-open">
        <View state={initialState} />
      </LazyIsland>
    </section>
  );
}
