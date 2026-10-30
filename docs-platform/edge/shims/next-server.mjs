/**
 * next/server for the docs MCP route at the edge: only `after()` is used (report_problem forwards
 * to the feedback endpoint after the reply). The engine wrapper's `__hooks.after` hands the task to
 * the Worker's ctx.waitUntil (or just runs it on Node).
 */
/* global __hooks */
export function after(task) {
  __hooks.after(task);
}
