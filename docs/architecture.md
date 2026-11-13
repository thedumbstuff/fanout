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
| `main/media.js` | the viewer's files: address, byte ranges, content types, the streaming handler (no Electron) |
| `main/mediaprotocol.js` | registers the `fanout-media:` scheme before ready; serves it in the interface's session only |
| `main/pathjail.js` | no path can leave a brand's folder (pure) |
| `main/posted.js` | posted marks |
| `main/updates.js`, `notes.js` | new versions: check, download, install on restart or close ([updates](updates.md)) |
| `main/ipc.js` | everything the interface may ask for, with checks |
| `main/menus.js` | application menu (all shortcuts live here) and right-click menus |
| `main/urls.js` | address bar parsing (pure) |
| `renderer/app.js` | rail, tab strip, toolbar, panes, status bar |
| `renderer/files.js` | file tree, selection, drag out, posted marks |
| `renderer/preview.js` | text preview (Markdown formatted or as written), select to copy |
| `renderer/viewer.js` | media viewer: video, picture, sound; controls, facts, larger view |
| `renderer/markdown.js` | Markdown to a plain tree for the preview (pure) |
| `renderer/dialogs.js` | brand dialog, memory settings |

## Brands and sessions

A brand's session is `session.fromPartition('persist:brand-<id>')`: its own cookies,
storage and cache on disk. That is the whole isolation mechanism. Deleting a brand
clears the session's storage and cache.

Every site sees fanout as it is: Electron's own user agent ("... fanout/0.2.0
Chrome/156... Electron/45.3.0 Safari/537.36"), unchanged, in requests and in page
JavaScript alike. No user agent override, no rewritten request headers, no Chromium
switches; a unit test keeps it so. Pretending to be Chrome is what made Google refuse
sign-in (see gotchas). A site that refuses fanout with an error and no text would leave
an empty page, so the address bar says what the site answered (`Site answered 403
Forbidden`) whenever the page on screen got an error answer.

## Tabs, panes and the group

A tab is saved data: address, home address, title, icon. A brand has one to four
**panes** (`brand.panes`, drawings in `model.js`); each holds one tab id or nothing, and a
tab is in at most one pane. `splitX` and `splitY` are the divider positions.

With two or more panes, the tabs in them are the brand's **group**: pages the person set
up side by side. Only the person changes it:

- Selecting a tab outside the group (a click, the + button, a page's new-tab link,
  Ctrl+Tab) shows that tab **on its own** (`brand.solo`), filling the page area. The
  group's panes, focus and dividers stay as they are, and its pages are detached like
  any background tab. Selecting a tab of the group, or "Back to the group" over the solo
  tab, brings the group back with that tab's pane focused.
- A tab joins the group only from its right-click menu, "Put in the group" (into an
  empty pane, else in place of the focused pane's tab; the label names that tab), or
  from "Open a new tab here" in an empty pane. "Take out of the group" empties its pane
  and the tab stays a tab. Closing a tab of the group leaves its pane empty; closing the
  solo tab brings the group back.
- The lit layout button is the number of pages on screen: "one page" while a tab is on
  its own, and choosing it then changes nothing, so a stray click cannot undo the group.
  The group's own size carries a dashed mark. Two to four bring the group back at that
  size; when it grows, the solo tab takes the first new pane. One page while the group
  is on screen ends the group and keeps the focused tab, as before.
- Ctrl+Tab goes round the tab strip as it is drawn: the group pane by pane, then each
  other tab (`stepTab`).
- The tab strip keeps the group outlined in the brand's colour, dashed while a solo tab
  is in front of it; no tab of a waiting group is highlighted.

With one pane there is no group: selecting a tab puts it in that pane, as in a browser.

`brand.focus` is the pane the address bar acts on while the group is on screen, and it is
kept while a solo tab shows. `activeTabId` is the solo tab if there is one, else the
focused pane's tab (or none). `onScreen()` in `model.js` is the one answer to "which tabs
are on screen, in which order": `tabs.js` loads, attaches, places and sleeps pages by it,
and the state message carries it as `screen` (with `group` for the tab strip), so the
interface does not work it out again. All of it is saved: a brand comes back with the
same layout, the same pages, and the same tab on its own in front of the group. A saved
solo tab that is unknown, or also in a pane, is dropped on load.

A tab goes by its own name, else its page title, else its site, else "New tab"
(`tabLabel` in `model.js`; the state message carries it as `label`, so the tab strip
and the pane header cannot disagree). A name is saved only when the person changed
the text in the rename box to something the tab would not show anyway (`nameFor`);
otherwise the tab keeps following its page. A blank tab (no address, no name) lives
only on screen or in a pane: when it stops being the solo tab, another tab takes its
pane, its pane is removed or it is taken out of the group, the tab is removed too. It
stays while its brand is merely not on screen. In split view the + button makes a blank
solo tab, with the "Where does <brand> post?" page; it becomes a normal tab once it has
an address.

Only the tabs the selected brand has on screen are attached to the window. The interface
measures each box's body and reports the rectangles (`layout:bounds`, in `onScreen`
order); `tabs.js` places the views on them, and waits while the rectangles are for
another layout. Pages draw above the interface, so when a dialog opens the interface
calls `layout:covered` and the views are detached until it closes.

Clicking inside a page focuses its pane (the page's `focus` event). A page that has just
woken grabs the focus once by itself; that is not taken for a click, and the keyboard
goes back to the tab the address bar is on (see gotchas).

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

## Media viewer

Clicking a video, picture or sound shows it where text is previewed, under the tree:
the name, the facts that matter for posting (`1080 × 1920, vertical 9:16 · 0:42.3 ·
38.2 MB`; a picture has no length, a sound no pixel size), and for video and sound a bar
with play/pause, the position, the time, mute and volume. Nothing plays by itself:
a video loads its metadata and first picture (`preload="metadata"`) and shows that
picture until play is pressed. Clicking the picture plays or pauses it, Space too.
Double-clicking a row still opens the file in the system's own app.

**Larger view.** The button next to Close (or a double-click on the picture) puts
the same viewer over the tab strip, toolbar and page area, with the file panel
still beside it. Pages are native layers drawn above the interface, so they are
hidden while it is open, the way dialogs hide them: `cover()` in `dom.js` keeps one
set of everything covering the pages (a dialog, the large view) and tells the main
process (`layout:covered`) whether anything is left in it, so a dialog closing over
the large view does not uncover the pages. "Back to the pages" or Esc
returns; the left and right arrow keys step to the previous or next media file of
the same folder, in the tree's order (files hidden as posted are skipped), and the
tree's selection follows. Hiding the file panel (Ctrl+B) closes the large view,
which lives in the panel. The view is the `#preview` section itself made
`position: fixed`, so the media element is never moved or recreated.

**No browser controls, so no fullscreen.** Chromium's own controls carry a
fullscreen button (and fullscreen on double-click): the window would go fullscreen
with the video in the interface and the pages still drawn on top of it. Their menu
also offers download and picture-in-picture. The viewer therefore draws its own
controls; the element has no `controls` attribute, which leaves no way into HTML
fullscreen, and picture-in-picture and remote playback are switched off. The
larger view is the way to see a video big.

**How files are served.** The viewer loads `fanout-media://file/<brand id>/<path>`,
the path encoded as one segment (`mediaUrl` in `viewer.js`, `parseMediaUrl` in
`media.js`, unit-tested both ways). `mediaprotocol.js` registers the scheme as
`standard`, `secure` and `stream` before the app is ready (not `bypassCSP`, not
fetch, CORS or service workers) and answers it with `protocol.handle` on the
**default session only**, which is the interface's. Every brand's pages live in
the brand's own session, which has no handler for the scheme, so a page in a tab
cannot load it at all (`<video>`, `<img>` and `fetch` all fail there and nothing
reaches the handler; the smoke test checks it). The handler (`MediaServer` in
`media.js`) also refuses a request that names another initiator than the
interface's `file://`.

Each request goes through the same jail as the rest of the file panel: brand id
and relative path, `resolveInside` plus the real-path check (`realInside`), so `..`,
absolute paths and links pointing out of the folder are refused (403). Only regular
files of the media kinds are served; text files, folders and anything else are
refused, and text keeps going through `files:read`. It is not a general file server.

Nothing is read whole. The file is opened, and the response body is a stream that
reads 64 KB from the handle each time the player pulls, from the start of the byte
range asked for (`Range: bytes=N-`, `N-M` or `-N`; one range; a header that is
missing, malformed, multi-part or longer than 200 characters is ignored and the
whole file is streamed; a start beyond the end is 416). Responses carry
`Accept-Ranges`, `Content-Range`, `Cache-Control: no-store` and `nosniff`. The
handle is closed after the last byte, on a read error, and when the player stops
reading: Electron 45 cancels the stream when the request is dropped (seeking
elsewhere, or the element removed), which was checked before relying on it. At
most 32 handles are open at once; more is answered 503. `net.fetch` of a `file:`
address was not used: serving the bytes directly keeps the jail, the counting and
the closing in one place.

Measured on a 23 MB WebM: opening it read 5 MB of it (the player's own read-ahead
for the first picture, then it cancelled); seeking to 90% while paused asked for
`bytes=21331968-` onwards and nothing in between. The smoke test checks that a seek
far into the file is served by a range and that most of the file is never read.

**Formats.** The viewer shows what Chromium in Electron 45 shows, with no decoder,
library or conversion of fanout's own. A file it cannot show (the element reports
an error, or a video's picture cannot be decoded and only its sound would play)
gets a sentence saying so and an "Open in the default app" button; no spinner, no
empty box, and the element is let go. Verified on Windows 11 with Electron 45.3.0
(`tools/media-formats.mjs` makes a real file of each, puts it through the viewer
and plays it muted; re-run it after an Electron upgrade):

| Shown and played | Not shown (says so, offers the default app) | Not tested with a file |
|---|---|---|
| MP4: H.264, H.264 + AAC, HEVC (H.265), AV1 | TIFF | AVI, WMV, MPG/MPEG: the engine says it cannot play them |
| MOV and M4V names (H.264, HEVC; MOV served as `video/quicktime`) | | 3GP with H.263/AMR (what real 3GP files hold): engine says no |
| WebM: VP8, VP9, AV1; MKV: H.264 | | Ogg (Opus, Vorbis), raw `.aac`: engine says "probably" |
| M4A (AAC), MP3, WAV, FLAC | | AVIF, HEIC: nothing here writes them; Chromium decodes AVIF, not HEIC |
| JPEG, PNG, WebP, GIF, BMP, SVG | | |

HEVC plays here because this PC's graphics decode it; on a machine without HEVC
decoding, an iPhone video would show "This video cannot be played here."

**Pictures.** An image is an `<img>` with `decoding="async"`, scaled to fit and
never enlarged. An SVG is shown as an image, never put in the page, so a script in
it does not run (the smoke test checks that its request never arrives). fanout does
not shrink pictures itself: Chromium draws a large picture into a small box cheaply
on its own (a 6000 × 4000 JPEG shown in the panel cost the interface about 1 MB;
see [memory](memory.md)). Only one picture exists at a time, and it is let go when
the viewer closes or shows another file.

**What is safe.** File names reach the page only as text (`h()`), never as HTML.
The interface's content policy gained exactly `fanout-media:` for `img-src` and a
new `media-src fanout-media:`; nothing else.

## Security

- Interface: sandboxed, context isolated, strict CSP (`script-src 'self'`), cannot navigate.
- Pages: sandboxed, no Node, no preload; may only navigate to http(s). A file dropped
  where a page does not take it does not replace the page.
- IPC handlers check the sender. File requests name a brand and a relative path;
  `pathjail.js` plus a real-path check refuse anything outside the brand's folder,
  including links that point out of it.
- Media for the viewer comes over `fanout-media:`, answered only in the interface's
  session and only for media files inside the brand's folder (see Media viewer).
- Permissions: clipboard write and fullscreen are allowed; camera/microphone,
  notifications, location, clipboard read and opening other apps are asked once per
  brand and site; everything else is refused.

## Tests

- `npm test`: 44 unit tests of the pure modules (the Markdown parser and the group
  included), file access, the media server (address, ranges with hostile values,
  content types, the jail, closing on cancel, the open-file cap), and a guard that
  nothing rewrites what sites see.
- `npm run smoke`: 77 checks of the real app (the user agent sites see, a silent
  refusal shown, lazy loading, sleeping, unsaved-work
  refusal, file jail, preview copy, Markdown formatted and as written, links and
  pictures in Markdown, posted marks, the media viewer (a video's facts and playing,
  seeking by ranges, the larger view hiding the pages, a picture, an SVG's script, a
  sound, a file that cannot be played, a tab's page refused the address, closing and a
  deleted file letting go), new-tab links, load errors, split view, the group
  and solo tabs, tab names, blank tabs, saving and loading, deleting). Opens a window,
  muted; makes its media on the spot (`tools/media-fixtures.mjs`); screenshots in
  `.smoke/shots`.
- `node node_modules/electron/cli.js tools/media-formats.mjs`: which formats the viewer
  shows on this machine (opens a window, muted).
- `npm run measure`: memory on real sites.
