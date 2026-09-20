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
  capabilities: () => ipcRenderer.invoke('lab:capabilities'),
  clearContext: () => ipcRenderer.invoke('lab:clearContext'),
  readRun: (request) => {
    if (!request || typeof request.runId !== 'string' || !/^[a-zA-Z0-9_-]{1,160}$/.test(request.runId)) {
      return Promise.reject(new Error('Некорректный идентификатор записи журнала.'));
    }
    return ipcRenderer.invoke('lab:readRun', { runId: request.runId });
  },
  openLogs: () => ipcRenderer.invoke('lab:openLogs'),
  stop: () => ipcRenderer.invoke('lab:stop'),
  voiceStatus: () => ipcRenderer.invoke('lab:voiceStatus'),
  voiceStart: (options = {}) => ipcRenderer.invoke('lab:voiceStart', { mode: options.mode === 'manual' ? 'manual' : 'wake' }),
  voiceStop: () => ipcRenderer.invoke('lab:voiceStop'),
  voiceActivate: () => ipcRenderer.invoke('lab:voiceActivate'),
  voiceFinish: () => ipcRenderer.invoke('lab:voiceFinish'),
  voiceSettings: patch => ipcRenderer.invoke('lab:voiceSettings', patch),
  audioChunk: pcm => { if (pcm instanceof Int16Array && pcm.length === 1280) ipcRenderer.send('lab:audio', pcm); },
  speechEnded: request => ipcRenderer.invoke('lab:speechEnded', { id: typeof request?.id === 'string' ? request.id.slice(0,64) : '' }),
  dismissReminder: request => {
    if (!Number.isSafeInteger(request?.id) || request.id <= 0) return Promise.reject(new Error('Некорректное напоминание.'));
    return ipcRenderer.invoke('lab:dismissReminder', { id: request.id });
  },
  onVoiceEvent: callback => {
    if (typeof callback !== 'function') throw new TypeError('Expected a callback');
    const listener = (_event, data) => callback(data);
    ipcRenderer.on('lab:voice', listener);
    return () => ipcRenderer.removeListener('lab:voice', listener);
  },
  onProgress: (callback) => {
    if (typeof callback !== 'function') throw new TypeError('Expected a callback');
    const listener = (_event, data) => callback(data);
    ipcRenderer.on('lab:progress', listener);
    return () => ipcRenderer.removeListener('lab:progress', listener);
  },
});
