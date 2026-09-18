using System;
using System.Collections;
using System.Collections.Generic;
using System.Diagnostics;
using System.IO;
using System.Linq;
using System.Security.Cryptography;
using System.Text;
using System.Text.RegularExpressions;
using System.Threading;
using System.Threading.Tasks;
using System.Web.Script.Serialization;
using System.Windows.Forms;

internal static class Jouzu {
    static readonly string Root = AppDomain.CurrentDomain.BaseDirectory;
    static readonly JavaScriptSerializer Json = new JavaScriptSerializer { MaxJsonLength = Int32.MaxValue };
    static string Pointer { get { return Path.Combine(Root, "current.json"); } }
    static Dictionary<string, object> ReadJson(string path) { return (Dictionary<string, object>)Json.DeserializeObject(File.ReadAllText(path, Encoding.UTF8)); }
    static string Text(Dictionary<string, object> value, string key) { return value.ContainsKey(key) ? Convert.ToString(value[key]) : ""; }
    static string Digest(string path) { using (var file = File.OpenRead(path)) using (var hash = SHA256.Create()) return BitConverter.ToString(hash.ComputeHash(file)).Replace("-", "").ToLowerInvariant(); }
    static string LongPath(string path) {
        if (path.StartsWith(@"\\?\")) return path;
        return path.StartsWith(@"\\") ? @"\\?\UNC\" + path.Substring(2) : @"\\?\" + path;
    }
    static void RegularPath(string path, HashSet<string> checkedPaths) {
        for (var item = new FileInfo(path); item != null; item = item.Directory == null ? null : new FileInfo(item.Directory.FullName)) {
            if (!checkedPaths.Add(item.FullName)) break;
            if ((File.GetAttributes(item.FullName) & FileAttributes.ReparsePoint) != 0) throw new Exception("Linked files are not allowed in the program image: " + path);
            if (String.Equals(item.FullName.TrimEnd('\\'), LongPath(Root).TrimEnd('\\'), StringComparison.OrdinalIgnoreCase)) break;
        }
    }
    static IEnumerable<string> PayloadFiles(string directory, HashSet<string> checkedPaths) {
        RegularPath(directory, checkedPaths);
        foreach (string file in Directory.EnumerateFiles(directory)) yield return file;
        foreach (string child in Directory.EnumerateDirectories(directory))
            foreach (string file in PayloadFiles(child, checkedPaths)) yield return file;
    }
    static string VersionPath(string id) {
        if (!Regex.IsMatch(id, "^[0-9][a-z0-9.-]{0,99}$") || id.Contains("..")) throw new Exception("Invalid installed version identifier.");
        return Path.Combine(Root, "versions", id);
    }
    static string Verify(string id, bool full = true, Action<string> report = null) {
        string directory = LongPath(VersionPath(id)), manifest = Path.Combine(directory, "manifest.json");
        var checkedPaths = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
        if (report != null) report("Reading manifest: " + manifest);
        RegularPath(manifest, checkedPaths);
        var data = ReadJson(manifest);
        if (Text(data, "releaseId") != id) throw new Exception("The installed version manifest differs.");
        if (Text(data, "signing") != "unsigned-development") throw new Exception("This preview launcher requires an unsigned development image.");
        var seen = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
        int checkedFiles = 0, totalFiles = ((object[])data["files"]).Length;
        if (full) Console.Write("Verifying files [                    ] 0/" + totalFiles);
        foreach (Dictionary<string, object> entry in (object[])data["files"]) {
            string relative = Text(entry, "path");
            if (relative.Length == 0 || relative.Contains("\\") || relative.Contains(":") || relative.Split('/').Any(p => p == ".." || p == "." || p.Length == 0) || !seen.Add(relative)) throw new Exception("Invalid program manifest path.");
            string file = Path.Combine(directory, relative.Replace('/', Path.DirectorySeparatorChar));
            if (!full && relative != "node/node.exe" && relative != "bootstrap.mjs" && relative != "app/node_modules/jouzu/dist/cli.js") continue;
            if (report != null) report("Checking SHA-256: " + relative);
            RegularPath(file, checkedPaths);
            if (Digest(file) != Text(entry, "sha256")) throw new Exception("Jouzu needs repair. A program file differs: " + relative);
            if (full && (++checkedFiles % 128 == 0 || checkedFiles == totalFiles)) {
                int filled = checkedFiles * 20 / Math.Max(1, totalFiles);
                Console.Write("\rVerifying files [" + new string('=', filled) + new string(' ', 20 - filled) + "] " + checkedFiles + "/" + totalFiles);
            }
        }
        if (full) Console.WriteLine("\nChecking the installed file list…");
        if (full) foreach (string file in PayloadFiles(directory, checkedPaths)) {
            RegularPath(file, checkedPaths);
            string relative = file.Substring(directory.Length + 1).Replace('\\', '/');
            if (relative != "manifest.json" && !seen.Contains(relative)) throw new Exception("Unlisted program file: " + relative);
        }
        foreach (string required in new [] { "node/node.exe", "bootstrap.mjs", "app/node_modules/jouzu/dist/cli.js", "git/bin/bash.exe", "terminal/WindowsTerminal.exe" }) {
            if (!seen.Contains(required)) throw new Exception("The program manifest is missing " + required);
            string requiredPath = Path.Combine(directory, required.Replace('/', '\\'));
            if (report != null) report("Checking required file: " + required);
            RegularPath(requiredPath, checkedPaths);
            if (!File.Exists(requiredPath)) throw new Exception("A required program file is missing: " + required);
        }
        return VersionPath(id);
    }
    internal static string Quote(string value) {
        var result = new StringBuilder("\""); int slashes = 0;
        foreach (char c in value) {
            if (c == '\\') { slashes++; continue; }
            if (c == '"') { result.Append('\\', slashes * 2 + 1); result.Append(c); }
            else { result.Append('\\', slashes); result.Append(c); }
            slashes = 0;
        }
        result.Append('\\', slashes * 2); return result.Append('"').ToString();
    }
    static ProcessStartInfo StartInfo(string exe, IEnumerable<string> args, string cwd, bool hidden) {
        var info = new ProcessStartInfo(exe, String.Join(" ", args.Select(Quote))) { UseShellExecute = false, WorkingDirectory = cwd, CreateNoWindow = hidden };
        info.EnvironmentVariables["NODE_USE_SYSTEM_CA"] = "1";
        info.EnvironmentVariables["NODE_USE_ENV_PROXY"] = "1";
        info.EnvironmentVariables["JOUZU_NO_UPDATE"] = "1";
        return info;
    }
    static Process Start(string exe, IEnumerable<string> args, string cwd, bool hidden) {
        return Process.Start(StartInfo(exe, args, cwd, hidden));
    }
    internal static T CompleteWithin<T>(Func<T> action, int timeoutMs, string timeoutMessage) {
        var task = Task.Run(action);
        if (Task.WhenAny(task, Task.Delay(timeoutMs)).GetAwaiter().GetResult() != task)
            throw new Exception(timeoutMessage);
        return task.GetAwaiter().GetResult();
    }
    internal const int ActivationTimeoutMs = 90000;
    static void Diagnostic(string message) { Console.WriteLine("Jouzu diagnostic: " + message); }
    internal static void ProbeRuntime(string exe, IEnumerable<string> args, string directory, int timeoutMs = ActivationTimeoutMs) {
        var info = StartInfo(exe, args, directory, true);
        info.RedirectStandardOutput = true;
        info.RedirectStandardError = true;
        Diagnostic("Runtime command: " + Quote(exe) + " " + info.Arguments);
        Diagnostic("Working directory: " + directory + "; timeout: " + timeoutMs + " ms");
        var elapsed = Stopwatch.StartNew();
        using (var probe = new Process { StartInfo = info }) {
            var stdoutDone = new TaskCompletionSource<bool>();
            var stderrDone = new TaskCompletionSource<bool>();
            int outputLines = 0;
            bool captureClosed = false;
            var outputLock = new object();
            var outputTail = new Queue<string>();
            Action<string, string> output = (channel, line) => {
                string message = "Runtime " + channel + ": " + (line.Length > 2048 ? line.Substring(0, 2048) + " [truncated]" : line);
                lock (outputLock) {
                    if (captureClosed) return;
                    if (++outputLines <= 50) Diagnostic(message);
                    else {
                        if (outputTail.Count == 50) outputTail.Dequeue();
                        outputTail.Enqueue(message);
                    }
                }
            };
            probe.OutputDataReceived += (sender, e) => { if (e.Data == null) stdoutDone.TrySetResult(true); else output("stdout", e.Data); };
            probe.ErrorDataReceived += (sender, e) => { if (e.Data == null) stderrDone.TrySetResult(true); else output("stderr", e.Data); };
            try { probe.Start(); }
            catch (Exception error) { throw new Exception("Could not launch the bundled runtime: " + error.Message, error); }
            Diagnostic("Runtime process ID: " + probe.Id);
            probe.BeginOutputReadLine();
            probe.BeginErrorReadLine();
            bool exited = probe.WaitForExit(timeoutMs);
            if (!exited) {
                Diagnostic("Runtime exceeded its deadline after " + elapsed.ElapsedMilliseconds + " ms; stopping it.");
                try { probe.Kill(); }
                catch (InvalidOperationException) { /* The process exited at the deadline. */ }
                catch (System.ComponentModel.Win32Exception error) { Diagnostic("Could not stop runtime process " + probe.Id + ": " + error.Message); }
                if (!probe.WaitForExit(5000)) Diagnostic("Runtime process " + probe.Id + " is still running after 5000 ms.");
            }
            // Descendants can inherit the pipes. Never wait indefinitely for their EOF.
            if (!Task.WaitAll(new Task[] { stdoutDone.Task, stderrDone.Task }, 2000)) {
                Diagnostic("Runtime output capture did not finish within 2000 ms.");
                probe.CancelOutputRead();
                probe.CancelErrorRead();
            }
            lock (outputLock) {
                captureClosed = true;
                if (outputLines > 100) Diagnostic("Runtime output omitted " + (outputLines - 100) + " middle lines; final 50 lines follow.");
                foreach (string line in outputTail) Diagnostic(line);
            }
            if (!exited) throw new Exception("The runtime startup check did not exit within " + (timeoutMs / 1000.0).ToString("0.###", System.Globalization.CultureInfo.InvariantCulture) + " seconds.");
            Diagnostic("Runtime exited with code " + probe.ExitCode + " after " + elapsed.ElapsedMilliseconds + " ms.");
            if (probe.ExitCode != 0) throw new Exception("The runtime failed its startup check (exit code " + probe.ExitCode + ").");
        }
    }
    static void Activate(string id) {
        string stage = "Opening the installation lock";
        bool selectingVersion = false;
        var elapsed = Stopwatch.StartNew();
        Diagnostic("Activating release: " + id);
        try {
            using (var activationLock = new FileStream(Path.Combine(Root, "activation.lock"), FileMode.OpenOrCreate, FileAccess.ReadWrite, FileShare.None)) {
                stage = "Checking startup files";
                elapsed.Restart();
                Console.WriteLine("Jouzu setup: Checking startup files…");
                string directory = CompleteWithin(() => Verify(id, false, Diagnostic), ActivationTimeoutMs,
                    "Startup file checks did not finish within 90 seconds. See the last file check in the diagnostic output.");
                Diagnostic("Startup file checks completed after " + elapsed.ElapsedMilliseconds + " ms.");
                stage = "Testing Jouzu startup";
                elapsed.Restart();
                Console.WriteLine("Jouzu setup: Testing Jouzu startup…");
                ProbeRuntime(Path.Combine(directory, "node", "node.exe"),
                    new [] { Path.Combine(directory, "app", "node_modules", "jouzu", "dist", "cli.js"), "--version" }, directory);
                stage = "Activating Jouzu";
                selectingVersion = true;
                elapsed.Restart();
                Console.WriteLine("Jouzu setup: Activating Jouzu…");
                string previous = File.Exists(Pointer) ? Text(ReadJson(Pointer), "current") : "";
                if (previous != id) {
                    string temporary = Pointer + "." + Guid.NewGuid().ToString("N");
                    File.WriteAllText(temporary, Json.Serialize(new { current = id, previous = previous }), new UTF8Encoding(false));
                    if (File.Exists(Pointer)) File.Replace(temporary, Pointer, null); else File.Move(temporary, Pointer);
                }
                Console.WriteLine("Jouzu setup: Jouzu is ready.");
            }
        } catch (Exception error) {
            Diagnostic("Activation exception: " + error);
            string selection = selectingVersion ? "" : " The active version selection was not changed.";
            throw new Exception(stage + " failed after " + elapsed.ElapsedMilliseconds + " ms: " + error.Message + selection, error);
        }
    }
    internal sealed class FolderPreference {
        internal string Folder = "";
        internal string Warning = "";
        internal bool Remember;
    }
    internal static FolderPreference ReadFolderPreference(string path) {
        var preference = new FolderPreference();
        if (!File.Exists(path)) return preference;
        try {
            if (new FileInfo(path).Length > 16384) throw new Exception("Folder preference is too large.");
            var data = ReadJson(path);
            if (Text(data, "schemaVersion") != "1" || !data.ContainsKey("remember") || !(data["remember"] is bool)) throw new Exception("Invalid folder preference.");
            preference.Remember = (bool)data["remember"];
            if (preference.Remember) {
                string folder = Text(data, "folder");
                if (String.IsNullOrWhiteSpace(folder) || !Path.IsPathRooted(folder) || !String.Equals(Path.GetFullPath(folder), folder, StringComparison.OrdinalIgnoreCase)) throw new Exception("Invalid saved folder.");
                preference.Folder = Path.GetFullPath(folder);
                if (!Directory.Exists(preference.Folder)) preference.Warning = "The remembered folder is unavailable. Choose another folder.";
            }
        } catch {
            return new FolderPreference { Warning = "The saved folder preference could not be read. Choose a working folder." };
        }
        return preference;
    }
    internal static void SaveFolderPreference(string path, string folder, bool remember) {
        if (!Directory.Exists(folder)) throw new Exception("The working folder is unavailable. Choose another folder.");
        Directory.CreateDirectory(Path.GetDirectoryName(path));
        string temporary = path + "." + Guid.NewGuid().ToString("N") + ".tmp";
        try {
            File.WriteAllText(temporary, Json.Serialize(new { schemaVersion = 1, remember = remember, folder = remember ? Path.GetFullPath(folder) : "" }), new UTF8Encoding(false));
            if (File.Exists(path)) File.Replace(temporary, path, null); else File.Move(temporary, path);
        } finally { if (File.Exists(temporary)) File.Delete(temporary); }
    }
#if GUI
    internal static void CheckForInstallerUpdate(Form form, LinkLabel update, Func<InstallerUpdates.Offer> check) {
        // Finish the bounded check and cache it even when the user opens a folder immediately.
        var worker = new Thread(() => {
            InstallerUpdates.Offer offer;
            try { offer = check(); } catch { return; }
            if (offer == null) return;
            try {
                form.BeginInvoke((Action)(() => {
                    if (form.IsDisposed) return;
                    update.Text = "Jouzu " + offer.Version + " is available — Download update";
                    update.LinkArea = new LinkArea(update.Text.Length - "Download update".Length, "Download update".Length);
                    update.Tag = offer; update.Visible = true;
                }));
            } catch (InvalidOperationException) { /* The folder chooser has closed. */ }
        });
        worker.Start();
    }
    static string ChooseWorkingFolder(string installedVersion) {
        Application.EnableVisualStyles();
        string preferencePath = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "JouzuDesktop", "launcher.json");
        var preference = ReadFolderPreference(preferencePath);
        using (var form = new Form { Text = "Jouzu", StartPosition = FormStartPosition.CenterScreen, FormBorderStyle = FormBorderStyle.FixedDialog, MaximizeBox = false, MinimizeBox = false, AutoSize = true, AutoSizeMode = AutoSizeMode.GrowAndShrink })
        using (var layout = new TableLayoutPanel { ColumnCount = 1, AutoSize = true, Padding = new Padding(16), Dock = DockStyle.Fill }) {
            var heading = new Label { Text = "Working folder", AutoSize = true };
            var explanation = new Label { Text = "Choose where Jouzu starts commands and file work.\nSettings and sign-in are stored separately.", AutoSize = true };
            var folder = new TextBox { Text = preference.Folder, ReadOnly = true, Width = 560, AccessibleName = "Working folder", TabIndex = 0 };
            var choose = new Button { Text = preference.Folder.Length == 0 ? "Choose folder…" : "Choose another folder…", AutoSize = true, TabIndex = 1 };
            var remember = new CheckBox { Text = "Remember this folder", Checked = preference.Remember, AutoSize = true, TabIndex = 2 };
            var warning = new Label { Text = preference.Warning, AutoSize = true, MaximumSize = new System.Drawing.Size(560, 0) };
            var update = new LinkLabel { AutoSize = true, Visible = false, TabIndex = 5, AccessibleName = "Download Jouzu update" };
            update.LinkClicked += (sender, e) => {
                var offer = update.Tag as InstallerUpdates.Offer;
                if (offer == null) return;
                try { Process.Start(new ProcessStartInfo(offer.Url) { UseShellExecute = true }); }
                catch { MessageBox.Show(form, "The browser could not open. Download the Windows installer from github.com/shisa-ai/jouzu/releases.", "Jouzu", MessageBoxButtons.OK, MessageBoxIcon.Information); }
            };
            var buttons = new FlowLayoutPanel { AutoSize = true, FlowDirection = FlowDirection.LeftToRight };
            var open = new Button { Text = "Open", AutoSize = true, Enabled = Directory.Exists(folder.Text), TabIndex = 3 };
            var cancel = new Button { Text = "Cancel", AutoSize = true, DialogResult = DialogResult.Cancel, TabIndex = 4 };
            choose.Click += (sender, e) => {
                using (var picker = new FolderBrowserDialog { Description = "Choose a working folder for Jouzu", ShowNewFolderButton = true, SelectedPath = Directory.Exists(folder.Text) ? folder.Text : "" }) {
                    if (picker.ShowDialog(form) != DialogResult.OK) return;
                    folder.Text = picker.SelectedPath;
                    choose.Text = "Choose another folder…";
                    open.Enabled = Directory.Exists(folder.Text);
                    warning.Text = open.Enabled ? "" : "The working folder is unavailable. Choose another folder.";
                }
            };
            open.Click += (sender, e) => {
                if (!Directory.Exists(folder.Text)) {
                    warning.Text = "The working folder is unavailable. Choose another folder.";
                    open.Enabled = false; return;
                }
                try { SaveFolderPreference(preferencePath, folder.Text, remember.Checked); }
                catch { MessageBox.Show(form, "Jouzu could not save the folder preference. This session will still open in the selected folder.", "Jouzu", MessageBoxButtons.OK, MessageBoxIcon.Warning); }
                form.DialogResult = DialogResult.OK;
            };
            buttons.Controls.Add(open); buttons.Controls.Add(cancel);
            foreach (Control control in new Control[] { heading, explanation, folder, choose, remember, warning, update, buttons }) layout.Controls.Add(control);
            form.Controls.Add(layout); form.AcceptButton = open; form.CancelButton = cancel;
            form.Icon = System.Drawing.Icon.ExtractAssociatedIcon(Application.ExecutablePath);
            form.Shown += (sender, e) => {
                if (open.Enabled) open.Focus(); else choose.Focus();
                CheckForInstallerUpdate(form, update, () => InstallerUpdates.Check(installedVersion));
            };
            return form.ShowDialog() == DialogResult.OK ? folder.Text : null;
        }
    }
#endif
    [STAThread]
    static int Main(string[] args) {
        // Windows 10 includes .NET 4.8, but csc defaults to legacy IO behavior.
        AppContext.SetSwitch("Switch.System.IO.UseLegacyPathHandling", false);
        AppContext.SetSwitch("Switch.System.IO.BlockLongPaths", false);
        try {
            if (args.Length == 2 && args[0] == "--activate") { Activate(args[1]); return 0; }
            if (args.Length == 1 && args[0] == "--rollback") {
                string previous = Text(ReadJson(Pointer), "previous");
                if (previous.Length == 0) throw new Exception("No previous Jouzu version is retained.");
                Activate(previous);
#if GUI
                MessageBox.Show("The previous Jouzu version is ready. Open Jouzu to continue.", "Jouzu");
#endif
                return 0;
            }
            string selected = Text(ReadJson(Pointer), "current"), payload = Verify(selected, args.Length == 1 && args[0] == "--verify");
            if (args.Length == 1 && args[0] == "--verify") { Console.WriteLine("Verified " + selected); return 0; }
#if GUI
            string project;
            if (args.Length == 2 && args[0] == "--project") project = Path.GetFullPath(args[1]);
            else if (args.Length == 0) {
                project = ChooseWorkingFolder(Text(ReadJson(Path.Combine(payload, "manifest.json")), "version"));
                if (project == null) return 0;
            } else throw new Exception("Use Jouzu.exe --project <folder>, or open Jouzu without arguments to choose a working folder.");
            if (!Directory.Exists(project)) throw new Exception("The working folder does not exist.");
            string terminal = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "Microsoft", "WindowsApps", "wt.exe");
            if (!File.Exists(terminal)) terminal = Path.Combine(payload, "terminal", "WindowsTerminal.exe");
            // Windows Terminal treats semicolons as command separators. Use the
            // console host for these paths; never interpolate a shell command.
            if (project.Contains(";") || Root.Contains(";")) {
                Process.Start(new ProcessStartInfo(Path.Combine(Root, "JouzuConsole.exe")) { UseShellExecute = true, WorkingDirectory = project });
            } else {
                try { Start(terminal, new [] { "-w", "new", "new-tab", "--title", "Jouzu", "--startingDirectory", project, "--", Path.Combine(Root, "JouzuConsole.exe") }, project, false); }
                catch { Process.Start(new ProcessStartInfo(Path.Combine(Root, "JouzuConsole.exe")) { UseShellExecute = true, WorkingDirectory = project }); }
            }
            return 0;
#else
            using (var instance = new Mutex(false, "Local\\JouzuDesktop")) {
                Console.CancelKeyPress += (sender, e) => { e.Cancel = true; };
                using (var child = Start(Path.Combine(payload, "node", "node.exe"), new [] { Path.Combine(payload, "bootstrap.mjs") }.Concat(args), Environment.CurrentDirectory, false)) {
                    child.WaitForExit(); return child.ExitCode;
                }
            }
#endif
        } catch (Exception error) {
#if GUI
            MessageBox.Show(error.Message, "Jouzu", MessageBoxButtons.OK, MessageBoxIcon.Error);
#else
            Console.Error.WriteLine("Jouzu: " + (Environment.GetEnvironmentVariable("JOUZU_LAUNCHER_DEBUG") == "1" ? error.ToString() : error.Message));
#endif
            return 1;
        }
    }
}
