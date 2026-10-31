import SettingsShell from "@/components/docs-sites/settings/SettingsShell";

/** Every Settings section shares the site bar and the section nav (components/docs-sites/settings). */
export default function SettingsLayout({ children }: { children: React.ReactNode }) {
  return <SettingsShell>{children}</SettingsShell>;
}
