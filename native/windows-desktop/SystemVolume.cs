using System;
using System.Collections.Generic;
using System.Runtime.InteropServices;
using System.Security.Cryptography;
using System.Text;
using System.Threading;

// Fixed CoreAudio operations; no keys, UI traversal, shell or application mixer.
internal static class SystemVolume
{
    private const double VerificationTolerancePercent = 0.05;
    private const uint DeviceStateActive = 1;
    private const int MaxOutputNameLength = 256;
    private const int EndpointNotFound = unchecked((int)0x80070490);
    private static readonly PropertyKey DeviceFriendlyName = new PropertyKey(new Guid("A45C254E-DF1C-4EFD-8020-67D146A850E0"), 14);
    private static readonly Guid VolumeInterface = new Guid("5CDF2C82-841E-4546-9722-0CF74078229A");
    private static readonly Guid EventContext = new Guid("E8180AD2-5D49-483F-9451-61E22E09BA17");

    public static object Execute(string method, Dictionary<string, object> args)
    {
        if (method == "audio_outputs_get")
        {
            if (args == null || args.Count != 0) throw new DesktopError("INVALID_ARGUMENT", false);
            return ReadAudioOutputs();
        }
        double? requested = null;
        if (method == "volume_get")
        {
            if (args.Count != 0) throw new DesktopError("INVALID_ARGUMENT");
        }
        else if (method == "volume_set")
        {
            object raw;
            if (args.Count != 1 || !args.TryGetValue("percent", out raw) ||
                !(raw is int || raw is long || raw is double || raw is decimal)) throw new DesktopError("INVALID_VOLUME_PERCENT");
            double value = Convert.ToDouble(raw, System.Globalization.CultureInfo.InvariantCulture);
            if (Double.IsNaN(value) || Double.IsInfinity(value) || value < 0 || value > 100) throw new DesktopError("INVALID_VOLUME_PERCENT");
            requested = value;
        }
        else throw new DesktopError("UNKNOWN_METHOD");

        IMMDeviceEnumerator enumerator = null; IMMDevice device = null; IAudioEndpointVolume volume = null;
        Dictionary<string, object> before = null, after = null;
        bool attempted = false; string stage = "volume_endpoint";
        try
        {
            enumerator = (IMMDeviceEnumerator)new MMDeviceEnumerator();
            Check(enumerator.GetDefaultAudioEndpoint(0, 1, out device)); // eRender, eMultimedia.
            string id; Check(device.GetId(out id));
            Guid iid = VolumeInterface; object activated;
            Check(device.Activate(ref iid, 23, IntPtr.Zero, out activated)); // CLSCTX_ALL.
            volume = (IAudioEndpointVolume)activated;
            string endpointId = EndpointHash(id);
            stage = "volume_read_before"; before = Read(volume, endpointId);
            if (!IsDefault(enumerator, id)) return Receipt(method, requested, before, null, false, false, "default_endpoint_changed", null, null);
            if (!requested.HasValue) return Receipt(method, null, before, before, true, false, "volume_read", null, null);

            stage = "volume_set"; Guid context = EventContext;
            attempted = true;
            Check(volume.SetMasterVolumeLevelScalar((float)(requested.Value / 100.0), ref context));
            // Exactly one mutation. Delayed or missing evidence only retries reads.
            stage = "volume_read_after";
            for (int attempt = 0; attempt < 3; attempt++)
            {
                if (attempt > 0) Thread.Sleep(40);
                after = Read(volume, endpointId);
                if (!IsDefault(enumerator, id)) return Receipt(method, requested, before, after, false, true, "default_endpoint_changed", null, null);
                if (Math.Abs((double)after["percent"] - requested.Value) <= VerificationTolerancePercent)
                    return Receipt(method, requested, before, after, true, true, "volume_level_verified", null, null);
            }
            return Receipt(method, requested, before, after, false, true, "volume_level_not_verified", null, null);
        }
        catch (Exception error)
        {
            if (attempted) return Receipt(method, requested, before, after, false, true, "effect_outcome_unknown", stage, "0x" + Marshal.GetHRForException(error).ToString("X8"));
            throw new DesktopError("SYSTEM_VOLUME_FAILED", stage, error, false);
        }
        finally { Release(volume); Release(device); Release(enumerator); }
    }

    // Independent readback for Windows UI actions. This path never activates a
    // volume/session interface or writes endpoint properties/default policies.
    private static object ReadAudioOutputs()
    {
        IMMDeviceEnumerator enumerator = null; IMMDeviceCollection collection = null;
        string stage = "audio_outputs_enumerate";
        try
        {
            enumerator = (IMMDeviceEnumerator)new MMDeviceEnumerator();
            string defaultId = ReadDefaultOutputId(enumerator);
            Check(enumerator.EnumAudioEndpoints(0, DeviceStateActive, out collection)); // eRender only.
            uint count; Check(collection.GetCount(out count));
            var devices = new List<object>(); bool defaultFound = defaultId == null;
            for (uint index = 0; index < count; index++)
            {
                IMMDevice device = null;
                try
                {
                    stage = "audio_outputs_device";
                    Check(collection.Item(index, out device));
                    uint state; Check(device.GetState(out state));
                    if (state != DeviceStateActive) throw new InvalidOperationException("AUDIO_OUTPUTS_CHANGED");
                    string id; Check(device.GetId(out id));
                    if (String.IsNullOrEmpty(id)) throw new InvalidOperationException("INVALID_AUDIO_OUTPUT_ID");
                    bool isDefault = String.Equals(id, defaultId, StringComparison.Ordinal);
                    defaultFound |= isDefault;
                    stage = "audio_outputs_name";
                    string name = ReadOutputName(device);
                    devices.Add(new { id = EndpointHash(id), name = name, active = true, isDefault = isDefault });
                }
                finally { Release(device); }
            }
            stage = "audio_outputs_verify_default";
            if (!defaultFound || !String.Equals(defaultId, ReadDefaultOutputId(enumerator), StringComparison.Ordinal))
                throw new InvalidOperationException("AUDIO_OUTPUTS_CHANGED");
            return new { provider = "windows_coreaudio", endpointRole = "multimedia", devices = devices,
                defaultDeviceId = defaultId == null ? null : EndpointHash(defaultId), verified = true,
                effectAttempted = false, evidence = "audio_outputs_read" };
        }
        catch (Exception error) { throw new DesktopError("SYSTEM_AUDIO_OUTPUTS_FAILED", stage, error, false); }
        finally { Release(collection); Release(enumerator); }
    }
    private static string ReadDefaultOutputId(IMMDeviceEnumerator enumerator)
    {
        IMMDevice device = null;
        try
        {
            int result = enumerator.GetDefaultAudioEndpoint(0, 1, out device); // eRender, eMultimedia.
            if (result == EndpointNotFound) return null;
            Check(result);
            string id; Check(device.GetId(out id));
            if (String.IsNullOrEmpty(id)) throw new InvalidOperationException("INVALID_AUDIO_OUTPUT_ID");
            return id;
        }
        finally { Release(device); }
    }
    private static string ReadOutputName(IMMDevice device)
    {
        IPropertyStore properties = null; PropVariant value = new PropVariant();
        try
        {
            Check(device.OpenPropertyStore(0, out properties)); // STGM_READ.
            PropertyKey key = DeviceFriendlyName;
            Check(properties.GetValue(ref key, ref value));
            if (value.VariantType != 31 || value.Pointer == IntPtr.Zero) // VT_LPWSTR.
                throw new InvalidOperationException("AUDIO_OUTPUT_NAME_UNAVAILABLE");
            return BoundOutputName(Marshal.PtrToStringUni(value.Pointer));
        }
        finally { PropVariantClear(ref value); Release(properties); }
    }
    private static string BoundOutputName(string value)
    {
        var name = new StringBuilder();
        for (int index = 0; value != null && index < value.Length && name.Length < MaxOutputNameLength; index++)
        {
            char character = value[index];
            if (Char.IsControl(character) || Char.IsWhiteSpace(character))
            {
                if (name.Length > 0 && name[name.Length - 1] != ' ') name.Append(' ');
            }
            else if (Char.IsHighSurrogate(character))
            {
                if (index + 1 < value.Length && Char.IsLowSurrogate(value[index + 1]))
                {
                    if (name.Length + 2 > MaxOutputNameLength) break;
                    name.Append(character); name.Append(value[++index]);
                }
            }
            else if (!Char.IsLowSurrogate(character)) name.Append(character);
        }
        string result = name.ToString().Trim();
        if (result.Length == 0) throw new InvalidOperationException("AUDIO_OUTPUT_NAME_UNAVAILABLE");
        return result;
    }

    private static object Receipt(string operation, double? requested, object before, object after, bool verified, bool attempted, string evidence, string stage, string providerCode)
    {
        return new { operation = operation, provider = "windows_coreaudio", endpointRole = "multimedia", requestedPercent = requested,
            before = before, after = after, verified = verified, effectAttempted = attempted, evidence = evidence, stage = stage, providerCode = providerCode };
    }
    private static Dictionary<string, object> Read(IAudioEndpointVolume volume, string endpointId)
    {
        float scalar; bool muted;
        Check(volume.GetMasterVolumeLevelScalar(out scalar)); Check(volume.GetMute(out muted));
        if (Single.IsNaN(scalar) || Single.IsInfinity(scalar) || scalar < 0 || scalar > 1) throw new InvalidOperationException("INVALID_VOLUME_READBACK");
        return new Dictionary<string, object> { { "percent", (double)scalar * 100.0 }, { "muted", muted }, { "endpointId", endpointId } };
    }
    private static bool IsDefault(IMMDeviceEnumerator enumerator, string expectedId)
    {
        IMMDevice current = null;
        try { Check(enumerator.GetDefaultAudioEndpoint(0, 1, out current)); string id; Check(current.GetId(out id)); return String.Equals(expectedId, id, StringComparison.Ordinal); }
        finally { Release(current); }
    }
    private static string EndpointHash(string id)
    {
        using (var hash = SHA256.Create()) return "audio_" + BitConverter.ToString(hash.ComputeHash(Encoding.UTF8.GetBytes(id))).Replace("-", "").ToLowerInvariant().Substring(0, 24);
    }
    private static void Check(int result) { Marshal.ThrowExceptionForHR(result); }
    private static void Release(object value) { if (value != null && Marshal.IsComObject(value)) Marshal.ReleaseComObject(value); }

    [ComImport, Guid("BCDE0395-E52F-467C-8E3D-C4579291692E")] private class MMDeviceEnumerator { }
    [ComImport, Guid("A95664D2-9614-4F35-A746-DE8DB63617E6"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    private interface IMMDeviceEnumerator
    {
        [PreserveSig] int EnumAudioEndpoints(int flow, uint mask, out IMMDeviceCollection devices);
        [PreserveSig] int GetDefaultAudioEndpoint(int flow, int role, out IMMDevice device);
        [PreserveSig] int GetDevice([MarshalAs(UnmanagedType.LPWStr)] string id, out IMMDevice device);
        [PreserveSig] int RegisterEndpointNotificationCallback(IntPtr callback);
        [PreserveSig] int UnregisterEndpointNotificationCallback(IntPtr callback);
    }
    [ComImport, Guid("D666063F-1587-4E43-81F1-B948E807363F"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    private interface IMMDevice
    {
        [PreserveSig] int Activate(ref Guid iid, uint context, IntPtr parameters, [MarshalAs(UnmanagedType.IUnknown)] out object result);
        [PreserveSig] int OpenPropertyStore(uint access, out IPropertyStore properties);
        [PreserveSig] int GetId([MarshalAs(UnmanagedType.LPWStr)] out string id);
        [PreserveSig] int GetState(out uint state);
    }
    [ComImport, Guid("0BD7A1BE-7A1A-44DB-8397-CC5392387B5E"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    private interface IMMDeviceCollection
    {
        [PreserveSig] int GetCount(out uint count);
        [PreserveSig] int Item(uint index, out IMMDevice device);
    }
    // These are the first three native IPropertyStore slots. Do not expose its
    // trailing SetValue/Commit methods: endpoint property access is read-only.
    [ComImport, Guid("886D8EEB-8CF2-4446-8D02-CDBA1DBDCF99"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    private interface IPropertyStore
    {
        [PreserveSig] int GetCount(out uint count);
        [PreserveSig] int GetAt(uint index, out PropertyKey key);
        [PreserveSig] int GetValue(ref PropertyKey key, ref PropVariant value);
    }
    [StructLayout(LayoutKind.Sequential)]
    private struct PropertyKey
    {
        public Guid FormatId; public uint PropertyId;
        public PropertyKey(Guid formatId, uint propertyId) { FormatId = formatId; PropertyId = propertyId; }
    }
    [StructLayout(LayoutKind.Sequential)]
    private struct PropVariant
    {
        public ushort VariantType; private ushort Reserved1, Reserved2, Reserved3;
        public IntPtr Pointer; private IntPtr UnionTail;
        // Full native union storage: 24 bytes on x64, 16 on x86. A pointer-only
        // definition is too small when IPropertyStore writes the PROPVARIANT.
    }
    [DllImport("ole32.dll", ExactSpelling = true)]
    private static extern int PropVariantClear(ref PropVariant value);
    // Keep native vtable order, including unused slots before the methods used here.
    [ComImport, Guid("5CDF2C82-841E-4546-9722-0CF74078229A"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    private interface IAudioEndpointVolume
    {
        [PreserveSig] int RegisterControlChangeNotify(IntPtr callback);
        [PreserveSig] int UnregisterControlChangeNotify(IntPtr callback);
        [PreserveSig] int GetChannelCount(out uint count);
        [PreserveSig] int SetMasterVolumeLevel(float level, ref Guid context);
        [PreserveSig] int SetMasterVolumeLevelScalar(float level, ref Guid context);
        [PreserveSig] int GetMasterVolumeLevel(out float level);
        [PreserveSig] int GetMasterVolumeLevelScalar(out float level);
        [PreserveSig] int SetChannelVolumeLevel(uint channel, float level, ref Guid context);
        [PreserveSig] int SetChannelVolumeLevelScalar(uint channel, float level, ref Guid context);
        [PreserveSig] int GetChannelVolumeLevel(uint channel, out float level);
        [PreserveSig] int GetChannelVolumeLevelScalar(uint channel, out float level);
        [PreserveSig] int SetMute([MarshalAs(UnmanagedType.Bool)] bool muted, ref Guid context);
        [PreserveSig] int GetMute([MarshalAs(UnmanagedType.Bool)] out bool muted);
    }
}
