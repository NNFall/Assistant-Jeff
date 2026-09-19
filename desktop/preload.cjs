const {contextBridge,ipcRenderer}=require('electron');
const invoke=(name)=>(...args)=>ipcRenderer.invoke(`jeff:${name}`,...args);
contextBridge.exposeInMainWorld('jeff',{
  snapshot:invoke('snapshot'),command:invoke('command'),addNote:invoke('addNote'),addReminder:invoke('addReminder'),
  deleteNote:invoke('deleteNote'),deleteReminder:invoke('deleteReminder'),completeReminder:invoke('completeReminder'),
  updateSettings:invoke('updateSettings'),startVoice:invoke('startVoice'),stopVoice:invoke('stopVoice'),finishVoice:invoke('finishVoice'),activateVoice:invoke('activateVoice'),
  audioChunk:chunk=>ipcRenderer.send('jeff:audio',chunk),
  onEvent:callback=>{const listener=(_event,data)=>callback(data);ipcRenderer.on('jeff:event',listener);return()=>ipcRenderer.removeListener('jeff:event',listener);}
});
