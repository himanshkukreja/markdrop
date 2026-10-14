import { redirect } from "next/navigation";

/** /settings has no page of its own: a server redirect (no flash) to the account settings. */
export default function SettingsIndex() {
  redirect("/settings/account");
}
