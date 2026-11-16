<p align="center">
  <a href="https://thedumbstuff.page/"><img src="assets/thedumbstuff.jpg" width="640" alt="thedumbstuff - a small collection of ridiculous ideas for a brighter tomorrow"></a>
</p>

<p align="center">
  <b>Brought to you by <a href="https://thedumbstuff.page/">thedumbstuff</a></b><br>
  A small collection of ridiculous ideas. This is one of them.
</p>

<p align="center">
  <i>We were posting one video to six websites from a browser with forty tabs,<br>
  signed in as the wrong brand in at least two of them.<br>
  A sensible person would have hired someone. We built an app.</i>
</p>

<p align="center">
  Yes, it is a browser for people who already have a browser. We are aware.<br>
  No, it does not post for you. Most platforms forbid automating the site itself, and we would like to keep our accounts.<br>
  It puts everything in one window and stays out of the way.
</p>

---

<p align="center">
  <img src="build/icon.png" width="96" alt="fanout icon">
</p>

<h1 align="center">fanout</h1>

<p align="center">
  <b>One window for every brand's social accounts.</b><br>
  Each brand keeps its own sign-ins, its own tabs and its own folder of things to post.
  Put up to four sites side by side, drag the video from the folder onto each one, and tick off where it went.
</p>

<p align="center">
  No download yet: for now the Windows installer is built from the source (<a href="#build-an-installer">below</a>).
  Downloads on <a href="https://thedumbstuff.page/">thedumbstuff.page</a> are coming. macOS and Linux are untested.
</p>

<p align="center">
  <img src="assets/screenshots/main.png" alt="fanout with the brand Acme Foods: YouTube, Instagram, Facebook and LinkedIn side by side, the brand's folder on the right with posted marks next to each file, and a caption file open below it">
</p>

> The screenshots show sample data: made-up brands and files, and each site's public
> page, signed out. fanout is not affiliated with or endorsed by any of the platforms shown.

---

## Why

The hard part of posting one video everywhere is not the posting. It is the juggling.
Posting the same video to YouTube, LinkedIn, TikTok and the rest means a pile of
browser tabs, and with more than one brand it means a browser or a profile per brand,
or signing out and in again all day. Close it all, and next time you open every site
again.

The tools that post for you were no answer for us. The ones we looked at were
expensive, charged by how much you use them, and came bundled with things we did not
need, such as AI image and video generation.

So fanout keeps each brand in its own compartment, and remembers it. Close fanout and
open it tomorrow: each brand comes back as you left it, still signed in, with the same
tabs, the same pages side by side, the tab you had on its own still in front of them,
and the posted marks you set.

- **Brands**, each with its own sign-ins. The same site can be signed in to a different
  account in every brand, and stays signed in.
- **Tabs per brand** for the places it posts. Any address works; nothing in fanout is
  specific to a platform.
- **Up to four pages side by side**, with dividers you drag. Each brand remembers its
  layout and which page is in which pane. Other tabs open on their own in front of
  that group and never push a page out of it; a tab joins the group only when you say so.
- **A file panel per brand**, pinned to the folder that brand posts from. Drag a file
  onto any page that accepts uploads, exactly as you would from Explorer or Finder.
- **Caption files open in place.** Click a text file (`.txt`, `.md` and the like) to
  read it; select any part of the text and it is copied. Markdown is shown formatted
  (Source shows it as written), and what you copy from it is plain text, ready for a
  caption box.
- **So do videos, pictures and sounds**, so you can tell which clip is which without
  leaving fanout. Click one to see it under the files with what the upload forms ask
  about: `1080 × 1920, vertical 9:16 · 0:42.3 · 38.2 MB`. Plain play, position and
  volume controls; nothing plays until you press play. A larger view covers the pages
  (Esc goes back, the arrow keys step through the folder). It shows what its built-in
  browser shows: MP4, MOV, WebM and MKV videos, MP3, M4A, WAV and FLAC sounds, JPEG,
  PNG, WebP, GIF, BMP and SVG pictures. iPhone (HEVC) videos play where the computer's
  graphics can decode them. A file it cannot show says so and offers to open it in your
  usual app.
- **A posted tracker.** Tick which file has gone where; hide what is posted everywhere.
- **It updates itself**, once downloads are on thedumbstuff.page: new versions download
  in the background and install when you restart or close it. (On macOS, until fanout
  is signed, it says a new version is out and opens the download page.)
- **Tabs you are not using go to sleep** and give their memory back: after 20 minutes
  unused, or, when more than six are loaded, the least recently used first (both
  settable). A sleeping tab keeps its address, title and icon and loads again when you
  open it. A tab that is uploading, playing sound or holding something you typed is left
  alone. Measured on one Windows 11 PC with six sites' front pages, signed out: fanout
  with no tabs 317 MB, all six loaded 2,724 MB, one loaded and five asleep 1,036 MB about
  40 seconds later ([memory](docs/memory.md) has the details). A loaded page costs what
  the site makes it cost, about 170 to 340 MB for these, so four pages side by side are
  four loaded pages. The status bar shows the live figure; in the screenshots it reads 2.4
  to 3 GB, with five or six social sites loaded at once.

fanout does not post for you. It never clicks, types or reads inside a page, because
most platforms forbid automated activity. You upload by hand; fanout removes the
juggling around it.

## A closer look

<table>
  <tr>
    <td width="50%"><img src="assets/screenshots/on-its-own.png" alt="A tab of Acme Foods shown on its own: X fills the page area, the four pages of the group wait in the tab strip with a dashed outline, and a Back to the group button sits above the page"></td>
    <td width="50%"><img src="assets/screenshots/add-brand.png" alt="The Add a brand dialog: a name, a colour, the folder the brand posts from, the sites to open tabs for, and whether to show them side by side"></td>
  </tr>
  <tr>
    <td><b>A tab on its own</b> - a tab outside the group fills the page area; the group waits, outlined, one click away.</td>
    <td><b>Add a brand</b> - a name, a colour, the folder it posts from, and the sites it posts to.</td>
  </tr>
  <tr>
    <td><img src="assets/screenshots/posted-dark.png" alt="The brand Northwind Travel in the dark theme: Threads open, and the brand's folder with two subfolders open, a mark per file and site, and the files posted everywhere highlighted"></td>
    <td><img src="assets/screenshots/viewer.png" alt="The media viewer's larger view over the pages: a video of a bowl of soup titled New autumn menu, its size, shape, length and file size above it, play, position and volume below, and the file panel beside it with the video selected"></td>
  </tr>
  <tr>
    <td><b>Posted tracker</b> - a mark per file and site, set by hand; a file that has gone everywhere is highlighted. Light and dark themes follow the system.</td>
    <td><b>Media viewer</b> - see a clip before you upload it, with the facts the upload forms ask about; the larger view covers the pages.</td>
  </tr>
</table>

## Run it

Windows: double-click `Open fanout.bat` (it installs what it needs the first time).

Any system, with Node.js 22 or newer:

```
git clone https://github.com/thedumbstuff/fanout
cd fanout
npm install
npm start
```

## Build an installer

```
node tools/release.mjs build  # for the system you are on
```

The result is in `dist/`. The workflow in `.github/workflows/build.yml` builds Windows,
macOS and Linux installers on every push; the macOS and Linux ones have not been tried on
those systems yet. The installers are not code signed yet, so Windows and macOS warn
before the first run.

## Develop

```
npm test             # unit tests, no Electron needed
npm run smoke        # the real app against a throwaway profile; opens a window
npm run measure      # memory with six real sites loaded, then with five asleep
npm run screenshots  # the pictures in this README, from the real app; opens a window
node node_modules/electron/cli.js tools/media-formats.mjs   # which formats the viewer shows here
python watchtower/server.py    # build dashboard on http://127.0.0.1:8768
```

Start with `src/main/main.js`; it lists what every file is for. More in `docs/`:
[architecture](docs/architecture.md), [memory](docs/memory.md),
[gotchas](docs/gotchas.md), [updates](docs/updates.md), [changelog](docs/changelog.md).
`tools/screenshots.mjs` says at its top how the pictures are made and what is in them.

## Where your data is

Brands, tabs and posted marks are two JSON files in the app's data folder
(`%APPDATA%\fanout` on Windows, `~/Library/Application Support/fanout` on macOS,
`~/.config/fanout` on Linux), next to each brand's browser profile. Nothing in them is
sent anywhere. Deleting a brand signs it out everywhere and removes its profile; the
files in its folder are never touched.

MIT licence. Made by [thedumbstuff](https://thedumbstuff.page).
