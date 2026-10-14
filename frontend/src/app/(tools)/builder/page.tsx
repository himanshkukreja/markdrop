import type { Metadata } from "next";
import BuilderApp from "./BuilderApp";

export const metadata: Metadata = {
  title: "README builder · Markdrop",
  description: "Assemble a README from ready-made sections, see it render, and publish it as a link.",
};

export default function BuilderPage() {
  return <BuilderApp />;
}
