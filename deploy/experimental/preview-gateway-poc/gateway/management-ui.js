export async function createRoute(port, request = fetch) {
  const response = await request('/__gateway/routes', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-gateway-csrf': 'same-origin' },
    body: JSON.stringify({ port }),
  });
  if (!response.ok) throw new Error(await responseError(response));
  return response.json();
}

export async function revokeRoute(id, request = fetch) {
  const response = await request(`/__gateway/routes/${encodeURIComponent(id)}`, {
    method: 'DELETE', headers: { 'x-gateway-csrf': 'same-origin' },
  });
  if (!response.ok) throw new Error(await responseError(response));
}

async function responseError(response) {
  try { const data = await response.json(); return data.error || `Request failed (${response.status})`; }
  catch { return `Request failed (${response.status})`; }
}

function showMessage(element, message, isError = false) {
  element.textContent = message;
  element.setAttribute('role', isError ? 'alert' : 'status');
}

if (typeof document !== 'undefined') {
  const form = document.querySelector('#route-form');
  const portSelect = document.querySelector('#port');
  const routes = document.querySelector('#routes');
  const status = document.querySelector('#status');
  const routeItems = new Map();
  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    const port = Number(portSelect.value);
    if (!Number.isInteger(port) || ![...portSelect.options].some((option) => Number(option.value) === port)) {
      showMessage(status, 'Select an allowed port.', true); return;
    }
    try {
      const route = await createRoute(port);
      const item = document.createElement('li');
      item.dataset.expiresAt = String(route.expiresAt);
      const link = document.createElement('a');
      link.href = route.origin + route.path;
      link.target = '_blank';
      link.rel = 'noopener noreferrer';
      link.textContent = `Open preview on port ${route.port}`;
      const expires = document.createElement('span');
      expires.textContent = ` (expires ${new Date(route.expiresAt).toLocaleString()}) `;
      const revoke = document.createElement('button');
      revoke.type = 'button'; revoke.textContent = 'Revoke preview';
      revoke.addEventListener('click', async () => {
        revoke.disabled = true;
        try {
          await revokeRoute(route.id);
          item.remove(); routeItems.delete(route.id);
          showMessage(status, 'Preview revoked.');
        } catch (error) { revoke.disabled = false; showMessage(status, error.message, true); }
      });
      item.append(link, expires, revoke);
      routes.append(item); routeItems.set(route.id, item);
      showMessage(status, 'Preview route created.');
    } catch (error) { showMessage(status, error.message, true); }
  });
  window.setInterval(() => {
    for (const [id, item] of routeItems) {
      if (Number(item.dataset.expiresAt) <= Date.now()) {
        item.remove(); routeItems.delete(id);
      }
    }
  }, 30_000);
}
