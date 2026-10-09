// Served from the plugin's package origin; the only transport is its host-owned MessagePort.
export const pluginSdk = `(() => {
  let port, context, lifecycle, action, sequence = 0;
  const pending = new Map(), controllers = new Map(), listeners = new Set();
  let connect, commands = Promise.resolve();
  const connected = new Promise(resolve => { connect = resolve; });
  const request = async (method, params) => {
    await connected;
    const id = String(++sequence);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { pending.delete(id); reject(new Error('Plugin host request timed out.')); }, 60000);
      pending.set(id, { resolve, reject, timer });
      port.postMessage({ id, method, params });
    });
  };
  const invoke = (method, params) => request('invoke', { method, params });
  const freeze = value => { if (document.body) document.body.inert = value; };
  const receive = async event => {
    const message = event.data;
    if (message.type === 'reply') {
      const item = pending.get(message.id);
      if (!item) return;
      pending.delete(message.id); clearTimeout(item.timer);
      message.error ? item.reject(new Error(message.error)) : item.resolve(message.result);
    } else if (message.type === 'context') {
      const previous = context; context = message.context;
      freeze(context.phase !== 'active');
      if (!previous || previous.location !== context.location || previous.phase !== context.phase)
        for (const listener of listeners) listener({ instanceId: context.view.content.instanceId, location: context.location });
    } else if (message.type === 'cancel') {
      controllers.get(message.requestId)?.abort();
    } else if (message.type === 'command') {
      const command = message.command, controller = new AbortController();
      controllers.set(command.requestId, controller);
      commands = commands.then(async () => {
      try {
        controller.signal.throwIfAborted();
        let result = null;
        if (command.kind === 'action') {
          if (!action) throw new Error('No toolbar action handler.');
          await action(command.payload.actionId);
        } else {
          const handler = lifecycle?.[command.kind];
          if (!handler && command.kind === 'prepare') throw new Error('This plugin has not registered a page handoff lifecycle.');
          if (command.kind === 'prepare') freeze(true);
          if (handler) result = (await handler({ ...command.payload, signal: controller.signal,
            transferId: command.transferId, context: await request('context') })) ?? null;
          controller.signal.throwIfAborted();
          if (command.kind === 'resume' || command.kind === 'activate') freeze(false);
        }
        if (!controller.signal.aborted) await request('complete', { requestId: command.requestId, result: JSON.parse(JSON.stringify(result)), failed: false });
      } catch {
        if (!controller.signal.aborted) await request('complete', { requestId: command.requestId, result: null, failed: true });
      } finally { controllers.delete(command.requestId); }
      }).catch(() => {});
    }
  };
  window.addEventListener('message', event => {
    if (event.source !== window.parent || event.data?.type !== 'anas:connect' || !event.ports[0]) return;
    if (port) port.close();
    port = event.ports[0]; port.onmessage = receive; port.start(); connect();
  });
  window.parent.postMessage({ type: 'anas:ready' }, '*');
  window.addEventListener('keydown', event => {
    if (event.key === 'Escape' && !event.defaultPrevented && !event.isComposing && !event.repeat
      && !event.ctrlKey && !event.altKey && !event.metaKey && !event.shiftKey) void request('escape').catch(() => {});
  });
  window.addEventListener('pagehide', () => { for (const controller of controllers.values()) controller.abort(); port?.close(); });
  window.anas = Object.freeze({
    getContext: () => request('context'),
    registerLifecycle: handlers => { if (lifecycle) throw new Error('Page lifecycle already registered.'); lifecycle = handlers; },
    ready: () => request('ready'), failed: () => request('failed'),
    getInfo: () => invoke('host.info'),
    openView: options => invoke('host.openView', options),
    moveView: target => invoke('host.moveView', typeof target === 'string' ? { location: target } : target),
    onViewChanged: listener => { listeners.add(listener); return () => listeners.delete(listener); },
    setToolbar: toolbar => request('toolbar', toolbar),
    onToolbarAction: listener => { if (action) throw new Error('Toolbar handler already registered.'); action = listener;
      return () => { if (action === listener) action = undefined; }; },
    getHome: () => invoke('host.home'), openHome: () => invoke('host.openHome'),
    getLanguageResources: () => invoke('host.languages'),
    openExternal: url => invoke('host.openExternal', { url }),
    data: Object.freeze({ get: key => invoke('data.get', { key }), set: (key, value) => invoke('data.set', { key, value }) }),
    backend: Object.freeze({ call: (method, params) => invoke('backend.call', { method, params }) })
  });
})();`
