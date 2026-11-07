// Passwordless sign-in: email -> 6-digit code -> session cookie.
import { api } from '../api.js';
import { local } from '../storage.js';

const REMEMBER_KEY = 'dt.rememberedEmail';
const $ = (s) => document.querySelector(s);

export function initAuth({ onUser, toast }) {
  const dialog = $('#signin-dialog');
  const emailForm = $('#email-form');
  const codeForm = $('#code-form');
  const emailInput = $('#signin-email');
  const remember = $('#remember-email');
  const codeInput = $('#signin-code');
  const errorEl = $('#signin-error');
  let email = '';
  let busy = false;

  const setError = (msg = '') => { errorEl.textContent = msg; };

  function showUser(user) {
    $('#signin-btn').hidden = !!user;
    $('#user-box').hidden = !user;
    $('#user-email').textContent = user?.email || '';
    onUser(user);
  }

  function showEmailStep() {
    codeForm.hidden = true;
    emailForm.hidden = false;
    setError();
    const remembered = local.get(REMEMBER_KEY);
    if (remembered && !emailInput.value) emailInput.value = remembered;
    remember.checked = remembered !== null || !local.get(REMEMBER_KEY + '.off');
    setTimeout(() => (emailInput.value ? $('#send-code-btn') : emailInput).focus(), 0);
  }

  function showCodeStep() {
    emailForm.hidden = true;
    codeForm.hidden = false;
    $('#code-email').textContent = email;
    codeInput.value = '';
    setError();
    setTimeout(() => codeInput.focus(), 0);
  }

  async function sendCode() {
    if (busy) return;
    email = emailInput.value.trim();
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) { setError('Please enter a valid email address.'); emailInput.focus(); return; }
    busy = true;
    const btn = $('#send-code-btn');
    btn.disabled = true;
    btn.textContent = 'Sending…';
    try {
      await api.requestCode(email);
      showCodeStep();
    } catch (e) {
      setError(e.message);
    } finally {
      busy = false;
      btn.disabled = false;
      btn.textContent = 'Send code';
    }
  }

  async function verify() {
    const code = codeInput.value.replace(/\D/g, '');
    if (code.length !== 6) { setError('Enter the 6-digit code from the email.'); return; }
    if (busy) return;
    busy = true;
    const btn = $('#verify-btn');
    btn.disabled = true;
    btn.textContent = 'Signing in…';
    setError();
    try {
      const { user } = await api.verify(email, code);
      if (remember.checked) { local.set(REMEMBER_KEY, user.email); local.remove(REMEMBER_KEY + '.off'); }
      else { local.remove(REMEMBER_KEY); local.set(REMEMBER_KEY + '.off', '1'); }
      dialog.close();
      showUser(user);
      toast(`Signed in as ${user.email}`);
    } catch (e) {
      setError(e.message);
      codeInput.select();
    } finally {
      busy = false;
      btn.disabled = false;
      btn.textContent = 'Sign in';
    }
  }

  emailForm.addEventListener('submit', (e) => { e.preventDefault(); sendCode(); });
  codeForm.addEventListener('submit', (e) => { e.preventDefault(); verify(); });

  // Pasting the code signs in right away, no button press needed.
  codeInput.addEventListener('paste', (e) => {
    const text = (e.clipboardData || window.clipboardData)?.getData('text') || '';
    const digits = text.replace(/\D/g, '');
    if (digits.length === 6) {
      e.preventDefault();
      codeInput.value = digits;
      verify();
    }
  });
  // Also covers SMS/email one-time-code autofill and typing the last digit.
  codeInput.addEventListener('input', () => {
    const digits = codeInput.value.replace(/\D/g, '');
    if (codeInput.value !== digits) codeInput.value = digits.slice(0, 6);
    if (digits.length === 6) verify();
  });

  $('#resend-btn').addEventListener('click', async () => {
    try { await api.requestCode(email); toast('A new code is on its way.'); codeInput.focus(); }
    catch (e) { setError(e.message); }
  });
  $('#change-email-btn').addEventListener('click', showEmailStep);

  $('#signin-btn').addEventListener('click', () => open());
  $('#logout-btn').addEventListener('click', async () => {
    try { await api.logout(); } catch { /* ignore */ }
    showUser(null);
    toast('Signed out');
  });

  function open() {
    emailInput.value = local.get(REMEMBER_KEY) || emailInput.value;
    showEmailStep();
    dialog.showModal();
  }

  api.me().then(({ user }) => showUser(user)).catch(() => showUser(null));

  return { open };
}
