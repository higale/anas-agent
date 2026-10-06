// Served from the plugin's own origin. No Anas renderer internals are exposed.
export const pluginSdk = `(() => {
  const pending = new Map();
  let sequence = 0;
  const invoke = (method, params) => {
    if (window.anasPluginTransport) return window.anasPluginTransport.invoke(method, params);
    if (window.parent === window) return Promise.reject(new Error('Plugin host is unavailable.'));
    if (pending.size >= 32) return Promise.reject(new Error('Too many pending plugin requests.'));
    const id = ++sequence;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { pending.delete(id); reject(new Error('Plugin host request timed out.')); }, 65000);
      pending.set(id, { resolve, reject, timer });
      window.parent.postMessage({ channel: 'anas-plugin-request', id, method, params }, '*');
    });
  };
  window.addEventListener('message', event => {
    if (event.source !== window.parent || event.data?.channel !== 'anas-plugin-response') return;
    const request = pending.get(event.data.id);
    if (!request) return;
    pending.delete(event.data.id);
    clearTimeout(request.timer);
    if (event.data.error) request.reject(new Error(event.data.error));
    else request.resolve(event.data.result);
  });
  window.anas = Object.freeze({
    getInfo: () => invoke('host.info'),
    openExternal: url => invoke('host.openExternal', { url }),
    data: Object.freeze({ get: key => invoke('data.get', { key }), set: (key, value) => invoke('data.set', { key, value }) }),
    backend: Object.freeze({ call: (method, params) => invoke('backend.call', { method, params }) })
  });
})();`
