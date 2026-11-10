import '@axterm/infra-ui-theme/bootstrap.module.css';
import './auth.module.css';
const form = document.querySelector('form');
const input = document.querySelector<HTMLInputElement>('#credential');
const status = document.querySelector('[role="status"]');
if (!form || !input || !status) throw new Error('AUTHENTICATION_FORM_MISSING');
let submitting = false;
form.addEventListener('submit', (event) => {
  event.preventDefault();
  if (submitting) return;
  submitting = true;
  const token = input.value;
  input.value = '';
  void fetch('./connect', {
    method: 'POST',
    credentials: 'same-origin',
    cache: 'no-store',
    redirect: 'error',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ token, kind: 'browser' }),
  })
    .then((response) => {
      if (!response.ok) throw new Error('AUTHENTICATION_REFUSED');
      location.replace('./');
    })
    .catch(() => {
      status.textContent = 'Connection failed. Check the launch token and try again.';
      input.focus();
    })
    .finally(() => {
      submitting = false;
    });
});
