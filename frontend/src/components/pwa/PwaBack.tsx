"use client";

import { useRouter } from "next/navigation";
import { Icon } from "@/components/ui";
import { usePwa } from "./PwaProvider";

/**
 * Back, over a full-screen document, page or file in the installed app. A standalone window has no
 * browser back button, and the immersive reader shows only "Show details", so without this the only
 * way out was closing the app. Browsers keep their own Back: shown only when standalone.
 *
 * It sits in the corner opposite "Show details" (same edge), so the two never overlap, and leaves
 * with the video player's controls like that chip does (`className`).
 */
export default function PwaBack({ edge = "bottom", className }: { edge?: "bottom" | "top"; className?: string }) {
  const { standalone } = usePwa();
  const router = useRouter();
  if (!standalone) return null;
  const back = () => {
    // Opened from inside the app: go back there. Opened straight from a link (a fresh window): home.
    if (window.history.length > 1) router.back();
    else router.push("/");
  };
  return (
    <button type="button" onClick={back} aria-label="Back"
      className={["no-print md-immersive md-immersive--quiet", edge === "top" ? "md-immersive--tl" : "md-immersive--bl", className]
        .filter(Boolean).join(" ")}
      data-testid="pwa-back">
      <Icon name="arrowLeft" />
    </button>
  );
}
