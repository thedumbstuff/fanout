# Architecture

Electron 45, plain JavaScript (ES modules), no framework, no bundler. One runtime
dependency, `electron-updater`; two dev dependencies, `electron` and `electron-builder`.

## Processes

```
main process (src/main)            owns all state and every web page
  |
  +-- interface (src/renderer)     one local page: rail, tabs, toolbar, file panel
  |     talks to main only through src/preload/preload.cjs (a fixed list of calls)
  |
  +-- one page per LIVE tab        a WebContentsView in the brand's session,
        no preload, sandboxed      placed by main exactly over a pane of the interface
```

The main process is the single source of truth. Whenever something the interface shows
may have changed it sends one `state` message (changes within 40 ms are merged); the
interface redraws only the elements whose data differs (`reconcile` in `dom.js`).

## Files

| File | Job |
|------|-----|
| `main/main.js` | start-up, the window, the state snapshot, the close path |
| `main/model.js` | saved shape: brands, tabs, panes, settings; repair on load (pure) |
| `main/store.js` | JSON file, written 400 ms after a change, tmp file + rename |
| `main/sessions.js` | one session per brand; permissions; upload watching; cookie flush |
| `main/tabs.js` | pages: load, attach to panes, sleep, close, crash, load errors |
| `main/sleeper.js` | which tabs to put to sleep; upload detection (pure) |
| `main/pages.js` | rules for every web page: navigation, popups, right-click menu |
| `main/files.js` | brand folder: list one directory, read start of a text file, watch |
| `main/pathjail.js` | no path can leave a brand's folder (pure) |
| `main/posted.js` | posted marks |
| `main/updates.js`, `notes.js` | new versions: check, download, install on restart or close ([updates](updates.md)) |
| `main/ipc.js` | everything the interface may ask for, with checks |
| `main/menus.js` | application menu (all shortcuts live here) and right-click menus |
| `main/urls.js`, `useragent.js` | address bar parsing; plain Chrome user agent (pure) |
| `renderer/app.js` | rail, tab strip, toolbar, panes, status bar |
| `renderer/files.js` | file tree, selection, drag out, posted marks |
| `renderer/preview.js` | text preview (Markdown formatted or as written), select to copy |
| `renderer/markdown.js` | Markdown to a plain tree for the preview (pure) |
| `renderer/dialogs.js` | brand dialog, memory settings |

## Brands and sessions

A brand's session is `session.fromPartition('persist:brand-<id>')`: its own cookies,
storage and cache on disk. That is the whole isolation mechanism. Deleting a brand
clears the session's storage and cache.

## Tabs, panes and pages

A tab is saved data: address, home address, title, icon. A brand has one to four
**panes** (`brand.panes`, drawing in `model.js`); each holds one tab id or nothing, and a
tab is in at most one pane. `brand.focus` is the pane the address bar and tab strip act
on. `splitX` and `splitY` are the divider positions. All of it is saved, so a brand
comes back with the same layout and the same pages.

A tab goes by its own name, else its page title, else its site, else "New tab"
(`tabLabel` in `model.js`; the state message carries it as `label`, so the tab strip
and the pane header cannot disagree). A name is saved only when the person changed
the text in the rename box to something the tab would not show anyway (`nameFor`);
otherwise the tab keeps following its page. A blank tab (no address, no name) lives
only in a pane: when another tab takes its pane or its pane is removed, the tab is
removed too. It stays while its brand is merely not on screen.

Only tabs in the panes of the brand on screen are attached to the window. The interface
measures each pane's body and reports the rectangles (`layout:bounds`); `tabs.js` places
the views on them. Pages draw above the interface, so when a dialog opens the interface
calls `layout:covered` and the views are detached until it closes.

Tabs a page opens itself (a link with `target=_blank`) are `temp`: shown in italics, not
a posting destination, not saved across a restart unless kept from the tab's menu.
`window.open` with a size, or of an empty window, is treated as a sign-in popup and
becomes a real child window sharing the brand's session.

## The rule: fanout never touches a page

No preload script in tabs, no `executeJavaScript`, no input events, no reading of page
content. What fanout does see: the page's title, icon and address; whether it is loading
or audible; request method and timing (for upload detection); the page's own
`beforeunload` answer when asked to close. Tests are the only place that script a page,
and only their own local pages.

Dragging a file out is `webContents.startDrag`: a native OS drag of real files. Where
it is dropped is between the person and the page.

## Text preview and Markdown

Clicking a text file shows its first 512 KB under the tree; selecting text copies it.
A `.md` or `.markdown` file is shown formatted, the way GitHub shows it, with one
difference on purpose: every line break inside a paragraph is kept, because a
caption's lines are part of the caption. **Source** shows the file as it is written; the
choice lasts while the app runs.

- `markdown.js` turns the text into a plain tree of objects (no DOM, no HTML strings,
  unit-tested). `preview.js` builds elements from it with `h()`, so every piece of the
  file reaches the page as a text node. The interface's content policy is unchanged.
- Raw HTML in a file is shown as text. Pictures are never loaded (no request leaves
  the app because of a file); their description is shown instead. A link is never
  followed inside the interface: an `http(s)` link opens as a new tab of the brand
  (`api.createTab`), any other link is plain text.
- What is copied is what the view shows: in the formatted view a selection is plain
  text (no Markdown signs) and "Copy the whole file" copies the text as it reads
  (`innerText`); in Source both copy the file as written.
- The text is not kept in a variable: switching views reads the file again. Closing
  the preview or changing brand drops the elements. Every search in the parser is
  indexed or bounded; a hostile 512 KB file is read in well under a second.

## Security

- Interface: sandboxed, context isolated, strict CSP (`script-src 'self'`), cannot navigate.
- Pages: sandboxed, no Node, no preload; may only navigate to http(s). A file dropped
  where a page does not take it does not replace the page.
- IPC handlers check the sender. File requests name a brand and a relative path;
  `pathjail.js` plus a real-path check refuse anything outside the brand's folder,
  including links that point out of it.
- Permissions: clipboard write and fullscreen are allowed; camera/microphone,
  notifications, location, clipboard read and opening other apps are asked once per
  brand and site; everything else is refused.

## Tests

- `npm test`: 30 unit tests of the pure modules (the Markdown parser included) and
  file access.
- `npm run smoke`: 54 checks of the real app (lazy loading, sleeping, unsaved-work
  refusal, file jail, preview copy, Markdown formatted and as written, links and
  pictures in Markdown, posted marks, new-tab links, load errors, split view, tab names,
  blank tabs, saving, deleting). Opens a window; screenshots in `.smoke/shots`.
- `npm run measure`: memory on real sites.
