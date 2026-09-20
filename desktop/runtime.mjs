import fs from 'node:fs';
import path from 'node:path';

export function runtimePaths({root,packaged=false,resourcesPath,appData,dataOverride}={}){
  const data=dataOverride||path.join(appData,'Assistant Jeff');
  return {data,settings:path.join(data,'windows-voice-settings.json'),
    logs:dataOverride||packaged?path.join(data,'logs','windows'):path.join(root,'work','windows-desktop','runs'),
    helper:packaged?path.join(resourcesPath,'windows-desktop','JeffWindowsDesktopHelper.exe'):path.join(root,'work','windows-desktop','bin','JeffWindowsDesktopHelper.exe'),
    winapp:packaged?path.join(resourcesPath,'winapp-runtime','winapp.exe'):path.join(root,'work','winapp-runtime','winapp.exe'),
    models:packaged?path.join(resourcesPath,'models'):path.join(root,'models'),
    piper:packaged?path.join(resourcesPath,'voice-runtime','piper','piper.exe'):path.join(root,'work','voice-runtime','piper','piper.exe'),
    denis:packaged?path.join(resourcesPath,'voices','ru_RU-denis-medium.onnx'):path.join(root,'data','tts','piper','ru_RU-denis-medium.onnx'),
    ffmpeg:packaged?path.join(resourcesPath,'voice-runtime','ffmpeg','ffmpeg.exe'):path.join(root,'work','voice-runtime','ffmpeg','ffmpeg.exe')};
}
export const VOICE_DEFAULTS=Object.freeze({activationBeep:true,denisReply:true,voiceAutoExecute:true,wakeWord:'hey_jarvis',wakeThreshold:0.5,microphoneId:'',cloudEnabled:true,transcriptionMode:'live'});
export function initializeRuntime(paths,root,{isolated=false}={}){
  fs.mkdirSync(paths.data,{recursive:true});
  if(!isolated){
    for(const relative of ['gateway.json',...['typesafe','gateway-key','gateway-token'].map(n=>`secrets/${n}.dpapi`)]){
      const source=path.join(root,'data',relative),target=path.join(paths.data,relative);
      if(fs.existsSync(source)&&!fs.existsSync(target)){fs.mkdirSync(path.dirname(target),{recursive:true});fs.copyFileSync(source,target);}
    }
  }
  let stored={};try{stored=JSON.parse(fs.readFileSync(paths.settings,'utf8'));}catch{}
  try{return validateVoiceSettings(stored);}catch{return {...VOICE_DEFAULTS};}
}
export function validateVoiceSettings(patch={},current=VOICE_DEFAULTS){
  if(!patch||typeof patch!=='object'||Array.isArray(patch))throw new Error('VOICE_SETTINGS_INVALID');
  const next={...current};
  for(const key of ['activationBeep','denisReply','voiceAutoExecute','cloudEnabled'])if(key in patch){if(typeof patch[key]!=='boolean')throw new Error('VOICE_SETTINGS_INVALID');next[key]=patch[key];}
  if('transcriptionMode' in patch){if(!['live','batch'].includes(patch.transcriptionMode))throw new Error('VOICE_SETTINGS_INVALID');next.transcriptionMode=patch.transcriptionMode;}
  if('microphoneId' in patch){if(typeof patch.microphoneId!=='string'||patch.microphoneId.length>512)throw new Error('VOICE_SETTINGS_INVALID');next.microphoneId=patch.microphoneId;}
  return next;
}
export function saveVoiceSettings(paths,patch,current){
  const next=validateVoiceSettings(patch,current);fs.writeFileSync(paths.settings+'.tmp',JSON.stringify(next,null,2));fs.renameSync(paths.settings+'.tmp',paths.settings);return next;
}
