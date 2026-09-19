const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('lab', {
  start: () => ipcRenderer.invoke('lab:start'),
  state: () => ipcRenderer.invoke('lab:state'),
  run: (request) => {
    if (!request || !['tabs', 'music'].includes(request.scenario)
        || typeof request.command !== 'string' || !request.command.trim()
        || request.command.length > 1024) {
      return Promise.reject(new Error('Введите команду до 1024 символов и выберите сценарий.'));
    }
    return ipcRenderer.invoke('lab:run', { scenario: request.scenario, command: request.command.trim() });
  },
  stop: () => ipcRenderer.invoke('lab:stop'),
  onProgress: (callback) => {
    if (typeof callback !== 'function') throw new TypeError('Expected a callback');
    const listener = (_event, data) => callback(data);
    ipcRenderer.on('lab:progress', listener);
    return () => ipcRenderer.removeListener('lab:progress', listener);
  },
});
