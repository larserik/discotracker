// In-page confirmation dialog, used instead of the browser's confirm().
//   if (!(await confirmDialog({ title, message, confirmText: 'Delete', danger: true }))) return;
// Resolves true when confirmed, false on Cancel, Esc or a click outside the box.

let dlg = null;

function build() {
  dlg = document.createElement('dialog');
  dlg.className = 'dialog confirm-dialog';
  dlg.innerHTML = `
    <h2 class="confirm-title"></h2>
    <p class="confirm-message"></p>
    <div class="confirm-actions">
      <button type="button" class="confirm-cancel"></button>
      <button type="button" class="confirm-ok"></button>
    </div>`;
  document.body.append(dlg);
  // A click on the backdrop (outside the box) cancels.
  dlg.addEventListener('click', (e) => {
    const r = dlg.getBoundingClientRect();
    if (e.clientX < r.left || e.clientX > r.right || e.clientY < r.top || e.clientY > r.bottom) dlg.close('cancel');
  });
  dlg.querySelector('.confirm-cancel').addEventListener('click', () => dlg.close('cancel'));
  dlg.querySelector('.confirm-ok').addEventListener('click', () => dlg.close('ok'));
}

export function confirmDialog({ title = 'Are you sure?', message = '', confirmText = 'OK', cancelText = 'Cancel', danger = false } = {}) {
  if (!dlg) build();
  if (dlg.open) dlg.close('cancel');
  dlg.querySelector('.confirm-title').textContent = title;
  const msg = dlg.querySelector('.confirm-message');
  msg.textContent = message;
  msg.hidden = !message;
  const ok = dlg.querySelector('.confirm-ok');
  ok.textContent = confirmText;
  ok.className = `confirm-ok ${danger ? 'danger-solid' : 'primary'}`;
  dlg.querySelector('.confirm-cancel').textContent = cancelText;
  const back = document.activeElement;
  return new Promise((resolve) => {
    dlg.returnValue = '';
    dlg.addEventListener('close', () => {
      resolve(dlg.returnValue === 'ok');
      // Give focus back quietly: no focus ring on the button that opened the box
      // (until focus moves on, e.g. with Tab).
      if (back && document.contains(back) && back.focus) {
        back.classList.add('quiet-focus');
        back.addEventListener('blur', () => back.classList.remove('quiet-focus'), { once: true });
        back.focus();
      }
    }, { once: true });
    dlg.showModal();
    // Enter confirms right away; for something destructive the safe choice has focus.
    (danger ? dlg.querySelector('.confirm-cancel') : ok).focus();
  });
}
