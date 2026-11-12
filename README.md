# fanout

One window for every brand's social accounts.

Posting the same video to YouTube, LinkedIn, TikTok and the rest means a pile of
browser tabs, and with more than one brand it means signing out and in again all day.
fanout keeps each brand in its own compartment:

- **Brands**, each with its own sign-ins. The same site can be signed in to a different
  account in every brand, and stays signed in.
- **Tabs per brand** for the places it posts. Any address works; nothing in fanout is
  specific to a platform.
- **Up to four pages side by side**, with dividers you drag. Each brand remembers its
  layout and which page is in which pane.
- **A file panel per brand**, pinned to the folder that brand posts from. Drag a file
  onto any page that accepts uploads, exactly as you would from Explorer or Finder.
- **Caption files open in place.** Click a `.txt` or `.md` file to read it; select any
  part of the text and it is copied.
- **A posted tracker.** Tick which file has gone where; hide what is posted everywhere.
- **It updates itself**: new versions download in the background and install on restart.
- **Tabs you are not using go to sleep** and give their memory back. A tab that is
  uploading, playing sound or holding something you typed is left alone.

fanout does not post for you. It never clicks, types or reads inside a page, because
most platforms forbid automated activity. You upload by hand; fanout removes the
juggling around it.

## Run it

Windows: double-click `Open fanout.bat` (it installs what it needs the first time).

Any system, with Node.js 22 or newer:

```
npm install
npm start
```

## Build an installer

```
node tools/release.mjs build  # for the system you are on
```

The result is in `dist/`. The workflow in `.github/workflows/build.yml` builds
Windows, macOS and Linux installers. They are not code signed yet, so Windows and
macOS warn before the first run.

## Develop

```
npm test          # unit tests, no Electron needed
npm run smoke     # the real app against a throwaway profile; opens a window
npm run measure   # memory with six real sites loaded, then with five asleep
python watchtower/server.py    # build dashboard on http://127.0.0.1:8768
```

Start with `src/main/main.js`; it lists what every file is for. More in `docs/`:
[architecture](docs/architecture.md), [memory](docs/memory.md),
[gotchas](docs/gotchas.md), [updates](docs/updates.md), [changelog](docs/changelog.md).

## Where your data is

Brands, tabs and posted marks are two JSON files in the app's data folder
(`%APPDATA%\fanout` on Windows, `~/Library/Application Support/fanout` on macOS,
`~/.config/fanout` on Linux), next to each brand's browser profile. Nothing is sent
anywhere. Deleting a brand signs it out everywhere and removes its profile; the files
in its folder are never touched.

MIT licence. Made by [thedumbstuff](https://thedumbstuff.page).
