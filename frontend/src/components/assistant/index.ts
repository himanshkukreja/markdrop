/** The one assistant, "Ask" everywhere — named after its scope (.work/assistant/SPEC.md, .work/briefs/ask-page.md). */
export { AssistantRoot } from "./AssistantRoot";
export { AssistantButton } from "./AssistantButton";
export { openAssistant, closeAssistant, toggleAssistant, useAssistant, useAssistantHere, useAssistantEditor, useAssistantReader, useHomeFocus, setAssistantThread, PERSIST_KEY } from "./store";
export type { AssistantHere, InsertFn, ReaderFn } from "./store";
