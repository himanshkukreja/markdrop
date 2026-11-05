---
title: Properties and views
description: Give a folder's pages typed properties like Status, Owner and Target date, edit them under each page's title, and see the folder as a table or a board.
updated: 2026-11-05
prerequisites: [/pages/overview]
keywords: [properties, page properties, database, table, board, kanban, status, owner, select, multi-select, person, date, link, number, checkbox, filter, sort, group, views, saved views, set_folder_properties, list_folder_pages, set_page_properties, props]
---

A workspace folder can work like a database. Give it properties such as **Status**, **Owner** and **Target date**, and every page in the folder gets them, shown under the page's title. Then open the folder as a **table** or a **board** to see and change them all at once.

## Add properties to a folder

1. Open a page in the folder, or the folder itself in your workspace.
2. Under the page's title, choose **Add a property**. In the folder's table, choose **+** at the end of the header row.
3. Type a name, then pick a type.

Every page filed directly in the folder now has the property. Sub-pages are part of their page, so they don't get properties of their own.

Workspace members and admins can add, rename and remove properties. Viewers see them but can't change them.

## Property types

| Type | Holds | Example |
| --- | --- | --- |
| Select | One option, each with a colour | Status: Proposed, In build, In QA, Released |
| Multi-select | Several options | Area: Search, Billing |
| Person | A member of the workspace | Owner, Approver |
| Date | A day | Target date |
| Text | Any text, up to 2,000 characters | Feature ID: SL-142 |
| Link | Web addresses, or pages in the workspace | Related |
| Number | A number | Story points |
| Checkbox | Yes or no | Signed off |

A Person must be a member of the page's workspace. A Link to a Markdrop page shows its title only to people who can open that page. Everyone else sees **Locked page**.

To change a property, select its name. You can rename it, change its type, add options and give them colours, or remove it.

Removing a property never deletes anything from your pages. Each page keeps its value, hidden, and the value comes back if you add the property again with the same name. Removing an option works the same way: pages that use it keep it.

## Set a page's values

Select a value under the page's title to change it. Select options come with a search box. If you're a member, you can type a new option and create it there. Person shows the workspace's members. Date opens a calendar, and you can also type `2026-11-20`. Link takes a pasted address or a page you search for.

Anyone who can edit the page can set its values. They save with the page, so they appear in [version history](/pages/history) like any other edit. Readers see only the properties that have a value.

## See the folder as a table or a board

In your workspace, open the folder. Above its items, choose a view:

- **List** shows everything in the folder, files included.
- **Table** shows one row per page and one column per property. The header and the title column stay in place as you scroll. Drag the edge of a column header to make the column wider. Select a cell to change its value.
- **Board** shows one column per option of a Select, such as Status. Drag a card to another column to change its value. On a phone or tablet, tap a card to open the page, or press and hold it, then drag. Pages without a value are in **No Status** at the end. Until the folder has a Select property, the board shows every page in one **All pages** column, with a button to add one.

Use **Filter**, **Sort** and **Group** above the view. Select a column's name for quick actions: sort, filter, group by it, hide it, or change the property. **Properties** chooses which columns show. **New page** at the end of a table, or **New** at the bottom of a board column, makes a page in the folder. The new page starts with that group's value.

### Saved views

Members can save up to 20 views per folder. Choose **+** after the views to add one. Changes to a saved view's filters, sorts, groups and columns save as you make them, and everyone in the workspace sees the same views.

Choose an open saved view's name to rename, duplicate or delete it. Viewers can still filter and sort for themselves. Their changes aren't saved.

### Only what you can open

A view lists only the pages you can open. Private pages of other people don't appear, not even for admins, and a column never shows the title of a page you can't open.

## On your workspace's domain

On your workspace's own domain, a folder with properties lists each page with its values, read only. Visitors who aren't members of the workspace don't see people's names.

## From an AI app

With the [Markdrop MCP server](/ai/tools), an assistant can set all of this up and keep it current:

- `set_folder_properties` defines a folder's properties, and optionally its saved views.
- `set_page_properties` with `properties` sets a page's values, using a property's key or its name. `null` clears a value.
- `create_page` with `properties` creates a page with its values in one step.
- `list_folder_pages` lists the folder's pages with their values, with filters and sorting.
- `get_page` returns a page's values in `properties` and `property_values`.

For example, a PRD folder set up as a database:

```json
{
  "workspace": "Senseloaf",
  "folder": "product-hub/02-prds",
  "properties": [
    { "name": "Status", "type": "select", "options": ["Proposed", "In build", "In QA", "Released"] },
    { "name": "Owner", "type": "person" },
    { "name": "Approver", "type": "person" },
    { "name": "Target date", "type": "date" },
    { "name": "Feature ID", "type": "text" },
    { "name": "Related", "type": "link" }
  ],
  "views": [{ "name": "By status", "type": "board", "group": "status" }]
}
```

Then `set_page_properties(document, properties: {"Status": "In build", "Owner": "<user id>", "Target date": "2026-11-20"})` sets a PRD's values. User ids come from `list_workspace_members`. A value that doesn't fit is refused with the reason, such as an option the property doesn't have or a person who isn't a member.

## In the Markdown

Values live in the page's front matter, on one `props:` line:

```markdown
---
props: {status: "In build", owner: "<user id>", target_date: "2026-11-20", feature_id: "SL-142"}
---
```

The keys are the properties' keys, which are their names in lower case with `_` for spaces. Export, copies and templates carry the line with the page. A [template](/pages/templates) that a folder uses as its default can hold default values, which new pages there start with.

## Limits

- 30 properties per folder, and 50 options per Select or Multi-select.
- 20 saved views per folder.
- Up to 20 options in a Multi-select value and 20 links in a Link value.
- A table or board shows the 500 most recently edited pages.
