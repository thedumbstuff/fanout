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
  only the ones in its panes.
- Only tabs in the panes on screen are attached to the window; the rest are not drawn.
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

**Interface**

- No framework; elements are rebuilt only when their data changed. State updates from
  the main process are merged over 40 ms. Memory is polled every 5 seconds, and not at
  all while the window is hidden.

## What fanout cannot change

The cost of a loaded page belongs to the site. Four panes means four loaded pages on
screen at once: with the sites above, roughly 1 GB for the pages alone.
