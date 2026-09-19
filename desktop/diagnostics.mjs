import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
/** Packaged smoke: only enabled with an explicitly isolated, fresh data folder. */
export async function runDiagnostics(window,store,dataDir){
  assert.equal(store.notes().length,0);assert.equal(store.pending().length,0);
  const result=await window.webContents.executeJavaScript(`(async()=>{
    const api=window.jeff;await api.updateSettings({cloudEnabled:false,speakReplies:false});
    const note=await api.command('Запиши заметку проверка установщика');
    const reminder=await api.command('Поставь таймер на две минуты');
    const snapshot=await api.snapshot();
    const start=await api.startVoice();await api.stopVoice();
    return {note,reminder,start,version:snapshot.version,notes:snapshot.notes.length,reminders:snapshot.reminders.length,secretExposed:!!api.keys};
  })()`);
  assert.equal(result.note.ok,true);assert.equal(result.reminder.ok,true);assert.equal(result.start.ok,true);assert.equal(result.notes,1);assert.equal(result.reminders,1);assert.equal(result.secretExposed,false);
  // Allow the renderer's asynchronous snapshot refresh to complete before capture.
  await new Promise(resolve=>setTimeout(resolve,250));
  fs.writeFileSync(path.join(dataDir,'diagnostics.png'),(await window.webContents.capturePage()).toPNG());
  fs.writeFileSync(path.join(dataDir,'diagnostics.json'),JSON.stringify({ok:true,...result},null,2));
}
