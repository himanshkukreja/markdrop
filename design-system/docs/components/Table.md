# Table

Data rows with typed columns, selection highlight and a row action slot.

## What you provide

`columns` [{key, header, render(row), align, primary, width}], `rows`, `rowKey(row)`, `hover`, `compact`, `selected(row)`, `onRowClick`, `empty`, `caption`.

## Look

- Wrapped in `surface` + `border` + `radius-xl`; header row is `eyebrow` on `surface-inset`; body 14px `text-secondary`, primary cells `text` 500; numbers right-aligned, tabular.
- Hover `surface-hover`; selected `accent-soft`.

## Do / don't

- Put the overflow menu (RowMenu) in the last column, header empty.
- For the dashboard list prefer DocumentRow; Table is for admin and analytics data.
