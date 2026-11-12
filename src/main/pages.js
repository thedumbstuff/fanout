// Rules for every web page fanout shows (tabs and the sign-in popups they
// open). fanout never runs code inside a page; it only decides where a page
// may navigate, what a new window becomes, and what the right-click menu holds.

import { BrowserWindow, Menu, clipboard } from 'electron';
import { isWebUrl } from './urls.js';

const mayShow = (url) => isWebUrl(url) || url === 'about:blank' || url === 'about:srcdoc';

/**
 * @param {import('electron').WebContents} contents
 * @param {object} hooks
 * @param {(opener: import('electron').WebContents, url: string, background: boolean) => void} hooks.openTab
 * @param {() => import('electron').BrowserWindow | null} hooks.window  the main window
 */
export function hardenPage(contents, hooks) {
  // Dropping a file where a page does not accept it would otherwise replace
  // the page with the file. Only web addresses may be navigated to.
  contents.on('will-navigate', (event) => {
    if (!mayShow(event.url)) event.preventDefault();
  });

  contents.on('will-attach-webview', (event) => event.preventDefault());

  contents.setWindowOpenHandler(({ url, disposition }) => {
    if (!mayShow(url)) return { action: 'deny' };
    // window.open() with a size, or an empty window filled in afterwards, is a
    // sign-in or share popup: it needs to stay connected to the page that
    // opened it, so it becomes a real window sharing the brand's session.
    if (disposition === 'new-window' || url === 'about:blank') {
      return {
        action: 'allow',
        overrideBrowserWindowOptions: {
          parent: hooks.window() ?? undefined,
          width: 560,
          height: 720,
          autoHideMenuBar: true,
          title: 'fanout',
        },
      };
    }
    // An ordinary link that asks for a new tab gets one, next to its opener.
    hooks.openTab(contents, url, disposition === 'background-tab');
    return { action: 'deny' };
  });

  contents.on('did-create-window', (child) => child.setMenuBarVisibility(false));

  contents.on('context-menu', (_event, params) => {
    const window = BrowserWindow.fromWebContents(contents) ?? hooks.window();
    if (window) pageMenu(contents, params, hooks).popup({ window });
  });

  // Ctrl + mouse wheel zooms the page, as in any browser.
  contents.on('zoom-changed', (_event, direction) => {
    const level = contents.getZoomLevel() + (direction === 'in' ? 0.5 : -0.5);
    contents.setZoomLevel(Math.max(-3, Math.min(4, level)));
  });
}

function pageMenu(contents, params, hooks) {
  const items = [];
  const add = (...entries) => items.push(...entries);
  const rule = () => {
    if (items.length && items.at(-1).type !== 'separator') items.push({ type: 'separator' });
  };

  if (params.misspelledWord) {
    for (const word of params.dictionarySuggestions.slice(0, 5)) {
      add({ label: word, click: () => contents.replaceMisspelling(word) });
    }
    rule();
  }

  if (isWebUrl(params.linkURL)) {
    add(
      { label: 'Open link in new tab', click: () => hooks.openTab(contents, params.linkURL, false) },
      { label: 'Copy link address', click: () => clipboard.writeText(params.linkURL) },
    );
    rule();
  }

  if (params.mediaType === 'image' && isWebUrl(params.srcURL)) {
    add(
      { label: 'Copy image', click: () => contents.copyImageAt(params.x, params.y) },
      { label: 'Copy image address', click: () => clipboard.writeText(params.srcURL) },
      { label: 'Save image as…', click: () => contents.downloadURL(params.srcURL) },
    );
    rule();
  }

  const can = params.editFlags;
  if (params.isEditable) {
    add(
      { role: 'cut', enabled: can.canCut },
      { role: 'copy', enabled: can.canCopy },
      { role: 'paste', enabled: can.canPaste },
      { role: 'pasteAndMatchStyle', label: 'Paste as plain text', enabled: can.canPaste },
      { role: 'selectAll', enabled: can.canSelectAll },
    );
    rule();
  } else if (params.selectionText.trim()) {
    add({ role: 'copy' });
    rule();
  }

  const history = contents.navigationHistory;
  add(
    { label: 'Back', enabled: history.canGoBack(), click: () => history.goBack() },
    { label: 'Forward', enabled: history.canGoForward(), click: () => history.goForward() },
    { label: 'Reload', click: () => contents.reload() },
    { type: 'separator' },
    { label: 'Inspect', click: () => contents.inspectElement(params.x, params.y) },
  );
  return Menu.buildFromTemplate(items);
}
