# Changelog

Each `## <version>` section is also that version's release notes: `tools/release.mjs build`
puts it in the update feed, and fanout shows it after updating.

## 0.2.0 - 2026-11-12

- fanout updates itself. It looks for a new version shortly after starting and every
  six hours, downloads it in the background, and says so in the status bar. The new
  version is installed when you press "Restart to update" or the next time you close
  fanout. Settings has a switch for it and a "Check for updates" button.
- After an update, the status bar offers what is new.
- Adding a brand asks how its starter tabs open: side by side in one window (up to four)
  or one at a time as separate tabs.
- The tabs that are on screen together are shown as one group in the tab strip, outlined
  in the brand's colour and in the order of their panes.
- The group stays as you arranged it. A tab outside the group (clicked, a new tab, a link
  a page opens, Ctrl+Tab) now opens on its own, filling the page area, instead of pushing
  a page out of the group; click any tab of the group, or "Back to the group", to see it
  again. To put a tab in the group, right-click it and choose "Put in the group" (the
  menu says which tab it replaces); "Take out of the group" empties its pane. Closing a
  tab of the group leaves its pane empty. fanout remembers the tab on its own too.
- When a sleeping group comes back, the pane you clicked keeps the focus; it used to jump
  to the last pane.
- Sites now see fanout as it is (its own name and version, and the Electron engine it is
  built on) instead of a disguise as Chrome. Google refused to sign in with the disguise
  ("This browser or app may not be secure"); whether it accepts fanout now is still to
  be tried.
- When a site answers a page with an error, the address bar says so ("Site answered 403
  Forbidden"), so a page a site refused does not just stay empty.
- Tab names follow the page again. Closing a tab's rename box without changing the text,
  or with Escape, no longer fixes the name; emptying the box goes back to the page title.
  A tab that was stuck on the name "New tab" shows its page title again. A new tab that
  never got an address is removed when another tab takes its place, instead of staying
  in the tab strip.
- Markdown files are shown formatted in the preview: headings, bold and italics, lists
  and task lists, quotes, code, links and tables. "Source" shows the file as it is
  written. Selecting formatted text copies it without the Markdown signs, ready for a
  caption box; line breaks and hashtags stay as written. Pictures in a file are not
  loaded, and a web link opens as a new tab of the brand.
- Videos, pictures and sounds open under the file list when clicked: their size and shape
  (for example "1080 × 1920, vertical 9:16"), length and file size, with play, seek and
  volume. "Larger view" shows them over the pages; Esc goes back, and the arrow keys
  move to the next or previous file of the folder. Nothing plays until you press play. A
  file the built-in player cannot show says so and offers to open it in your usual app.
  Double-click still opens a file in your usual app.
- Smaller installer.

## 0.1.0 - 2026-11-12

First version.

- Brands with isolated sign-ins (one browser session per brand).
- Tabs per brand; any address; starter list of eight common sites.
- Split view: one to four pages side by side, resizable dividers; layout and open
  pages remembered per brand.
- File panel per brand: lazy tree, multi-select, native file drag onto any page.
- Text preview for `.txt` / `.md` and similar; selecting text copies it.
- Posted tracker: a mark per file and tab, set by hand; "hide posted" filter; after a
  drag, an offer to mark the file as posted to the focused tab.
- Memory: lazy loading, sleeping tabs (idle time and a cap), protection for uploads and
  unsaved typing, live memory in the status bar and tab tooltips.
- Close path that cannot hang (Electron 45 quit stalls after some sites).
- Windows installer (unsigned). CI workflow for Windows, macOS, Linux.
- 16 unit tests, 37 end-to-end checks, a memory measuring tool.

Decided: no automation of any kind; caption clipboard comes later.
