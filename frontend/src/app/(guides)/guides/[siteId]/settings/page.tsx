import type { Metadata } from "next";
import SettingsIndex from "@/components/docs-sites/settings/SettingsIndex";

export const metadata: Metadata = { title: "Settings" };

/** /settings: on to a section (General, or the one an old #anchor names, like #people). */
export default function Page() {
  return <SettingsIndex />;
}
