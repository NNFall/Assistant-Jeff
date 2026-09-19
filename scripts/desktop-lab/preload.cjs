const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('lab', {
  start: () => ipcRenderer.invoke('lab:start'),
  state: () => ipcRenderer.invoke('lab:state'),
  run: (request) => {
    if (!request || typeof request.command !== 'string' || !request.command.trim()
        || request.command.length > 1024) {
      return Promise.reject(new Error('Введите команду до 1024 символов.'));
    }
    return ipcRenderer.invoke('lab:run', { command: request.command.trim() });
  },
  history: () => ipcRenderer.invoke('lab:history'),
  readRun: (request) => {
    if (!request || typeof request.runId !== 'string' || !/^[a-zA-Z0-9_-]{1,160}$/.test(request.runId)) {
      return Promise.reject(new Error('Некорректный идентификатор записи журнала.'));
    }
    return ipcRenderer.invoke('lab:readRun', { runId: request.runId });
  },
  openLogs: () => ipcRenderer.invoke('lab:openLogs'),
  stop: () => ipcRenderer.invoke('lab:stop'),
  onProgress: (callback) => {
    if (typeof callback !== 'function') throw new TypeError('Expected a callback');
    const listener = (_event, data) => callback(data);
    ipcRenderer.on('lab:progress', listener);
    return () => ipcRenderer.removeListener('lab:progress', listener);
  },
});
