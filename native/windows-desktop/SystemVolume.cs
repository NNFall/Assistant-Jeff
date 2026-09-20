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
    private static readonly Guid VolumeInterface = new Guid("5CDF2C82-841E-4546-9722-0CF74078229A");
    private static readonly Guid EventContext = new Guid("E8180AD2-5D49-483F-9451-61E22E09BA17");

    public static object Execute(string method, Dictionary<string, object> args)
    {
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
        [PreserveSig] int EnumAudioEndpoints(int flow, uint mask, out IntPtr devices);
        [PreserveSig] int GetDefaultAudioEndpoint(int flow, int role, out IMMDevice device);
        [PreserveSig] int GetDevice([MarshalAs(UnmanagedType.LPWStr)] string id, out IMMDevice device);
        [PreserveSig] int RegisterEndpointNotificationCallback(IntPtr callback);
        [PreserveSig] int UnregisterEndpointNotificationCallback(IntPtr callback);
    }
    [ComImport, Guid("D666063F-1587-4E43-81F1-B948E807363F"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    private interface IMMDevice
    {
        [PreserveSig] int Activate(ref Guid iid, uint context, IntPtr parameters, [MarshalAs(UnmanagedType.IUnknown)] out object result);
        [PreserveSig] int OpenPropertyStore(uint access, out IntPtr properties);
        [PreserveSig] int GetId([MarshalAs(UnmanagedType.LPWStr)] out string id);
        [PreserveSig] int GetState(out uint state);
    }
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
