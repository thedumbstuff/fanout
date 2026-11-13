# Gotchas

Things that cost time once and should not cost it twice.

## Electron 45 never finishes quitting after some sites

Load `https://www.instagram.com/` in a `WebContentsView` and quit: `before-quit`,
`will-quit` and `quit` all fire, every child process exits, and the main process stays
alive for good. It reproduces in a 20-line Electron app with none of fanout's code.
`app.quit()`, `app.exit()`, `process.exit()` and a watchdog in a worker thread all hang
the same way. YouTube and example.com do not trigger it; the cause inside Electron is
not known.

So fanout does not use Electron's quit. Closing the window runs `ctx.shutdown` in
`main.js`: destroy the pages, write the two JSON files, flush every brand's cookies and
site storage (`BrandSessions.flushAll`; Chromium otherwise saves them on a delay of up
to 30 seconds), then `process.kill(process.pid, 'SIGKILL')`. `before-quit` is turned
into "close the window", so the menu, the dock and system shutdown take the same path.

Re-test when upgrading Electron: if a plain app that loads Instagram quits cleanly,
the normal quit can come back.

## A failed page load is followed by "did-finish-load"

Order of events for an address that cannot be reached: `did-fail-load`, then
`did-finish-load` (for Chromium's own blank error page). Clearing the error on
`did-finish-load` wipes it immediately. `tabs.js` clears it on the next
`did-start-navigation` in the main frame instead.

## The clipboard is asynchronous in Electron 45

`clipboard.readText()` and `writeText()` return promises. Older examples that use the
return value directly get a Promise object.

## Top-level await in an Electron entry file waits forever

Electron does not become ready until the entry file has finished loading, so
`await app.whenReady()` at the top level of the entry never resolves. Use
`app.whenReady().then(...)`. `main.js`, `tools/smoke.mjs` and `tools/make-icon.mjs`
are written that way.

## Closing the last window quits a script

A tool that opens and closes windows in sequence (`make-icon.mjs`) needs an empty
`window-all-closed` listener, or Electron quits after the first.

## Pages draw above the interface

A page is a native layer over the window, so nothing in the interface's HTML can
appear on top of it. Dialogs hide the pages (`layout:covered`); menus are native
(`menus.js`); messages go in the status bar.

The same goes for pictures: `capturePage()` of the interface has an empty hole
where each page is. `tools/screenshots.mjs` captures the interface and every page
and lays the pages over it at their rectangles.

## A covered window gives capturePage an old picture

A window under other windows counts as hidden to Chromium (Windows 11), which stops
drawing it; `capturePage()` then returns the last frame drawn. Once this gave a
picture of the interface as it had been a minute earlier, under pages as they were
now. `tools/screenshots.mjs` turns background throttling off for every web contents it
runs (they keep drawing while covered), and its `--check` changes the interface under
a cover to prove the picture follows. A tool must never capture the screen itself to
compare: when the window is not where expected, that is a picture of the owner's own
screen. The check captures fanout's window only (`getUserMedia` on its media source).

## A page grabs the focus once when it wakes

Every page fanout creates for a tab (when the tab wakes) takes the keyboard focus by
itself once, as it gets ready, and fires `focus` (Windows 11, Electron 45). When several
wake together (a group coming back, a brand switch) they
grab it in turn, so the last pane ended up focused instead of the tab that was clicked.
`tabs.js` ignores a page's first `focus` within 3 seconds of waking and gives the focus
back to the active tab. That hand-back has to happen just after the event: a
`contents.focus()` made inside the handler did not take.

## Running Electron from PowerShell

`node_modules\electron\dist\electron.exe tools/smoke.mjs` returns at once from
PowerShell (it is a windowed program) and its output is lost; the test keeps running
on its own. `npm run smoke`, or `node node_modules/electron/cli.js tools/smoke.mjs`,
waits and passes the output through. The exit code was 1 with every check passing
(most likely because the close path ends the process itself): go by the test's own tally.

## The media scheme must exist before the app is ready

`protocol.registerSchemesAsPrivileged` works only before `ready`. `main.js` gets it
in time by importing `mediaprotocol.js` first. A tool that loads `main.js` with a
dynamic `import()` (the smoke test, the memory and format tools: they first pick a
throwaway profile) is too late, because Electron does not wait for that import before
it becomes ready. Such a tool imports `../src/main/mediaprotocol.js` statically at its
top; the module throws a clear error if it is loaded after `ready`.

## Chromium's own video controls would break the screen

With `controls`, a video gets Chromium's fullscreen button and fullscreen on
double-click. In fanout the window would go fullscreen with the video in the
interface while the pages, native layers, stay drawn over it. The viewer uses its own
controls (no `controls` attribute: no way into fullscreen) and its larger view hides
the pages like a dialog.

## Media memory that stays after closing is Chromium's cache

After a video element is gone (paused, source dropped, `load()`, removed), the
interface's memory does not fall at once: Chromium keeps the bytes the player read
in a per-process cache and reuses them if the same file is opened again (the new
player asks only for the part it has not read). It drains by itself over a few
minutes and does not grow from one video to the next. Judge a leak by what fanout
holds (`ctx.media.openStreams`, media elements in the page), not by the number a
second after closing. Measurements in [memory](memory.md).

## Making test media

- WebCodecs (`VideoEncoder`, `AudioEncoder`) does not exist on `about:blank`: it needs
  a secure page. The fixtures' hidden window loads a small `file://` page instead.
- MediaRecorder works anywhere but in real time, and its H.264 string matters: level
  3.0 (`avc1.42E01E`) cannot hold 1080 × 1920; the smoke test records with
  `avc1.640028` (High 4.0). Its WebM and MP4 files have a length in Electron 45.
- A 23 MB file that a player can seek in is made with WebCodecs (VP8, faster than real
  time) and written by `webm()` in `tools/media-fixtures.mjs` with its length and an
  index before the clusters; noise in half of each frame keeps it large.
- WebCodecs here cannot encode AAC, so a raw `.aac` file is not tested.

## A covered window pauses a silent video

Windows tells Chromium when another window covers fanout's, and Chromium then treats
the page as hidden: a video without sound pauses (and does not start). In the app
that is harmless, since nobody is watching. In the smoke test, with the owner working
in other windows, "it plays" failed once for that reason only. The media checks run
with `setBackgroundThrottling(false)` on the interface, which Electron documents as
also keeping the page "visible", and restore it after.

## A screenshot can be one frame behind

`webContents.capturePage()` returns the last frame drawn. Right after the large view
opened, it returned the window as it was before. The smoke test's `shot()` calls
`invalidate()` and waits a moment first.

## `h()` skips false

`h('img', { draggable: false })` does nothing: `h()` leaves out `false`, `null` and
`undefined` props, so a boolean property cannot be set to false through it. The viewer
stops a picture being dragged out with a `dragstart` handler on its box instead.

## Writing files from PowerShell 5.1

`Set-Content -Encoding utf8` adds a byte-order mark, which broke `package.json` for
electron-builder ("Unexpected token"). Write with `[IO.File]::WriteAllText` and
`UTF8Encoding($false)`, or use the editor.

## Google sign-in and the user agent

fanout 0.2.0 as first installed told sites it was plain Chrome (it cut "fanout/0.2.0" and
"Electron/45.3.0" out of the user agent). Google's sign-in answered "Couldn't sign you in.
This browser or app may not be secure." Google's published rules for browsers on
accounts.google.com (Google Developers Blog, August 2020, guidance on blocking less
secure browsers) say a browser must identify itself clearly in its user agent, must not
use another browser's user agent such as Chrome's, and must not rewrite HTTP headers.
Google can also see the disguise: page JavaScript reports the brands "Chromium 156" and
no "Google Chrome". Other Electron apps (orca, t3code-panes, neutrino) reported fixing
the same error by dropping their disguise; none of them proved a full sign-in either.

So pages now get Electron's own user agent, unchanged, everywhere: "Mozilla/5.0 (Windows
NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) fanout/0.2.0
Chrome/156.0.8078.96 Electron/45.3.0 Safari/537.36" for the installed app (a source run
of a script shows no app token, since Electron then names the app "Electron"). Measured
on a local server: the header and `navigator.userAgent` are identical. Electron 45 sends
no `Sec-CH-UA` client hint headers at all (none reached a local server over HTTP or
HTTPS, and none left for example.com); page JavaScript reports `Not:A-Brand 8,
Chromium 156`. fanout changes none of it, and a unit test fails if code that rewrites
the user agent, request headers or Chromium switches comes back.

Still unproven: a real Google sign-in. Google's rules also say sign-in from embedded
browser frameworks is not allowed, and Electron is one, so an honest user agent may
not be enough. If Google still refuses, the next step is a decision (roadmap D4), not
another disguise.

## Not verified yet

- Signing in to Google inside fanout (above).
- A real drop onto a real upload page. The drag is started with the same native call
  Explorer uses; the drop needs a person.
- macOS and Linux. The code avoids platform assumptions but has only run on Windows 11.
- The media viewer with the owner's own files. The formats were checked with files made
  on this PC (`tools/media-formats.mjs`); HEVC plays here because this PC's graphics
  decode it. Ogg, raw AAC, AVIF and HEIC files were not tested; AVI, WMV and MPG are
  formats the engine says it cannot play.
