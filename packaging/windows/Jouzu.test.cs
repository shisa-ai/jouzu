using System;
using System.IO;
using System.Runtime.InteropServices;
using System.Linq;
using System.Text;
using System.Runtime.InteropServices.ComTypes;
internal static class LauncherTests {
    [DllImport("shell32.dll", SetLastError = true)] static extern IntPtr CommandLineToArgvW([MarshalAs(UnmanagedType.LPWStr)] string cmd, out int count);
    [DllImport("kernel32.dll")] static extern IntPtr LocalFree(IntPtr memory);
    [ComImport, Guid("00021401-0000-0000-C000-000000000046")] class ShellLink { }
    [ComImport, InterfaceType(ComInterfaceType.InterfaceIsIUnknown), Guid("000214F9-0000-0000-C000-000000000046")]
    interface IShellLinkW {
        void GetPath([Out, MarshalAs(UnmanagedType.LPWStr)] StringBuilder path, int count, IntPtr findData, uint flags);
    }
    static string ReadShortcut(string path) {
        object link = new ShellLink();
        try {
            ((IPersistFile)link).Load(path, 0);
            var target = new StringBuilder(32768);
            ((IShellLinkW)link).GetPath(target, target.Capacity, IntPtr.Zero, 4);
            return target.ToString();
        } finally { Marshal.FinalReleaseComObject(link); }
    }
    static void Check(bool condition, string message) { if (!condition) throw new Exception(message); }
    static void FolderPreferences() {
        string root = Path.Combine(Path.GetTempPath(), "jouzu-folder-tests-" + Guid.NewGuid().ToString("N"));
        Directory.CreateDirectory(root);
        try {
            string state = Path.Combine(root, "data", "launcher.json");
            var first = Jouzu.ReadFolderPreference(state);
            Check(!first.Remember && first.Folder == "", "First launch must require a folder and opt in to remembering");
            string folder = Path.Combine(root, "日本語 folder; & spaces");
            Directory.CreateDirectory(folder);
            Jouzu.SaveFolderPreference(state, folder, true);
            var saved = Jouzu.ReadFolderPreference(state);
            Check(saved.Remember && saved.Folder == folder && saved.Warning == "", "Remembered folder did not round trip");
            Directory.Delete(folder);
            var missing = Jouzu.ReadFolderPreference(state);
            Check(missing.Folder == folder && missing.Warning.Length > 0, "Missing folder must not fall back silently");
            string before = File.ReadAllText(state);
            bool rejected = false;
            try { Jouzu.SaveFolderPreference(state, folder, true); } catch { rejected = true; }
            Check(rejected && before == File.ReadAllText(state), "Unavailable folder overwrote preferences");
            Directory.CreateDirectory(folder);
            Jouzu.SaveFolderPreference(state, folder, false);
            Check(!Jouzu.ReadFolderPreference(state).Remember && File.ReadAllText(state).Contains("\"folder\":\"\""), "Opt out retained the folder");
            File.WriteAllText(state, "not json");
            Check(Jouzu.ReadFolderPreference(state).Warning.Length > 0, "Corrupt preference needs recovery");
            File.WriteAllText(state, "{\"schemaVersion\":1,\"remember\":true,\"folder\":\"relative\"}");
            Check(Jouzu.ReadFolderPreference(state).Folder == "", "Relative saved folder was accepted");
            File.WriteAllText(state, new string('x', 16385));
            Check(Jouzu.ReadFolderPreference(state).Warning.Length > 0, "Unbounded preference was accepted");
            Check(Directory.GetFiles(Path.GetDirectoryName(state), "*.tmp").Length == 0, "Preference write left temporary files");
        } finally { Directory.Delete(root, true); }
    }
    static string Release(string version, string suffix = "-x64-unsigned.exe", bool draft = false, bool prerelease = false) {
        string asset = "JouzuSetup-" + version + "-0123456789abcdef" + suffix;
        return "{\"tag_name\":\"v" + version + "\",\"draft\":" + draft.ToString().ToLowerInvariant() + ",\"prerelease\":" + prerelease.ToString().ToLowerInvariant() +
            ",\"assets\":[{\"state\":\"uploaded\",\"name\":\"" + asset + "\",\"browser_download_url\":\"https://github.com/shisa-ai/jouzu/releases/download/v" + version + "/" + asset + "\"}]}";
    }
    static void Updates() {
        string valid = "[" + Release("0.1.11") + "]";
        Check(InstallerUpdates.Select(valid, "0.1.10").Version == "0.1.11", "New installer missing");
        Check(InstallerUpdates.Select(valid, "0.1.11") == null, "Equal version offered");
        Check(InstallerUpdates.Select(valid, "0.1.12") == null, "Downgrade offered");
        Check(InstallerUpdates.Select(valid, "invalid") == null, "Invalid installed version accepted");
        Check(InstallerUpdates.Select("[" + Release("0.1.9") + "," + Release("0.1.12") + "," + Release("0.1.11") + "]", "0.1.8").Version == "0.1.12", "Version selection depends on feed order");
        foreach (string excluded in new [] { Release("0.1.12", "-arm64.exe"), Release("0.1.12", "-x64.exe", true), Release("0.1.12", "-x64.exe", false, true), Release("0.1.12-beta"), Release("0.1.12").Replace("uploaded", "new"), Release("0.1.12").Replace("https://github.com/", "https://evil.example/"), "{\"tag_name\":\"v0.1.12\",\"draft\":false,\"prerelease\":false,\"assets\":[]}" })
            Check(InstallerUpdates.Select("[" + excluded + "," + Release("0.1.11") + "]", "0.1.10").Version == "0.1.11", "Invalid release selected");
        Check(InstallerUpdates.Select("[" + Release("0.1.12", "-x64.exe") + "]", "0.1.10") != null, "Signed asset missing");
        Check(InstallerUpdates.Validate("0.1.12", "v0.1.12", "../evil.exe") == null, "Unsafe asset accepted");
        Check(InstallerUpdates.Validate("0.1.12", "v0.1.13", "JouzuSetup-0.1.12-x64.exe") == null, "Tag mismatch accepted");
        bool oversized = false;
        try { using (var stream = new MemoryStream(new byte[11])) InstallerUpdates.ReadBounded(stream, 10); } catch (InvalidDataException) { oversized = true; }
        Check(oversized, "Oversized response accepted");
        string root = Path.Combine(Path.GetTempPath(), "jouzu-updates-" + Guid.NewGuid().ToString("N"));
        string cache = Path.Combine(root, "installer-update.json");
        var now = new DateTime(2026, 9, 16, 0, 0, 0, DateTimeKind.Utc);
        int calls = 0;
        Func<int, string> fetch = page => { calls++; return valid; };
        try {
            Check(InstallerUpdates.Check(cache, "0.1.10", now, fetch) != null && calls == 1, "Initial discovery failed");
            Check(InstallerUpdates.Check(cache, "0.1.10", now.AddHours(23), fetch) != null && calls == 1, "Daily cache ignored");
            Check(InstallerUpdates.Check(cache, "0.1.11", now.AddHours(23), fetch) == null, "Cached offer survives upgrade");
            InstallerUpdates.Check(cache, "0.1.10", now.AddHours(24), fetch);
            Check(calls == 2, "Daily cache did not expire");
            File.WriteAllText(cache, "broken");
            Check(InstallerUpdates.Check(cache, "0.1.10", now, fetch) != null && calls == 3, "Corrupt cache did not recover");
            using (var gate = new FileStream(cache + ".lock", FileMode.OpenOrCreate, FileAccess.ReadWrite, FileShare.None))
                Check(InstallerUpdates.Check(cache, "0.1.10", now, fetch) == null && calls == 3, "Concurrent check not skipped");
            Check(InstallerUpdates.Check(cache, "0.1.10", now.AddDays(2), page => { calls++; throw new IOException("offline"); }) == null, "Offline check escaped");
            InstallerUpdates.Check(cache, "0.1.10", now.AddDays(2).AddHours(1), fetch);
            Check(calls == 4, "Failed check was not throttled");
            Check(InstallerUpdates.Check(cache, "0.1.10", now.AddDays(3), fetch) != null && calls == 5, "Offline check never recovered");
            Check(InstallerUpdates.Check(cache, "0.1.10", now, fetch) != null && calls == 6, "Future timestamp blocked check");
            Check(InstallerUpdates.Check(Path.Combine(cache, "invalid.json"), "0.1.10", now, fetch) == null, "Storage error escaped");
            File.Delete(cache);
            string fullPage = "[" + String.Join(",", Enumerable.Repeat(Release("0.1.9"), 100)) + "]";
            int pages = 0;
            Check(InstallerUpdates.Check(cache, "0.1.10", now, page => { pages++; return page == 1 ? fullPage : valid; }) != null && pages == 2, "Release pagination failed");
            File.Delete(cache); pages = 0;
            Check(InstallerUpdates.Check(cache, "0.1.10", now, page => { pages++; return fullPage; }) == null && pages == 3, "Pagination not bounded");
            File.Delete(cache);
            Check(InstallerUpdates.Check(cache, "0.1.10", now, page => "{}") == null, "Malformed response escaped");
        } finally { if (Directory.Exists(root)) Directory.Delete(root, true); }
    }
    static void UpdateNotification() {
        using (var ready = new System.Threading.ManualResetEvent(false))
        using (var form = new System.Windows.Forms.Form())
        using (var link = new System.Windows.Forms.LinkLabel { Visible = false })
        using (var timer = new System.Windows.Forms.Timer { Interval = 25 }) {
            form.Controls.Add(link);
            var deadline = DateTime.UtcNow.AddSeconds(5);
            bool rendered = false, responsive = false;
            form.Shown += (sender, e) => {
                Jouzu.CheckForInstallerUpdate(form, link, () => {
                    ready.WaitOne(3000);
                    return InstallerUpdates.Validate("0.1.11", "v0.1.11", "JouzuSetup-0.1.11-x64-unsigned.exe");
                });
                timer.Start();
            };
            timer.Tick += (sender, e) => {
                responsive = true; ready.Set();
                if (link.Visible) {
                    rendered = link.Text.Contains("0.1.11") && link.Text.Substring(link.LinkArea.Start, link.LinkArea.Length) == "Download update" &&
                        ((InstallerUpdates.Offer)link.Tag).Url == "https://github.com/shisa-ai/jouzu/releases/download/v0.1.11/JouzuSetup-0.1.11-x64-unsigned.exe";
                    form.Close();
                } else if (DateTime.UtcNow >= deadline) form.Close();
            };
            form.Show();
            while (!form.IsDisposed && DateTime.UtcNow < deadline) {
                System.Windows.Forms.Application.DoEvents();
                System.Threading.Thread.Sleep(10);
            }
            timer.Stop();
            Check(responsive && rendered, "Update notification blocked the UI or failed to render");
        }
        using (var form = new System.Windows.Forms.Form())
        using (var link = new System.Windows.Forms.LinkLabel()) {
            form.Dispose();
            using (var finished = new System.Threading.ManualResetEvent(false)) {
                Jouzu.CheckForInstallerUpdate(form, link, () => {
                    finished.Set();
                    return InstallerUpdates.Validate("0.1.11", "v0.1.11", "JouzuSetup-0.1.11-x64.exe");
                });
                Check(finished.WaitOne(3000), "Closed-form check did not finish");
            }
        }
    }
    static void ActivationLimits() {
        Check(Jouzu.CompleteWithin(() => "ready", 1000, "timeout") == "ready", "Startup check result lost");
        bool originalError = false;
        try { Jouzu.CompleteWithin<string>(() => { throw new IOException("fixture error"); }, 1000, "timeout"); }
        catch (IOException error) { originalError = error.Message == "fixture error"; }
        Check(originalError, "Startup check error was hidden");
        using (var release = new System.Threading.ManualResetEvent(false)) {
            bool timedOut = false;
            try { Jouzu.CompleteWithin(() => { release.WaitOne(1000); return true; }, 50, "fixture timeout"); }
            catch (Exception error) { timedOut = error.Message == "fixture timeout"; }
            finally { release.Set(); }
            Check(timedOut, "Startup check did not time out");
        }
        Check(Jouzu.ActivationTimeoutMs == 90000, "Activation deadline must be 90 seconds");
        string exe = System.Diagnostics.Process.GetCurrentProcess().MainModule.FileName;
        var captured = new StringWriter();
        TextWriter previousOutput = Console.Out;
        Console.SetOut(TextWriter.Synchronized(captured));
        try {
            Jouzu.ProbeRuntime(exe, new [] { "--probe-fixture", "success" }, Path.GetTempPath(), 5000);
            bool failed = false;
            try { Jouzu.ProbeRuntime(exe, new [] { "--probe-fixture", "failure" }, Path.GetTempPath(), 5000); }
            catch (Exception error) { failed = error.Message.Contains("failed its startup check (exit code 7)"); }
            Check(failed, "Failed runtime probe did not report its exit code");
            bool launchFailed = false;
            try { Jouzu.ProbeRuntime(Path.Combine(Path.GetTempPath(), Guid.NewGuid().ToString("N") + ".exe"), new string[0], Path.GetTempPath()); }
            catch (Exception error) { launchFailed = error.Message.Contains("Could not launch the bundled runtime:"); }
            Check(launchFailed, "Runtime launch failure was not identified");
            Jouzu.ProbeRuntime(exe, new [] { "--probe-fixture", "output-limit" }, Path.GetTempPath(), 5000);
            string marker = Path.Combine(Path.GetTempPath(), "jouzu-probe-" + Guid.NewGuid().ToString("N"));
            try {
                bool timedOut = false;
                try { Jouzu.ProbeRuntime(exe, new [] { "--probe-fixture", marker }, Path.GetTempPath(), 500); }
                catch (Exception error) { timedOut = error.Message.Contains("did not exit within 0.5 seconds"); }
                Check(timedOut && File.Exists(marker), "Runtime probe did not time out after starting");
                bool running = false;
                try { using (var child = System.Diagnostics.Process.GetProcessById(Int32.Parse(File.ReadAllText(marker)))) running = !child.HasExited; }
                catch (ArgumentException) { }
                Check(!running, "Timed out runtime probe was left running");
            } finally { if (File.Exists(marker)) File.Delete(marker); }
        } finally { Console.SetOut(previousOutput); }
        string log = captured.ToString();
        Check(log.Contains("Runtime command:") && log.Contains("Working directory:") && log.Contains("Runtime process ID:"), "Probe launch diagnostics missing");
        Check(log.Contains("Runtime stdout: fixture stdout") && log.Contains("Runtime stderr: fixture stderr"), "Probe output was not captured");
        Check(log.Contains("Runtime exited with code 7 after") && log.Contains("Runtime exceeded its deadline after"), "Probe timing diagnostics missing");
        Check(log.Contains("[truncated]") && !log.Contains(new string('x', 2049)), "Runtime line length limit failed");
        Check(log.Contains("Runtime output omitted 20 middle lines; final 50 lines follow.") && log.Contains("Runtime stdout: output 0") && log.Contains("Runtime stdout: output 119") && !log.Contains("Runtime stdout: output 50"), "Runtime output head/tail limit failed");
    }
    [STAThread]
    static int Main(string[] args) {
        if (args.Length == 2 && args[0] == "--probe-fixture") {
            if (args[1] == "success") return 0;
            if (args[1] == "failure") {
                Console.WriteLine("fixture stdout");
                Console.WriteLine(new string('x', 3000));
                Console.Error.WriteLine("fixture stderr");
                return 7;
            }
            if (args[1] == "output-limit") {
                for (int i = 0; i < 120; i++) Console.WriteLine("output " + i);
                return 0;
            }
            File.WriteAllText(args[1], System.Diagnostics.Process.GetCurrentProcess().Id.ToString());
            System.Threading.Thread.Sleep(30000); return 0;
        }
        if (args.Length == 2 && args[0] == "--finish-update-check") {
            var form = new System.Windows.Forms.Form();
            var link = new System.Windows.Forms.LinkLabel();
            form.Dispose();
            Jouzu.CheckForInstallerUpdate(form, link, () => {
                System.Threading.Thread.Sleep(150);
                File.WriteAllText(args[1], "completed");
                return null;
            });
            return 0;
        }
        if (args.Length == 1 && args[0] == "--live-update-check") {
            var offer = InstallerUpdates.Select(InstallerUpdates.Fetch(1), "0.0.0");
            Check(offer != null, "Published installer not found");
            Console.WriteLine("Live GitHub installer discovery: " + offer.Version + " " + offer.Url); return 0;
        }
        if (args.Length == 3 && args[0] == "--shortcut") {
            if (!String.Equals(ReadShortcut(args[1]), args[2], StringComparison.OrdinalIgnoreCase)) throw new Exception("Windows Unicode shortcut target differs");
            Console.WriteLine("Windows Unicode shortcut target passed"); return 0;
        }
        string[] values = { "", "plain", "日本語 full width　folder", "a b", "quoted\"value", "trailing\\", "C:\\space path\\", "semi;colon", "x&y", "line\nbreak", "tab\there" };
        int count;
        IntPtr parsed = CommandLineToArgvW("fixture.exe " + String.Join(" ", values.Select(Jouzu.Quote)), out count);
        if (parsed == IntPtr.Zero) throw new Exception("Windows argument parsing failed");
        try {
            if (count != values.Length + 1) throw new Exception("Argument count differs");
            for (int i = 0; i < values.Length; i++)
                if (Marshal.PtrToStringUni(Marshal.ReadIntPtr(parsed, (i + 1) * IntPtr.Size)) != values[i]) throw new Exception("Argument changed: " + i);
        } finally { LocalFree(parsed); }
        FolderPreferences();
        Updates();
        UpdateNotification();
        ActivationLimits();
        string marker = Path.Combine(Path.GetTempPath(), "jouzu-update-finished-" + Guid.NewGuid().ToString("N"));
        try {
            var info = new System.Diagnostics.ProcessStartInfo(System.Diagnostics.Process.GetCurrentProcess().MainModule.FileName,
                "--finish-update-check " + Jouzu.Quote(marker)) { UseShellExecute = false, CreateNoWindow = true };
            using (var child = System.Diagnostics.Process.Start(info)) {
                if (!child.WaitForExit(5000)) { child.Kill(); throw new Exception("Update worker did not exit"); }
                Check(child.ExitCode == 0 && File.Exists(marker), "Closing the launcher abandoned the update check");
            }
        } finally { if (File.Exists(marker)) File.Delete(marker); }
        Console.WriteLine("Windows launcher argument, folder preference, and installer update tests passed"); return 0;
    }
}
