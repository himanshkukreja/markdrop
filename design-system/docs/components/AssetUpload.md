# AssetUpload

Drop-or-pick upload for a favicon or logo, with an instant local preview.

## What you provide

`label`, `hint`, `value` (hosted URL | null), `shape` square | wide, `onUpload(file) → Promise`, `onClear`, `disabled`.

## Look

- Dashed `border-strong` zone on `surface`, `radius-xl`; turns `border-focus` + `accent-soft` while dragging; thumb on `surface-inset`.

## Do / don't

- Uploads, never URL fields — hosting stays ours.
