/** Explicit one-time local migration. Original files are never modified. */
import fs from 'node:fs';
import path from 'node:path';
import {DatabaseSync} from 'node:sqlite';
const source=path.resolve(process.argv[2]||'data');
const target=path.resolve(process.argv[3]||path.join(process.env.APPDATA,'Assistant Jeff'));
if(source===target)throw new Error('Source and destination must differ');
fs.mkdirSync(target,{recursive:true});
const dbTarget=path.join(target,'assistant.sqlite');
if(!fs.existsSync(dbTarget)){
  const db=new DatabaseSync(path.join(source,'assistant.sqlite'),{readOnly:true});
  try{db.exec(`VACUUM INTO '${dbTarget.replaceAll("'","''")}'`);}finally{db.close();}
}
for(const name of ['typesafe.dpapi','assemblyai.dpapi','gateway-key.dpapi','gateway-token.dpapi']){
  const from=path.join(source,'secrets',name),to=path.join(target,'secrets',name);
  if(fs.existsSync(from)&&!fs.existsSync(to)){fs.mkdirSync(path.dirname(to),{recursive:true});fs.copyFileSync(from,to);}
}
if(fs.existsSync(path.join(source,'gateway.json'))&&!fs.existsSync(path.join(target,'gateway.json')))fs.copyFileSync(path.join(source,'gateway.json'),path.join(target,'gateway.json'));
if(!fs.existsSync(path.join(target,'settings.json'))){
  let old={};try{old=JSON.parse(fs.readFileSync(path.join(source,'settings.json'),'utf8'));}catch{}
  const names={'Hey Jarvis':'hey_jarvis','Alexa':'alexa','Hey Mycroft':'hey_mycroft','Hey Rhasspy':'hey_rhasspy'};
  const settings={wakeWord:names[old.wake_name]||'hey_jarvis',wakeThreshold:Number.isFinite(old.threshold)?old.threshold:.5,speakReplies:old.tts!==false,autoStart:false,microphoneId:'',cloudEnabled:true,streamingModel:'whisper-rt'};
  fs.writeFileSync(path.join(target,'settings.json'),JSON.stringify(settings,null,2));
}
const db=new DatabaseSync(dbTarget,{readOnly:true});
console.log(JSON.stringify({migrated:true,integrity:db.prepare('PRAGMA integrity_check').get().integrity_check,notes:db.prepare('SELECT count(*) as n FROM notes').get().n,reminders:db.prepare('SELECT count(*) as n FROM reminders').get().n}));db.close();
