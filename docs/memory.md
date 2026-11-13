# Memory

Every loaded tab is a full web page in its own process. Social sites are heavy: about
170 to 340 MB each, signed out. fanout's job is to make sure tabs you are not using
cost nothing.

## Measured (2026-11-12, Windows 11, Electron 45.3.0, `npm run measure`)

| State | Total |
|-------|-------|
| fanout open, no tabs | 317 MB |
| 6 tabs loaded (YouTube, LinkedIn, TikTok, Instagram, X, Facebook front pages) | 2,724 MB |
| 1 loaded, 5 asleep (after about 40 s) | 1,036 MB |

Per tab while loaded: YouTube 207, LinkedIn 167, TikTok 329, Instagram 192, X 229,
Facebook 210 MB. A tab's page process plus the processes of frames it embeds; the tab
tooltip and the status bar show these numbers live.

How to read them:

- The figures are working-set sums. Chromium processes share memory, so the sum
  overstates real use (at idle the private total was 204 MB against 322 MB summed).
- Sleeping does not return everything at once. A site's background workers linger for
  about 30 seconds after its page closes, then exit.
- About 230 MB of the "asleep" total is Chromium's audio and video-capture services,
  which start when a site first asks about devices and stay for the run.

## What keeps memory down

**Tabs**

- A tab is loaded the first time it is shown. Restoring a brand with ten tabs loads
  only the ones on screen.
- Only the tabs on screen are attached to the window; the rest are not drawn. While a
  tab outside the group is shown on its own, the group's pages are background tabs:
  detached, and put to sleep by the rules below. They load again when the group is
  shown.
- A background tab goes to sleep after 20 minutes unused (settable; 0 = never), and
  when more than 6 tabs are loaded (settable; 0 = no limit) the least recently used
  go first. Asleep means the page is destroyed and only address, title and icon are
  kept. It loads again when shown.
- A tab is never put to sleep while it is on screen, loading, playing sound, has its
  inspector open, is marked "keep awake", is uploading, or holds unsaved work.
- "Put to sleep" and "Put other tabs to sleep" are in the tab menu and the Memory menu.

**Not losing anything to save memory**

- *Uploads* (`sleeper.js`, `UploadActivity`): fanout sees only the method and timing of
  requests. A request that sends data and stays open 3 seconds is taken for an upload;
  the page counts as busy until 2 minutes after the last one, which covers the gaps
  between chunks of a large video. A site that holds a long POST open for other
  reasons is simply never put to sleep automatically.
- *Unsaved typing*: sleeping asks the page to close the way a browser does. A page with
  a half-written caption refuses (`beforeunload`), and is then left alone until it has
  been on screen again. When the person asks to close or sleep such a tab, they are
  asked "Leave page / Stay".

**Files**

- A directory is read only when opened, 5,000 entries at most, 300 rows drawn at a
  time. Closing a folder drops what was loaded under it. Switching brand drops
  everything loaded for the last one.
- Only directories open on screen are watched (64 at most); bursts of changes are
  reported once.
- The text preview reads at most 512 KB of a file and keeps it only in the page, not in
  a variable; closing the preview releases it. No thumbnails are generated.

**Media viewer**

- At most one media element exists. A video loads its metadata and first picture
  (`preload="metadata"`) and nothing more until play is pressed.
- Closing the viewer, clicking another file, showing a text file, switching brand or
  the file disappearing from its folder pauses the element, drops its source, calls
  `load()` and removes it: the player and its decoder are gone at once.
- The main process never reads a file whole: it streams 64 KB at a time as the
  player pulls, from the byte range asked for. The file handle closes when the player
  stops reading (Electron cancels the stream), and the smoke test checks that no file
  is left open after closing and after a file is deleted while shown. At most 32 are
  open at once.
- Pictures: one at a time, decoded off the main thread, never enlarged.

Measured (2026-11-13, Windows 11, Electron 45.3.0; the interface's own process,
private memory):

| | Interface |
|---|---|
| before any media | 21 to 34 MB |
| a 23 MB, 640 × 360 video playing | +30 MB |
| 2 s after closing it | about the same: see below |
| four different 24 MB videos played one after another, each closed | +28, +36, +38, +38 MB: it does not grow with each video |
| then 30 s / 60 s / 2 min / 3 min later | +36 / +29 / +22 / +18 MB, still falling |
| a 6000 × 4000 JPEG (300 KB) shown in the panel | +1 MB |
| a 6000 × 4000 PNG (16 MB) shown in the panel | +18 MB (about its file size), still held 2.5 s after closing |
| a 6000 × 4000 PNG (0.5 MB) | +35 MB working set, given back within 2 minutes of closing |

Of the 23 MB video, opening it read 5 MB and seeking to 90% read 3.5 MB more from
there; playing reads about 10 seconds ahead.

What stays after closing is not fanout's: Chromium keeps the bytes a player has
read in a cache inside the interface's process, so that opening the same file again
starts where it left off (seen: a new element on the same address asked only for
the part not read before). It holds about one video's read-ahead, does not add up
from video to video, and drains by itself over a few minutes. fanout cannot empty
it from outside, and it lives in one process that stays small; the decoder, the
element and the open file are released at once.

**Interface**

- No framework; elements are rebuilt only when their data changed. State updates from
  the main process are merged over 40 ms. Memory is polled every 5 seconds, and not at
  all while the window is hidden.

## What fanout cannot change

The cost of a loaded page belongs to the site. Four panes means four loaded pages on
screen at once: with the sites above, roughly 1 GB for the pages alone.
