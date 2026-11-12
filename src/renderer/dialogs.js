// The two dialogs: a brand (new or edited) and settings. While one is open
// the page layer is hidden, because pages are drawn above the interface.

import { h, icon, inkOn } from './dom.js';

/** Show a <dialog>; resolves with whatever `finish` was called with when it closes. */
function modal(api, build) {
  return new Promise((resolve) => {
    let result = null;
    const dialog = h('dialog', { class: 'dialog' });
    const finish = (value) => {
      result = value ?? null;
      dialog.close();
    };
    dialog.append(build(finish));
    dialog.addEventListener('close', () => {
      dialog.remove();
      api.setCovered(false);
      resolve(result);
    });
    // Clicking the dimmed area around the dialog closes it.
    dialog.addEventListener('mousedown', (e) => { if (e.target === dialog) finish(null); });
    document.body.append(dialog);
    api.setCovered(true);
    dialog.showModal();
  });
}

/**
 * Create or edit a brand. Resolves with { name, color, folder, urls? } or null.
 * @param {{api: object, colors: string[], presets: {name: string, url: string}[], brand?: object, used?: number}} options
 */
export function openBrandDialog({ api, colors, presets, brand, used = 0 }) {
  return modal(api, (finish) => {
    let color = brand?.color ?? colors[used % colors.length];
    let folder = brand?.folder ?? '';
    const chosen = new Set();

    const name = h('input', { type: 'text', value: brand?.name ?? '', maxLength: 60, placeholder: 'Name of the brand', required: true });
    const folderText = h('span', { class: 'folder-path' });
    const showFolder = () => {
      folderText.textContent = folder || 'No folder chosen';
      folderText.title = folder;
      folderText.classList.toggle('quiet', !folder);
    };
    showFolder();

    const swatches = h('div', { class: 'swatches', role: 'radiogroup', 'aria-label': 'Colour' }, colors.map((value) =>
      h('button', {
        type: 'button',
        class: `swatch${value === color ? ' is-on' : ''}`,
        role: 'radio',
        'aria-checked': String(value === color),
        'aria-label': value,
        style: { '--brand': value, '--brand-ink': inkOn(value) },
        onclick: (e) => {
          color = value;
          for (const el of swatches.children) {
            el.classList.toggle('is-on', el === e.currentTarget);
            el.setAttribute('aria-checked', String(el === e.currentTarget));
          }
        },
      }, icon('check'))));

    const starters = brand ? null : h('div', { class: 'field' },
      h('span', { class: 'field-name' }, 'Open tabs for'),
      h('div', { class: 'chips' }, presets.map((preset) =>
        h('button', {
          type: 'button',
          class: 'chip',
          'aria-pressed': 'false',
          onclick: (e) => {
            const on = !chosen.delete(preset.url);
            if (on) chosen.add(preset.url);
            e.currentTarget.classList.toggle('is-on', on);
            e.currentTarget.setAttribute('aria-pressed', String(on));
          },
        }, preset.name))),
      h('p', { class: 'quiet' }, 'Any other site can be added later from the address bar.'));

    return h('form', {
      method: 'dialog',
      onsubmit: (e) => {
        e.preventDefault();
        if (!name.value.trim()) return name.focus();
        finish({ name: name.value, color, folder, ...(brand ? {} : { urls: [...chosen] }) });
      },
    },
    h('h2', {}, brand ? 'Edit brand' : 'Add a brand'),
    h('label', { class: 'field' }, h('span', { class: 'field-name' }, 'Name'), name),
    h('div', { class: 'field' }, h('span', { class: 'field-name' }, 'Colour'), swatches),
    h('div', { class: 'field' },
      h('span', { class: 'field-name' }, 'Folder it posts from'),
      h('div', { class: 'folder-pick' },
        folderText,
        h('button', {
          type: 'button',
          onclick: async () => {
            const picked = await api.chooseFolder(folder);
            if (picked) {
              folder = picked;
              showFolder();
            }
          },
        }, folder ? 'Change…' : 'Choose folder…'))),
    starters,
    h('div', { class: 'dialog-actions' },
      brand ? h('button', {
        type: 'button',
        class: 'danger',
        onclick: async () => { if (await api.deleteBrand(brand.id)) finish(null); },
      }, 'Delete brand…') : null,
      h('span', { class: 'grow' }),
      h('button', { type: 'button', onclick: () => finish(null) }, 'Cancel'),
      h('button', { type: 'submit', class: 'primary' }, brand ? 'Save changes' : 'Add brand')));
  });
}

const SLEEP_AFTER = [[5, '5 minutes'], [10, '10 minutes'], [20, '20 minutes'], [30, '30 minutes'], [60, '1 hour'], [0, 'Never']];
const MAX_LIVE = [[3, '3 tabs'], [4, '4 tabs'], [6, '6 tabs'], [8, '8 tabs'], [12, '12 tabs'], [0, 'No limit']];

function select(options, current, onchange) {
  const known = options.some(([value]) => value === current);
  const all = known ? options : [...options, [current, String(current)]];
  return h('select', { onchange: (e) => onchange(Number(e.target.value)) },
    all.map(([value, label]) => h('option', { value: String(value), selected: value === current }, label)));
}

/** Memory settings. Changes apply as they are made. */
export function openSettingsDialog({ api, settings, version }) {
  return modal(api, (finish) => h('form', { method: 'dialog', onsubmit: (e) => { e.preventDefault(); finish(); } },
    h('h2', {}, 'Memory'),
    h('p', {}, 'Every loaded tab is a full web page and uses memory even when you are not looking at it. ' +
      'fanout puts tabs you are not using to sleep: a sleeping tab uses none, and loads again when you open it.'),
    h('label', { class: 'field field-row' },
      h('span', { class: 'field-name' }, 'Put a background tab to sleep after'),
      select(SLEEP_AFTER, settings.sleepAfterMinutes, (value) => api.updateSettings({ sleepAfterMinutes: value }))),
    h('label', { class: 'field field-row' },
      h('span', { class: 'field-name' }, 'Keep loaded at most'),
      select(MAX_LIVE, settings.maxLiveTabs, (value) => api.updateSettings({ maxLiveTabs: value }))),
    h('p', { class: 'quiet' }, 'A tab is never put to sleep while it is uploading, playing sound, or holding ' +
      'something you typed and have not sent. Right-click a tab to keep it awake always.'),
    h('div', { class: 'dialog-actions' },
      h('span', { class: 'quiet' }, `fanout ${version}`),
      h('span', { class: 'grow' }),
      h('button', { type: 'submit', class: 'primary' }, 'Done'))));
}
