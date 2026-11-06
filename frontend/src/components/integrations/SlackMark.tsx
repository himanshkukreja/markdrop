/** Slack's mark (four colours), drawn inline: the design system has no brand icons. */
export function SlackMark({ size = 20, className }: { size?: number; className?: string }) {
  return (
    <svg width={size} height={size} viewBox="0 0 54 54" aria-hidden focusable="false" className={className}>
      <path fill="#36C5F0" d="M19.7 0a5.4 5.4 0 1 0 0 10.8h5.4V5.4A5.4 5.4 0 0 0 19.7 0m0 14.4H5.4a5.4 5.4 0 1 0 0 10.8h14.3a5.4 5.4 0 1 0 0-10.8" />
      <path fill="#2EB67D" d="M54 19.8a5.4 5.4 0 1 0-10.8 0v5.4h5.4a5.4 5.4 0 0 0 5.4-5.4m-14.4 0V5.4a5.4 5.4 0 1 0-10.8 0v14.4a5.4 5.4 0 1 0 10.8 0" />
      <path fill="#ECB22E" d="M34.2 54a5.4 5.4 0 1 0 0-10.8h-5.4v5.4a5.4 5.4 0 0 0 5.4 5.4m0-14.4h14.4a5.4 5.4 0 1 0 0-10.8H34.2a5.4 5.4 0 1 0 0 10.8" />
      <path fill="#E01E5A" d="M0 34.2a5.4 5.4 0 1 0 10.8 0v-5.4H5.4A5.4 5.4 0 0 0 0 34.2m14.4 0v14.4a5.4 5.4 0 1 0 10.8 0V34.2a5.4 5.4 0 1 0-10.8 0" />
    </svg>
  );
}
