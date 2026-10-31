import type { Metadata } from "next";
import ApiReferenceSection from "@/components/docs-sites/settings/ApiReferenceSection";

export const metadata: Metadata = { title: "API reference · Settings" };

/** Settings › API reference: the OpenAPI file the guide's API reference is generated from, and how it appears. */
export default function Page() {
  return <ApiReferenceSection />;
}
