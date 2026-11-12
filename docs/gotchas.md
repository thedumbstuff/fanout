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

## Writing files from PowerShell 5.1

`Set-Content -Encoding utf8` adds a byte-order mark, which broke `package.json` for
electron-builder ("Unexpected token"). Write with `[IO.File]::WriteAllText` and
`UTF8Encoding($false)`, or use the editor.

## Not verified yet

- Signing in to Google inside fanout. Tabs present a plain Chrome user agent
  (`useragent.js`), which is the usual fix, but only a real sign-in proves it.
- A real drop onto a real upload page. The drag is started with the same native call
  Explorer uses; the drop needs a person.
- macOS and Linux. The code avoids platform assumptions but has only run on Windows 11.
