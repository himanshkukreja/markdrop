import { redirect } from "next/navigation";

type Props = { params: Promise<{ wsId: string }> };

/** The old Company home: company-wide content lives in General, the workspace's default team (nav redesign 2026-11-10). */
export default async function Page({ params }: Props) {
  const p = await params;
  redirect(`/w/${encodeURIComponent(decodeURIComponent(p.wsId))}/teams/general`);
}
