"use client";

/**
 * The sign-off block in the editor (`:::signoff{#b-x person=… label=… options="A|B" lock=above}`):
 * the reader's card (SignoffCard) with, while it isn't signed, its settings in place — the label,
 * who signs (a search of the page's workspace), the options and "lock the section above". Its
 * text is edited below the label. Once signed it is read only (signoffLock.ts drops edits; the
 * server refuses them too), the person it names can change or clear their decision here, and a
 * workspace admin can remove it (recorded).
 */
import { useEffect, useRef, useState } from "react";
import { NodeViewContent, NodeViewWrapper, type ReactNodeViewProps } from "@tiptap/react";
import { Avatar, ConfirmDialog, Icon } from "@/components/ui";
import { joinOptions, signoffInfo, MAX_OPTIONS, MAX_OPTION_CHARS, MAX_LABEL_CHARS } from "@/lib/signoff.mjs";
import { SignoffCard } from "@/components/pages/signoff/SignoffCard";
import { useSignoffState, type SignoffStore } from "@/components/pages/signoff/store";
import { useHost } from "../host";
import { signoffLockKey } from "./signoffLock";

type Person = { id: string; name: string; avatar_url?: string | null };

export function SignoffView({ node, updateAttributes, editor, getPos, selected }: ReactNodeViewProps) {
  const host = useHost();
  const store = (host.pages?.signoffs ?? null) as SignoffStore | null;
  const attrs = (node.attrs.attributes ?? {}) as Record<string, string>;
  const info = signoffInfo(attrs);
  const state = useSignoffState(store, info.id);
  const signed = !!state?.option;
  const editable = !host.readOnly && !signed;
  const [removing, setRemoving] = useState(false);

  const set = (patch: Record<string, string | null>) => {
    const next: Record<string, string> = { ...attrs };
    for (const [k, v] of Object.entries(patch)) {
      if (v === null) delete next[k];
      else next[k] = v;
    }
    updateAttributes({ attributes: next });
  };

  const remove = () => {
    const pos = getPos();
    if (typeof pos !== "number") return;
    editor.view.dispatch(editor.state.tr.delete(pos, pos + node.nodeSize).setMeta(signoffLockKey, { allow: true }));
    setRemoving(false);
  };

  const person = store?.person(info.person);
  return (
    <NodeViewWrapper className={["dxe-signoff", signed && "is-signed", selected && "dxe-selected"].filter(Boolean).join(" ")} data-bid={info.id ?? undefined}>
      <SignoffCard
        inEditor
        info={info}
        state={state}
        person={person ? { name: person.name, avatar: person.avatar } : undefined}
        loading={!!store && !store.loaded}
        onSign={state?.can_sign && store && info.id ? async (o) => void (await store.sign(info.id!, o)) : undefined}
        labelSlot={
          editable ? (
            <input
              className="pb-signoff__label-input"
              value={attrs.label ?? ""}
              placeholder="Sign-off"
              maxLength={MAX_LABEL_CHARS}
              aria-label="What is being signed off"
              onChange={(e) => set({ label: e.target.value.replace(/[\n\r]+/g, " ") })}
            />
          ) : undefined
        }
        personSlot={editable ? <PersonPicker id={info.person} store={store} onPick={(p) => set({ person: p })} /> : undefined}
        settings={
          editable ? (
            <OptionsEditor
              options={info.options}
              lock={info.lock}
              onOptions={(list) => set({ options: joinOptions(list) })}
              onLock={(on) => set({ lock: on ? "above" : null })}
            />
          ) : null
        }
        actions={
          state?.can_remove && !host.readOnly ? (
            <button type="button" className="pb-signoff__remove" title="Remove this sign-off (workspace admins; it is recorded)" aria-label="Remove this sign-off" onClick={() => setRemoving(true)}>
              <Icon name="trash" size={15} aria-hidden />
            </button>
          ) : null
        }
      >
        <NodeViewContent className="pb-signoff__content" />
      </SignoffCard>
      {removing && (
        <ConfirmDialog
          open
          onClose={() => setRemoving(false)}
          onConfirm={remove}
          title="Remove this sign-off?"
          body={`${state?.signed_by?.name || "Someone"} signed off “${info.label}” (${state?.option}). Removing it unlocks the section and is recorded in the page's history.`}
          confirmLabel="Remove sign-off"
        />
      )}
    </NodeViewWrapper>
  );
}

/** Who signs: the person's chip, or a search of the page's workspace. */
function PersonPicker({ id, store, onPick }: { id: string | null; store: SignoffStore | null; onPick: (id: string) => void }) {
  const host = useHost();
  const search = host.pages?.people;
  const known = store?.person(id);
  const [open, setOpen] = useState(!id && !!search);
  const [q, setQ] = useState("");
  const [list, setList] = useState<Person[] | null>(null);
  const [active, setActive] = useState(0);
  const box = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open || !search) return;
    let live = true;
    const t = window.setTimeout(() => {
      search(q).then((p) => live && (setList(p), setActive(0))).catch(() => live && setList([]));
    }, 150);
    return () => {
      live = false;
      window.clearTimeout(t);
    };
  }, [open, q, search]);

  useEffect(() => {
    if (!open) return;
    const down = (e: PointerEvent) => {
      if (box.current && !box.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("pointerdown", down, true);
    return () => document.removeEventListener("pointerdown", down, true);
  }, [open]);

  const pick = (p: Person) => {
    store?.remember(p.id, { name: p.name, avatar: p.avatar_url ?? null });
    onPick(p.id);
    setOpen(false);
    setQ("");
  };

  if (!search) {
    return (
      <div className="pb-signoff__pick">
        <span className="pb-signoff__nobody" aria-hidden><Icon name="user" size={14} /></span>
        <span className="pb-signoff__who-text pb-meta">
          {id ? <>Waiting for <strong className="ph-mask">{known?.name || "a person"}</strong></> : "Sign-offs ask someone in the page's workspace: move the page into one to choose who."}
        </span>
      </div>
    );
  }
  return (
    <div className="pb-signoff__pick" ref={box}>
      <button type="button" className="pb-signoff__person" aria-haspopup="listbox" aria-expanded={open} onClick={() => setOpen((o) => !o)}>
        {id ? (
          <>
            <Avatar name={known?.name || "Someone"} src={known?.avatar || undefined} size="sm" />
            <span>
              Asks <strong className="ph-mask">{known?.name || "a person"}</strong> to sign
            </span>
          </>
        ) : (
          <>
            <span className="pb-signoff__nobody" aria-hidden><Icon name="userPlus" size={14} /></span>
            <span>Choose who signs</span>
          </>
        )}
        <Icon name="chevronDown" size={14} aria-hidden />
      </button>
      {open && (
        <div className="pb-signoff__pop" role="dialog" aria-label="Who signs this off">
          <input
            autoFocus
            value={q}
            placeholder="Search people in this workspace"
            aria-label="Search people"
            onChange={(e) => setQ(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Escape") {
                e.preventDefault();
                setOpen(false);
              } else if (e.key === "ArrowDown") {
                e.preventDefault();
                setActive((a) => Math.min(a + 1, (list?.length ?? 1) - 1));
              } else if (e.key === "ArrowUp") {
                e.preventDefault();
                setActive((a) => Math.max(a - 1, 0));
              } else if (e.key === "Enter" && list?.[active]) {
                e.preventDefault();
                pick(list[active]);
              }
            }}
          />
          <div className="pb-signoff__results ph-no-capture" role="listbox" aria-label="People">
            {(list ?? []).map((p, i) => (
              <button key={p.id} type="button" role="option" aria-selected={i === active} className="pb-signoff__result" onMouseDown={(e) => e.preventDefault()} onClick={() => pick(p)}>
                <Avatar name={p.name} src={p.avatar_url ?? undefined} size="sm" />
                <span className="ph-mask">{p.name}</span>
                {p.id === id && <Icon name="check" size={14} aria-hidden />}
              </button>
            ))}
            {list && !list.length && <span className="pb-signoff__none">No one matches</span>}
          </div>
        </div>
      )}
    </div>
  );
}

/** The options (chips: remove one, type to add) and "lock the section above". */
function OptionsEditor({ options, lock, onOptions, onLock }: { options: string[]; lock: boolean; onOptions: (o: string[]) => void; onLock: (on: boolean) => void }) {
  const [draft, setDraft] = useState("");
  const add = () => {
    const v = draft.trim();
    if (!v) return;
    onOptions([...options, v]);
    setDraft("");
  };
  return (
    <div className="pb-signoff__settings" contentEditable={false} suppressContentEditableWarning>
      <span className="pb-signoff__settings-label">Options</span>
      <div className="pb-signoff__chips">
        {options.map((o) => (
          <span key={o} className="pb-signoff__chip">
            {o}
            {options.length > 1 && (
              <button type="button" aria-label={`Remove “${o}”`} onClick={() => onOptions(options.filter((x) => x !== o))}>
                <Icon name="x" size={12} aria-hidden />
              </button>
            )}
          </span>
        ))}
        {options.length < MAX_OPTIONS && (
          <input
            className="pb-signoff__add"
            value={draft}
            maxLength={MAX_OPTION_CHARS}
            placeholder="Add an option"
            aria-label="Add an option"
            onChange={(e) => setDraft(e.target.value.replace(/\|/g, ""))}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                e.preventDefault();
                add();
              }
            }}
            onBlur={add}
          />
        )}
      </div>
      <label className="pb-signoff__lockopt">
        <input type="checkbox" checked={lock} onChange={(e) => onLock(e.target.checked)} />
        <Icon name="lock" size={13} aria-hidden /> Lock the section above once signed
      </label>
    </div>
  );
}
