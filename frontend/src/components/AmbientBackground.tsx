/** Fixed, drifting blue aurora + dotted grid that sits behind page content. */
export default function AmbientBackground() {
  return (
    <div aria-hidden className="fixed inset-0 -z-10 overflow-hidden pointer-events-none">
      <div
        className="md-aurora absolute -top-40 -left-32 w-[36rem] h-[36rem] rounded-full blur-3xl opacity-30 dark:opacity-40 vscode:opacity-45"
        style={{ background: "radial-gradient(circle, rgba(37,99,235,0.5), transparent 65%)" }}
      />
      <div
        className="md-aurora-2 absolute top-1/4 -right-40 w-[40rem] h-[40rem] rounded-full blur-3xl opacity-25 dark:opacity-35 vscode:opacity-40"
        style={{ background: "radial-gradient(circle, rgba(14,165,233,0.4), transparent 65%)" }}
      />
      <div
        className="md-aurora absolute -bottom-32 left-1/3 w-[32rem] h-[32rem] rounded-full blur-3xl opacity-20 dark:opacity-30 vscode:opacity-35"
        style={{ background: "radial-gradient(circle, rgba(99,102,241,0.4), transparent 65%)" }}
      />
      <div className="absolute inset-0 md-grid" />
    </div>
  );
}
