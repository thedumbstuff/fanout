# Updates

fanout updates itself with `electron-updater` (its one runtime dependency).

## What the person sees

- Fifteen seconds after starting, and every six hours, fanout looks for a new version.
- If there is one it downloads in the background; the status bar shows the progress,
  then "fanout 0.2.1 is ready" with a **Restart to update** button.
- Pressing the button installs it and starts fanout again. Not pressing it is fine: the
  update is installed the next time fanout is closed.
- On the first start of a new version the status bar offers **See what is new**.
- Settings has "Download new versions when they come out" (on by default) and a
  **Check for updates** button; the File menu has the same check.

## How it works

```
package.json  build.publish = generic, https://thedumbstuff.page/downloads/fanout/current/
                |  electron-builder writes that address into the app (app-update.yml)
                v
<feed>/latest.yml            version, installer file name, SHA-512, release notes
<feed>/fanout-setup-X.exe    the installer the feed names (and its .blockmap, which lets
                             the updater fetch only the parts that changed)
```

`src/main/updates.js` owns it. `src/main/notes.js` holds the two pure helpers.

Installing does not go through Electron's quit, which fanout never uses (gotchas.md):

- **Restart to update**: save data, cookies and site storage; `quitAndInstall(silent,
  restart)` starts the installer and asks Electron to quit; `main.js` turns that into
  closing the window; `shutdown()` ends the process; the installer, which was waiting
  for that, installs and starts fanout.
- **Closing the window** with an update waiting: `shutdown()` calls
  `updates.installOnExit()`, which starts the installer without the restart, waits a
  moment for it to start, and ends the process.

The release notes of a downloaded update are saved in `fanout.json` (`releaseNotes`),
with the version that ran last (`lastVersion`), so the new version can show them.

## What protects an update

The installer is checked against the SHA-512 in the feed, and the feed is fetched over
HTTPS from thedumbstuff.page. There is no second signature: electron-updater checks a
publisher signature only for code-signed apps, and fanout is not signed yet (roadmap
D5). ContextWire's updates carry their own signature; fanout's do not.

## Per system

| System | Behaviour |
|--------|-----------|
| Windows | Full: download, install, restart. Tested (below). |
| Linux | AppImage and .deb update themselves (`latest-linux.yml`). Not tested. |
| macOS | Squirrel.Mac installs updates only for signed apps. Until fanout is signed it says "fanout X is out" with a **Get it** button that opens the download page. Not tested. |

## Releasing

```
1. package.json: new version.  docs/changelog.md: a "## <version>" section (the notes).
2. node tools/release.mjs build          installer + latest.yml in dist/
3. node tools/release.mjs publish        shows what would be uploaded
   node tools/release.mjs publish --yes  uploads and makes it current
```

**Publishing does not work yet.** Two things on thedumbstuff.page have to change first
(roadmap P4.3), both in `thedumbstuff-site/api/downloads.py`:

1. The downloads service knows one product, ContextWire, with fixed file names, `.sig`
   files and Tauri's `latest.json`. It has to accept `fanout` and serve its
   `latest*.yml`, installers and blockmaps under `/downloads/fanout/current/`.
2. The Windows installer is 107.6 MB and Cloudflare refuses requests over 100 MB.
   The service needs uploads in parts, or another way in. (Electron 45's own program
   is 238 MB before compression; trimming languages and maximum compression only took
   the installer from 115.6 to 107.6 MB.)

`publish` already speaks the service's existing protocol (`PUT
/api/downloads/fanout/<version>/<file>`, `POST .../publish`, the same token) and refuses
files over 100 MB, so it says what is wrong instead of failing half way.

## Testing an update on one PC (done 2026-11-12)

```
node tools/release.mjs build                     # version A
dist\fanout-setup-A.exe /S                       # install it
(raise the version, add a changelog section)
node tools/release.mjs build                     # version B
node tools/release.mjs serve                     # dist/ as a feed on 127.0.0.1:8799
set FANOUT_UPDATE_URL=http://127.0.0.1:8799/     # and FANOUT_USER_DATA to a scratch folder
"%LOCALAPPDATA%\Programs\fanout\fanout.exe"
```

Results with A = 0.2.0 and a throwaway B = 0.2.1:

- The installed 0.2.0 fetched `latest.yml`, both blockmaps and the installer.
- Closing the window: the installed program became 0.2.1, and fanout stayed closed.
- "Restart to update" (triggered from a source run, `electron -r hook.cjs .`): the
  process ended, the installer ran, the installed fanout started by itself.
- The profile recorded `lastVersion` 0.2.0 -> 0.2.1 and kept the notes for 0.2.1.

Not seen with eyes: the status bar texts and the "what is new" dialog during a real
update (their logic is unit-tested; the dialog is plain).

## Running from source

`npm start` does not check for updates (nothing to install over). With
`FANOUT_UPDATE_URL` set it does, and then also needs a `dev-app-update.yml` in the
project root to download:

```
provider: generic
url: http://127.0.0.1:8799/
updaterCacheDirName: fanout-updater-test
```

A script started as `electron some-script.mjs` reports Electron's version (45.3.0) as
the app's, so it never sees an update; start the project itself (`electron .`).
