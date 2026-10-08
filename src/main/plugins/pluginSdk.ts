// Served from the plugin's own origin. No Anas renderer internals are exposed.
export const pluginSdk = `(() => {
  const invoke = (method, params) => window.anasPluginTransport.invoke(method, params);
  window.anas = Object.freeze({
    getInfo: () => invoke('host.info'),
    openView: options => invoke('host.openView', options),
    moveView: location => invoke('host.moveView', { location }),
    onViewChanged: listener => window.anasPluginTransport.onViewChanged(listener),
    setToolbar: toolbar => window.anasPluginTransport.setToolbar(toolbar),
    onToolbarAction: listener => window.anasPluginTransport.onToolbarAction(listener),
    getHome: () => invoke('host.home'),
    openHome: () => invoke('host.openHome'),
    getLanguageResources: () => invoke('host.languages'),
    openExternal: url => invoke('host.openExternal', { url }),
    data: Object.freeze({ get: key => invoke('data.get', { key }), set: (key, value) => invoke('data.set', { key, value }) }),
    backend: Object.freeze({ call: (method, params) => invoke('backend.call', { method, params }) })
  });
})();`
