import { VSCodeIcon as DSVSCodeIcon } from "@/components/ui";

/** The Visual Studio Code logo mark (compat wrapper over the DS one). Uses currentColor. Size with `className` or `size`. */
export default function VSCodeIcon({ className = "w-3.5 h-3.5", size }: { className?: string; size?: number }) {
  return <DSVSCodeIcon className={className} size={size} />;
}
