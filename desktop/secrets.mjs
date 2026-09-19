import { readFile, access } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import path from 'node:path';
import os from 'node:os';

const cache = new Map();
export async function readProtected(file) {
  if (cache.has(file)) return cache.get(file);
  if (process.platform !== 'win32') return null;
  try {
    await access(file);
    const script = `Add-Type -AssemblyName System.Security; $b=[IO.File]::ReadAllBytes($env:JEFF_SECRET_PATH); $p=[Security.Cryptography.ProtectedData]::Unprotect($b,$null,[Security.Cryptography.DataProtectionScope]::CurrentUser); [Console]::Out.Write([Text.Encoding]::UTF8.GetString($p))`;
    const value = await new Promise((resolve, reject) => execFile('powershell.exe', ['-NoProfile','-NonInteractive','-Command',script], {windowsHide:true,timeout:8000,maxBuffer:32768,env:{...process.env,JEFF_SECRET_PATH:file}}, (err,stdout)=>err?reject(new Error('Не удалось открыть защищённый ключ.')):resolve(stdout.trim())));
    if (value) cache.set(file,value);
    return value || null;
  } catch { return null; }
}
export async function getKeys(dataDir) {
  const dir=path.join(dataDir,'secrets');
  const [typesafe,assemblyai] = await Promise.all([
    process.env.TYPESAFE_API_KEY || readProtected(path.join(dir,'typesafe.dpapi')),
    process.env.ASSEMBLYAI_API_KEY || readProtected(path.join(dir,'assemblyai.dpapi'))
  ]);
  return {typesafe, assemblyai};
}
export async function legacyAssemblyKey() { return readProtected(path.join(os.homedir(),'.codex','secrets','assemblyai-api-key.dpapi')); }
