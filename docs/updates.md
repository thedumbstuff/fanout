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
3. node tools/release.mjs publish        shows what would be uploaded, and where
   node tools/release.mjs publish --yes  uploads and makes it current
```

`publish` sends the installer and its `.blockmap` (the files `dist/latest.yml` names) to
thedumbstuff.page's downloads service (`thedumbstuff-site/api/downloads.py`, its
`docs/installer.md`), then publishes them with the notes of that version from
`docs/changelog.md`. It needs the site's upload token: `DOWNLOADS_UPLOAD_TOKEN`, or the one
line of `%USERPROFILE%\.tauri\contextwire-downloads.token` (one token for all the site's
downloads; never printed). It prints the target first and sends nothing without `--yes`.
`FANOUT_SITE` points it at another site (a local preview).

How it gets there:

- **In parts.** The installer is 107.7 MB and Cloudflare refuses a request over 100 MB, so
  every file goes in parts of 16 MB: `POST .../fanout/<v>/<file>/parts` announces the size
  and the SHA-256 of the file and of each part, `PUT .../parts/<n>` sends one,
  `POST .../parts/done` lets the site put them together. The site checks each part as it
  arrives and the whole (size, SHA-256, starts like a Windows program) before the file
  counts. A part that gets no answer, or a busy one, is sent again (four tries).
- **Cut off?** Run `publish --yes` again. The site says which parts it has and only the
  others are sent; a file it has whole is skipped ("already there"). Nothing is published
  until every file is there and checked.
- **The feed is the site's.** `dist/latest.yml` is not uploaded: on publish the site writes
  `/downloads/fanout/current/latest.yml` itself from the file it holds (version, SHA-512,
  size, date, notes), naming the installer by its versioned address
  `../<v>/fanout-setup-<v>.exe`. The updater then finds the blockmaps for an update that
  fetches only the changed blocks: `<that address>.blockmap`, and the running version's at
  the same address with its own version (`../0.2.0/fanout-setup-0.2.0.exe.blockmap`). The
  site keeps the newest three versions besides the current one.
- `/downloads/fanout/current/fanout-setup.exe` is the newest installer under a name that
  never changes (the download button), and `current/release.json` what the page shows.

Proved on this PC on 2026-11-16 against the site's preview (`tools/dev_server.py`, a
throwaway token): `publish --yes` cut off after 3 of 7 parts went on from part 4; run again,
it skipped both files. electron-updater 6.8.11 itself (from a scratch Electron app, never
fanout, so nothing was installed) found 0.2.0 in the site's feed, downloaded it and its
SHA-512 check passed; with 0.2.0 and the throwaway 0.2.1 published, a 0.2.0 asked for both
blockmaps (both answered), planned 48 changed blocks (935 KB of 110 MB) and, from a server
that answers ranges, fetched only those; the result passed the SHA-512 check. The live site
answers multi-range requests through Cloudflare (seen on ContextWire's installer).

### Publishing a release

On the PC that publishes, in PowerShell (the token as above; nothing is sent before `--yes`):

```powershell
curl.exe -s https://thedumbstuff.page/api/downloads/healthz       # ok: the downloads service answers
cd C:\Shwetank\Work\Workspace\Python\opensource\fanout
Remove-Item Env:FANOUT_SITE -ErrorAction SilentlyContinue         # the real site, not a preview
node tools/release.mjs publish                                     # what would be sent, and where
node tools/release.mjs publish --yes
#   fanout-setup-<v>.exe: part 1 of 7 ... uploaded, sha256 ...
#   published <v> for windows: https://thedumbstuff.page/downloads/fanout/current/latest.yml
```

Then check the live site (read-only):

```powershell
cd C:\Shwetank\Work\Workspace\Python\opensource\thedumbstuff-site
python tools/check_download.py      # every product: fanout's installer (a program, its size and SHA-256),
                                    # the feed (its SHA-512, the versioned address, the blockmap) and
                                    # the buttons on its page; 0 failed
curl.exe -s https://thedumbstuff.page/downloads/fanout/current/latest.yml   # the new version; its sha512 is dist\latest.yml's
```

If an upload is cut off, or the site refuses it: thedumbstuff-site `docs/installer.md`,
"Publishing fanout".

**The first release, 0.2.0, was published on 2026-11-17** (the feed's `releaseDate`
2026-11-17T00:22:01Z), once the site's change was deployed (thedumbstuff-site roadmap P9.4).
`node tools/release.mjs publish --yes` uploaded `fanout-setup-0.2.0.exe` (107.7 MB, 7 parts) and
its `.blockmap` and ended with "published 0.2.0 for windows". It is the build of 2026-11-13 20:44,
the same one installed on the owner's PC. Seen on the live site the same day: `release.json` lists
Windows 0.2.0 (SHA-256 4d81fa767189...), `current/fanout-setup.exe` answers with 112,898,811
bytes, `current/latest.yml` offers 0.2.0 with the SHA-512 of `dist/latest.yml`, and
`check_download.py` passed 22 of 22 (fanout's five file and feed checks and three page checks
among them). Not seen yet: an installed fanout updating itself from the live feed (that needs a
second release), and macOS or Linux.

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
