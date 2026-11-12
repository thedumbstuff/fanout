# Changelog

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
