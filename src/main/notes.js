// Release notes: what an update's feed carries, and when to show them.
// Pure: no Electron.

const MAX_NOTES = 20_000;

/**
 * Release notes as plain text. The feed carries a string (possibly with HTML
 * from a Markdown converter) or a list of { version, note } entries.
 */
export function notesText(notes) {
  const text = Array.isArray(notes)
    ? notes.map((entry) => entry?.note ?? '').join('\n\n')
    : typeof notes === 'string' ? notes : '';
  return text
    .replace(/<\s*(br|\/p|\/li|\/h\d)\s*\/?>/gi, '\n')
    .replace(/<li[^>]*>/gi, '- ')
    .replace(/<[^>]+>/g, '')
    .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'")
    .replace(/\n{3,}/g, '\n\n')
    .trim()
    .slice(0, MAX_NOTES);
}

/**
 * What to show after a start: the notes of the version now running, if this
 * is the first start since it replaced an older one.
 * @returns {{version: string, text: string} | null}
 */
export function whatsNew(previousVersion, currentVersion, savedNotes) {
  if (!previousVersion || previousVersion === currentVersion) return null;
  return { version: currentVersion, text: savedNotes?.version === currentVersion ? savedNotes.text : '' };
}
