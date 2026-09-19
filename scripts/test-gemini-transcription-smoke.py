"""Authorized synthetic-only MP3 smoke. Keys remain inside the existing US host.

Runs remote Python in memory, reads existing env without mutation, writes only
local diagnostics. At most three transcription calls; no retries on network errors.
"""
import base64
import argparse
import json
import re
from pathlib import Path
import subprocess
import sys

sys.stdout.reconfigure(encoding='utf-8')

parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument('--audio', required=True, type=Path, help='Synthetic MP3 file; never a private recording')
parser.add_argument('--ssh-host', required=True, help='Explicit user@hostname target')
parser.add_argument('--ssh-key', required=True, type=Path, help='Existing SSH private key; not copied or printed')
parser.add_argument('--remote-env', required=True, help='Absolute existing server env path')
parser.add_argument('--report', required=True, type=Path, help='Local JSON report output')
args = parser.parse_args()
if not re.fullmatch(r'[A-Za-z0-9_][A-Za-z0-9_.-]*@[A-Za-z0-9][A-Za-z0-9.-]*', args.ssh_host):
    parser.error('--ssh-host must be a literal SSH target, without shell syntax')
if not args.remote_env.startswith('/') or any(c in args.remote_env for c in '\r\n\x00'):
    parser.error('--remote-env must be an absolute Unix path')
if not args.audio.is_file() or args.audio.suffix.lower() != '.mp3':
    parser.error('--audio must be an existing .mp3 file')
if not args.ssh_key.is_file():
    parser.error('--ssh-key must be an existing key file')
if args.audio.stat().st_size > 10 * 1024 * 1024:
    parser.error('--audio exceeds the 10 MiB smoke-test limit')

REMOTE = r'''
import base64, json, shlex, time, urllib.request, urllib.error
from datetime import datetime, timezone
audio = base64.b64decode(AUDIO_BASE64)
key = None
env = {}
for line in open(REMOTE_ENV, encoding='utf-8'):
    line = line.strip()
    if not line or line.startswith('#') or '=' not in line: continue
    name, value = line.split('=', 1)
    if name in ('APP_GEMINI_API_KEY', 'GEMINI_API_KEY'):
        parsed = shlex.split(value)
        env[name] = parsed[0] if parsed else ''
key = env.get('APP_GEMINI_API_KEY') or env.get('GEMINI_API_KEY')
if not key: raise SystemExit('Gemini credential missing')
base = 'https://generativelanguage.googleapis.com'
endpoint = base + '/v1beta/interactions'
records = []
uploaded = None

def request(url, body=None, method='POST', headers=None):
    hdr = {'x-goog-api-key': key}
    if headers: hdr.update(headers)
    data = body
    if isinstance(body, dict):
        data = json.dumps(body).encode()
        hdr['Content-Type'] = 'application/json'
    req = urllib.request.Request(url, data=data, headers=hdr, method=method)
    start = time.perf_counter()
    try:
        with urllib.request.urlopen(req, timeout=45) as response:
            raw = response.read(2_000_000)
            try: parsed = json.loads(raw) if raw else {}
            except Exception: parsed = {'non_json': True}
            return response.status, parsed, dict(response.headers), round((time.perf_counter()-start)*1000)
    except urllib.error.HTTPError as error:
        raw = error.read(16384).decode('utf-8', errors='replace')
        try: obj = json.loads(raw)
        except Exception: obj = {}
        info = obj.get('error', {})
        if not isinstance(info, dict): info = {}
        message = str(info.get('message', 'Provider rejected request')).replace(key, '[REDACTED]')[:1200]
        return error.code, {'error': {'status': info.get('status'), 'message': message}}, {}, round((time.perf_counter()-start)*1000)
    except Exception as error:
        return 0, {'error': {'type': type(error).__name__}}, {}, round((time.perf_counter()-start)*1000)

def text_output(obj):
    if isinstance(obj.get('output_text'), str): return obj['output_text']
    texts=[]
    for step in obj.get('steps', []):
        if step.get('type') == 'model_output':
            for block in step.get('content', []):
                if block.get('type') == 'text': texts.append(block.get('text', ''))
    if not texts:
        for block in obj.get('outputs', []):
            if block.get('type') == 'text': texts.append(block.get('text', ''))
    return ''.join(texts)

mode = 'inline'
upload_ms = 0
try:
    for index in range(3):
        total_start = time.perf_counter()
        item = {'type': 'audio', 'mime_type': 'audio/mp3'}
        if mode == 'inline': item['data'] = AUDIO_BASE64
        else: item['uri'] = uploaded['uri']
        body = {'model': 'gemini-3.5-transcribe', 'store': False, 'input': [item]}
        status, result, headers, elapsed = request(endpoint, body)
        record = {'attempt': index+1, 'mode': mode, 'http_status': status, 'api_ms': elapsed,
                  'upload_ms': upload_ms, 'total_ms': round((time.perf_counter()-total_start)*1000)+upload_ms,
                  'transcript': text_output(result), 'status': result.get('status'), 'usage': result.get('usage'),
                  'error': result.get('error'), 'response_fields': list(result.keys())}
        records.append(record)
        upload_ms = 0
        if status in (401,403,404,429,0) or status >= 500: break
        if status == 400 and mode == 'inline' and index < 2:
            start = time.perf_counter()
            st, meta, hdr, _ = request(base+'/upload/v1beta/files',
                {'file': {'display_name': 'jeff-synthetic-transcription-smoke'}}, headers={
                    'X-Goog-Upload-Protocol': 'resumable', 'X-Goog-Upload-Command': 'start',
                    'X-Goog-Upload-Header-Content-Length': str(len(audio)), 'X-Goog-Upload-Header-Content-Type': 'audio/mp3'})
            upload_url = next((v for k,v in hdr.items() if k.lower()=='x-goog-upload-url'), None)
            if not upload_url:
                records.append({'stage':'upload_start', 'http_status':st, 'error':meta.get('error')}); break
            st, meta, _, _ = request(upload_url, audio, headers={
                'X-Goog-Upload-Offset': '0', 'X-Goog-Upload-Command': 'upload, finalize', 'Content-Type':'audio/mp3'})
            uploaded = meta.get('file')
            if not uploaded:
                records.append({'stage':'upload_finalize', 'http_status':st, 'error':meta.get('error')}); break
            upload_ms = round((time.perf_counter()-start)*1000)
            mode='files'
        elif status >= 400: break
finally:
    cleanup = None
    if uploaded and uploaded.get('name', '').startswith('files/'):
        st, _, _, _ = request(base+'/v1beta/'+uploaded['name'], method='DELETE')
        cleanup = {'http_status':st, 'deleted':200 <= st < 300}
    print(json.dumps({'utc':datetime.now(timezone.utc).isoformat(), 'endpoint':endpoint,
        'model':'gemini-3.5-transcribe', 'store':False, 'source':'synthetic Microsoft Irina Desktop SAPI',
        'reference':'Джарвис, напомни мне через десять минут проверить чайник.',
        'mp3_bytes':len(audio), 'runs':records, 'file_cleanup':cleanup}, ensure_ascii=False))
'''

script = ('AUDIO_BASE64 = ' + repr(base64.b64encode(args.audio.read_bytes()).decode())
          + '\nREMOTE_ENV = ' + repr(args.remote_env) + '\n' + REMOTE)
result = subprocess.run([
    'ssh', '-o', 'BatchMode=yes', '-o', 'ConnectTimeout=10',
    '-i', str(args.ssh_key.resolve()),
    args.ssh_host, 'python3', '-'], input=script.encode(), capture_output=True, timeout=210)
if result.returncode:
    raise SystemExit(f'Remote smoke failed (exit {result.returncode}); stderr withheld')
report = json.loads(result.stdout)
args.report.parent.mkdir(parents=True, exist_ok=True)
args.report.write_text(json.dumps(report, ensure_ascii=False, indent=2), encoding='utf-8')
print(json.dumps(report, ensure_ascii=False, indent=2))
