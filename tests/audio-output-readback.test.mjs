import test from 'node:test';
import assert from 'node:assert/strict';
import { after } from 'node:test';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const sourcePath = join(root, 'native/windows-desktop/SystemVolume.cs');
const source = readFileSync(sourcePath, 'utf8');
const compiler = process.platform === 'win32'
  ? join(process.env.WINDIR || 'C:\\Windows', 'Microsoft.NET/Framework64/v4.0.30319/csc.exe') : '';
const canCompile = !!compiler && existsSync(compiler);
let temporaryDirectory;
let harness;

after(() => {
  if (!temporaryDirectory) return;
  const temporaryRoot = resolve(tmpdir()) + sep;
  assert.ok(resolve(temporaryDirectory).startsWith(temporaryRoot));
  assert.ok(temporaryDirectory.split(sep).at(-1).startsWith('jeff-audio-readback-'));
  rmSync(temporaryDirectory, { recursive: true, force: true });
});

// Compile only the owned source with a minimal error type. No shared helper
// build, UI automation, microphone, volume setter or user records are involved.
function runHarness(mode = 'contract') {
  if (!harness) {
    temporaryDirectory = mkdtempSync(join(tmpdir(), 'jeff-audio-readback-'));
    const harnessPath = join(temporaryDirectory, 'ReadbackHarness.cs');
    harness = join(temporaryDirectory, 'ReadbackHarness.exe');
    writeFileSync(harnessPath, String.raw`
using System;
using System.Collections.Generic;
using System.Reflection;
using System.Runtime.InteropServices;
using System.Web.Script.Serialization;
internal sealed class DesktopError : Exception {
    public readonly string Code; public readonly bool? EffectAttempted;
    public DesktopError(string code) : base(code) { Code = code; }
    public DesktopError(string code, bool attempted) : base(code) { Code = code; EffectAttempted = attempted; }
    public DesktopError(string code, string stage, Exception error, bool attempted) : base(code) { Code = code; EffectAttempted = attempted; }
}
internal static class ReadbackHarness {
    private static object Invoke(string name, object value) {
        return typeof(SystemVolume).GetMethod(name, BindingFlags.NonPublic | BindingFlags.Static).Invoke(null, new object[] { value });
    }
    [STAThread] private static void Main(string[] args) {
        Console.OutputEncoding = new System.Text.UTF8Encoding(false);
        object output;
        if (args.Length == 1 && args[0] == "live") {
            output = SystemVolume.Execute("audio_outputs_get", new Dictionary<string, object>());
        } else {
            int rejected = 0;
            foreach (var values in new Dictionary<string, object>[] {
                null, new Dictionary<string, object> { { "deviceId", "synthetic" } },
                new Dictionary<string, object> { { "percent", 50 } },
                new Dictionary<string, object> { { "role", "communications" } }
            }) {
                try { SystemVolume.Execute("audio_outputs_get", values); }
                catch (DesktopError error) {
                    if (error.Code == "INVALID_ARGUMENT" && error.EffectAttempted == false) rejected++;
                    else throw;
                }
            }
            bool emptyNameRejected = false;
            try { Invoke("BoundOutputName", " \t\r\n"); }
            catch (TargetInvocationException error) { emptyNameRejected = error.InnerException is InvalidOperationException; }
            Type variant = typeof(SystemVolume).GetNestedType("PropVariant", BindingFlags.NonPublic);
            Type propertyKey = typeof(SystemVolume).GetNestedType("PropertyKey", BindingFlags.NonPublic);
            output = new {
                rejected = rejected, variantSize = Marshal.SizeOf(variant),
                pointerOffset = Marshal.OffsetOf(variant, "Pointer").ToInt32(), propertyKeySize = Marshal.SizeOf(propertyKey),
                normalizedName = Invoke("BoundOutputName", " \tДинамики\r\n(USB)\0 "),
                boundedName = Invoke("BoundOutputName", new String('x', 255) + "\uD83C\uDFB5"),
                longName = Invoke("BoundOutputName", new String('x', 300)),
                emptyNameRejected = emptyNameRejected, endpointHash = Invoke("EndpointHash", "synthetic-output-endpoint")
            };
        }
        Console.WriteLine(new JavaScriptSerializer().Serialize(output));
    }
}
`, 'utf8');
    execFileSync(compiler, ['/nologo', '/target:exe', '/platform:x64', '/codepage:65001',
      '/reference:System.Web.Extensions.dll', `/out:${harness}`, sourcePath, harnessPath],
    { encoding: 'utf8', timeout: 30_000, windowsHide: true });
  }
  return JSON.parse(execFileSync(harness, [mode], { encoding: 'utf8', timeout: 15_000, windowsHide: true }));
}

test('audio output observation is isolated from setters and reads render endpoints with cleanup', () => {
  const readback = source.slice(source.indexOf('private static object ReadAudioOutputs()'), source.indexOf('private static object Receipt('));
  assert.ok(readback.length > 0);
  assert.match(readback, /EnumAudioEndpoints\(0,\s*DeviceStateActive,/);
  assert.match(readback, /OpenPropertyStore\(0,/);
  assert.match(readback, /PropVariantClear\(ref value\);\s*Release\(properties\)/);
  assert.match(readback, /finally\s*\{\s*Release\(device\);/);
  assert.match(readback, /finally\s*\{\s*Release\(collection\);\s*Release\(enumerator\);/);
  assert.doesNotMatch(readback, /\.(?:Set\w*|Activate|Start|SendInput|Write\w*)\s*\(|PolicyConfig/);
  assert.match(readback, /String\.Equals\(defaultId,\s*ReadDefaultOutputId\(enumerator\)/);
  assert.match(readback, /defaultId == null \? null : EndpointHash\(defaultId\)/);
  assert.match(readback, /id = EndpointHash\(id\)/);
});

test('native readback rejects extra arguments, preserves x64 ABI and bounds display names', { skip: !canCompile }, () => {
  const result = runHarness();
  assert.equal(result.rejected, 4);
  assert.equal(result.variantSize, 24);
  assert.equal(result.pointerOffset, 8);
  assert.equal(result.propertyKeySize, 20);
  assert.equal(result.normalizedName, 'Динамики (USB)');
  assert.equal(result.boundedName, 'x'.repeat(255));
  assert.equal(result.longName, 'x'.repeat(256));
  assert.equal(result.emptyNameRejected, true);
  assert.equal(result.endpointHash, 'audio_' + createHash('sha256').update('synthetic-output-endpoint').digest('hex').slice(0, 24));
});

test('live audio output readback returns only the fixed public contract', {
  skip: !canCompile || process.env.JEFF_AUDIO_OUTPUTS_LIVE_TEST !== '1',
}, () => {
  const result = runHarness('live');
  assert.deepEqual(Object.keys(result).sort(), ['defaultDeviceId', 'devices', 'effectAttempted', 'endpointRole', 'evidence', 'provider', 'verified']);
  assert.equal(result.provider, 'windows_coreaudio');
  assert.equal(result.endpointRole, 'multimedia');
  assert.equal(result.verified, true);
  assert.equal(result.effectAttempted, false);
  assert.equal(result.evidence, 'audio_outputs_read');
  assert.ok(Array.isArray(result.devices));
  const identifiers = new Set();
  for (const device of result.devices) {
    assert.deepEqual(Object.keys(device).sort(), ['active', 'id', 'isDefault', 'name']);
    assert.match(device.id, /^audio_[a-f0-9]{24}$/);
    assert.ok(!identifiers.has(device.id));
    identifiers.add(device.id);
    assert.equal(device.active, true);
    assert.equal(typeof device.name, 'string');
    assert.ok(device.name.length > 0 && device.name.length <= 256);
    assert.doesNotMatch(device.name, /[\u0000-\u001f\u007f-\u009f]/u);
    assert.equal(device.isDefault, device.id === result.defaultDeviceId);
  }
  if (result.defaultDeviceId !== null) assert.ok(identifiers.has(result.defaultDeviceId));
  assert.equal(result.devices.filter(device => device.isDefault).length, result.defaultDeviceId === null ? 0 : 1);
});
