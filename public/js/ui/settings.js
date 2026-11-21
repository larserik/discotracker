// Settings dialog. Tabs: Keyboard (more can be added later).
import {
  ACTIONS, GROUPS, keysFor, isDefault, setKeys, resetKeys, resetAllKeys, comboFromEvent, formatCombo, onKeymapChange,
} from '../keymap.js';
import { confirmDialog } from './confirm.js';

const $ = (s) => document.querySelector(s);
const el = (tag, props = {}, ...children) => {
  const e = Object.assign(document.createElement(tag), props);
  e.append(...children);
  return e;
};

// Shown in the Help dialog, with whatever keys are set right now.
const HELP = [
  ['stopOrEdit', 'stop / edit mode on/off'],
  ['playSong', 'play song'], ['playFromRow', 'play from the cursor row'], ['playPattern', 'play pattern'], ['stop', 'stop'],
  ['newRow', 'in edit mode: new row, push down'], ['deleteAbove', 'in edit mode: delete row above, pull up'],
  ['clearField', 'clear note/value'], ['clearCell', 'clear the whole cell'], ['insertSpace', 'insert row (cursor stays)'],
  ['nextChannel', 'next channel'], ['pageDown', '16 rows down'],
  ['copy', 'copy'], ['cut', 'cut'], ['paste', 'paste'], ['undo', 'undo'], ['redo', 'redo'], ['selectAll', 'select pattern'],
  ['transposeUp', 'transpose up'], ['transposeDown', 'transpose down'],
  ['prevInstrument', 'previous instrument'], ['nextInstrument', 'next instrument'],
  ['prevOrder', 'previous order position'], ['nextOrder', 'next order position'],
];

export function initSettings(app) {
  const dialog = $('#settings-dialog');
  const list = $('#keys-list');
  const filter = $('#keys-filter');
  let capturing = null; // { id, chip }

  function stopCapture() {
    if (!capturing) return;
    capturing = null;
    render();
  }

  function render() {
    const q = filter.value.trim().toLowerCase();
    list.replaceChildren();
    for (const g of GROUPS) {
      const rows = ACTIONS.filter((a) => a.group === g &&
        (!q || a.label.toLowerCase().includes(q) || keysFor(a.id).some((c) => formatCombo(c).toLowerCase().includes(q))));
      if (!rows.length) continue;
      list.append(el('h3', { className: 'pl-sub', textContent: g }));
      const tb = el('tbody');
      for (const a of rows) {
        const keys = keysFor(a.id);
        const chips = el('div', { className: 'key-chips' },
          ...keys.map((c) => el('span', { className: 'key-chip' }, el('kbd', { textContent: formatCombo(c) }),
            el('button', { type: 'button', className: 'chip-x', title: 'Remove this key', ariaLabel: `Remove ${formatCombo(c)}`,
              onclick: () => { setKeys(a.id, keys.filter((k) => k !== c)); render(); } }, '×'))));
        if (capturing?.id === a.id) chips.append(el('span', { className: 'key-chip capturing', tabIndex: -1, textContent: 'Press keys… (Esc to cancel)' }));
        else chips.append(el('button', { type: 'button', className: 'chip-add', title: 'Add a key', ariaLabel: `Add a key for ${a.label}`,
          onclick: () => { capturing = { id: a.id }; render(); } }, '+'));
        tb.append(el('tr', {},
          el('td', { className: 'key-label' }, a.label,
            a.when === 'edit' ? el('span', { className: 'badge', title: 'Only in edit mode. Outside edit mode the same key can do something else.', textContent: 'edit mode' }) : ''),
          el('td', {}, chips),
          el('td', { className: 'acts' }, isDefault(a.id) ? '' : el('button', { type: 'button', textContent: 'Reset', title: 'Back to the default keys',
            onclick: () => { resetKeys(a.id); render(); } }))));
      }
      list.append(el('table', { className: 'songs-table keys-table' }, tb));
    }
    list.querySelector('.capturing')?.focus();
    if (!list.children.length) list.append(el('p', { className: 'muted', textContent: 'No actions match.' }));
  }

  // Capture the next key combination while "Press keys…" is showing.
  // Listen on the window: the focused button is replaced when the list re-renders.
  window.addEventListener('keydown', (e) => {
    if (!capturing || !dialog.open) return;
    e.preventDefault();
    e.stopPropagation();
    if (e.code === 'Escape' && !e.shiftKey && !e.ctrlKey && !e.metaKey && !e.altKey) { stopCapture(); return; }
    const combo = comboFromEvent(e);
    if (!combo) return; // just a modifier so far
    const { id } = capturing;
    capturing = null;
    const taken = setKeys(id, [...keysFor(id), combo]);
    render();
    if (taken.length) app.toast(`${formatCombo(combo)} was moved from "${taken.map((a) => a.label).join('", "')}".`, 'warn');
  }, true);
  dialog.addEventListener('cancel', (e) => { if (capturing) { e.preventDefault(); stopCapture(); } });
  dialog.addEventListener('close', () => { capturing = null; filter.value = ''; $('#pattern').focus(); });
  filter.addEventListener('input', render);
  $('#keys-reset-all').addEventListener('click', async () => {
    if (!(await confirmDialog({
      title: 'Reset all keys?',
      message: 'All keyboard shortcuts go back to the defaults. Your changes are lost.',
      confirmText: 'Reset all', danger: true,
    }))) return;
    resetAllKeys();
    render();
  });

  // ---- tabs
  const tabs = [...dialog.querySelectorAll('.tab')];
  function showTab(name) {
    for (const t of tabs) { const on = t.dataset.tab === name; t.classList.toggle('active', on); t.setAttribute('aria-selected', on); }
    for (const p of dialog.querySelectorAll('.tab-panel')) p.hidden = p.dataset.panel !== name;
    if (name === 'keys') render();
  }
  tabs.forEach((t) => t.addEventListener('click', () => { stopCapture(); showTab(t.dataset.tab); }));

  // ---- editor settings: the same switches as under Editing on the left, kept in step
  const mirror = (setId, panelId) => {
    const a = $(setId), b = $(panelId);
    a.addEventListener('change', () => { b.checked = a.checked; b.dispatchEvent(new Event('change')); });
    return () => { a.checked = b.checked; };
  };
  const syncSwitches = [mirror('#set-continuous', '#continuous'), mirror('#set-follow', '#follow')];

  function fillHelp() {
    $('#help-keys').replaceChildren(...HELP.map(([id, text]) => {
      const keys = keysFor(id);
      return el('li', {}, ...(keys.length
        ? keys.slice(0, 2).flatMap((c, i) => [i ? ' or ' : '', el('kbd', { textContent: formatCombo(c) })])
        : [el('span', { className: 'muted', textContent: '(no key)' })]), ` ${text}`);
    }));
  }
  onKeymapChange(fillHelp);

  return {
    open(tab = 'editor') {
      $('#help-dialog').open && $('#help-dialog').close();
      syncSwitches.forEach((f) => f());
      showTab(tab);
      dialog.showModal();
    },
    fillHelp,
  };
}
