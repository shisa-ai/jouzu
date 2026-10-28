"""Verify dependency text from inert pinned source archives; never runs installers."""

import argparse
import base64
import csv
import hashlib
import io
import json
import re
import tarfile
import tomllib
import zipfile
from collections import Counter
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
HERE = Path(__file__).resolve().parent
REVISION = "346d1e481757a55eb62fc066e43bbc7999b8e6dd"
COLUMNS = ["item_id", "message_id", "english", "english_location", "display_location",
           "trigger", "consumer_evidence", "translation_boundary", "evidence"]
ARCHIVES = {
    "tauri-cli.crate": ("2.12.4", "https://static.crates.io/crates/tauri-cli/tauri-cli-2.12.4.crate", "9966558da94fd1c9485d0d78f12233bea5fd4235826fb78e930fe7a26910b956"),
    "tauri-bundler.crate": ("2.10.4", "https://static.crates.io/crates/tauri-bundler/tauri-bundler-2.10.4.crate", "ec436f80e3f9dc5f87e449652cc21fd546760b5ee6b4646cec30e95b68fd9104"),
    "nsis.zip": ("3.13", "https://github.com/tauri-apps/binary-releases/releases/download/nsis-3.13/nsis-3.13.zip", "ba63dffc4410ee89193e1cb5a41989991bd77c61068da17e3156d136b7b0b3d8"),
    "nsis-upstream.zip": ("3.13 / v313", "https://codeload.github.com/kichik/nsis/zip/refs/tags/v313", "c4b08ca7c064252dbd3bb1ba28430c0e4571e7f888bfffb62259d301b3d2b0e2"),
    "dialog.crate": ("2.8.3", "https://static.crates.io/crates/tauri-plugin-dialog/tauri-plugin-dialog-2.8.3.crate", "b7461aaacf1901915ea7b9f5cd74f8224a351ed96af0a62c07fce934003cb34b"),
    "rfd.crate": ("0.16.0", "https://static.crates.io/crates/rfd/rfd-0.16.0.crate", "a15ad77d9e70a92437d8f74c35d99b4e4691128df018833e99f90bcd36152672"),
    "dialog-js.tgz": ("2.8.3", "https://registry.npmjs.org/@tauri-apps/plugin-dialog/-/plugin-dialog-2.8.3.tgz", "d78a0f18c344a8dd83c6ccf020698cae58fb0e44affc996bf7e7d7e7ba88a4dd"),
}
TAURI = "tauri-bundler-2.10.4/src/bundle/windows/nsis/"
NSIS = "nsis-3.13/"
UPSTREAM = "nsis-313/Contrib/"


class Sources:
    def __init__(self, cache):
        self.cache = Path(cache)
        self.opened = {}

    def archive_bytes(self, name):
        content = (self.cache / name).read_bytes()
        assert hashlib.sha256(content).hexdigest() == ARCHIVES[name][2], name
        return content

    def member(self, archive, member):
        if archive not in self.opened:
            content = self.archive_bytes(archive)
            self.opened[archive] = zipfile.ZipFile(io.BytesIO(content)) if archive.endswith(".zip") else tarfile.open(fileobj=io.BytesIO(content), mode="r:gz")
        handle = self.opened[archive]
        return handle.read(member) if isinstance(handle, zipfile.ZipFile) else handle.extractfile(member).read()

    def text(self, archive, member):
        return self.member(archive, member).decode("utf-8-sig")

    def lines(self, archive, member):
        return self.text(archive, member).splitlines()


def location(archive, member, number):
    return f"archive:{archive}!/{member}:{number}"


def expected_sites(sources):
    sites = {}

    def add(group, key, value, archive, member, number, category, guards=""):
        identifier = f"installer.dependencies.{group}.{key}.{number}"
        assert identifier not in sites, identifier
        sites[identifier] = dict(message_id=identifier, english=value, archive=archive,
                                member=member, line=number, category=category, guards=guards,
                                english_location=location(archive, member, number))

    archive, member = "tauri-bundler.crate", TAURI + "languages/English.nsh"
    for number, line in enumerate(sources.lines(archive, member), 1):
        match = re.match(r'LangString\s+(\w+)\s+\$\{LANG_ENGLISH\}\s+"(.*)"', line)
        if match:
            add("tauri", match[1], match[2], archive, member, number, "tauri-langstring")

    archive, member = "nsis.zip", NSIS + "Contrib/Language files/English.nsh"
    guards = []
    for number, line in enumerate(sources.lines(archive, member), 1):
        stripped = line.strip()
        if stripped.startswith(("!ifdef ", "!ifndef ", "!if ")):
            guards.append(stripped)
        elif stripped.startswith("!else"):
            guards[-1] = "else branch of " + guards[-1]
        elif stripped.startswith("!endif"):
            guards.pop()
        match = re.search(r'\$\{LangFileString\}\s+(\w+)\s+"(.*)"', line)
        if match and "!if 0" not in guards:
            add("mui", match[1], match[2], archive, member, number, "mui-language", " AND ".join(guards))
    add("mui", "EnglishAutonym", "English", archive, member, 4, "language-autonym")

    archive, member = "nsis.zip", NSIS + "Contrib/Language files/English.nlf"
    lines = sources.lines(archive, member)
    for index, line in enumerate(lines):
        match = re.fullmatch(r"# \^(\w+)", line)
        if match:
            value = lines[index + 1]
            # Preserve leading/trailing spaces and all NSIS escapes/tokens.
            if value.startswith('"') and value.endswith('"'):
                value = value[1:-1]
            add("core", match[1], value, archive, member, index + 2, "nsis-core-language")

    for number in (85, 86):
        member = NSIS + "Contrib/Modern UI 2/Localization.nsh"
        line = sources.lines("nsis.zip", member)[number - 1]
        match = re.search(r'MUI_DEFAULT\s+(\w+)\s+"(.*)"', line)
        add("localization", match[1], match[2], "nsis.zip", member, number, "language-selector-default")
    member = NSIS + "Include/MultiUser.nsh"
    for number in (213, 214, 215):
        match = re.search(r'MULTIUSER_(\w+)\s+"(.*)"', sources.lines("nsis.zip", member)[number - 1])
        add("multiuser", match[1], match[2], "nsis.zip", member, number, "multiuser-privilege")

    member = UPSTREAM + "LangDLL/resource.rc"
    for number, line in enumerate(sources.lines("nsis-upstream.zip", member), 1):
        match = re.search(r'(?:DEFPUSHBUTTON|PUSHBUTTON)\s+"(.*?)",(ID\w+)', line)
        if match:
            add("langdll", match[2], match[1], "nsis-upstream.zip", member, number, "language-selector-button")
    member = UPSTREAM + "NSISdl/nsisdl.cpp"
    selected = set(range(302, 311)) | {343, 417, 436, 440, 447, 453, 455, 467, 546, 553, 562, 569}
    for number, line in enumerate(sources.lines("nsis-upstream.zip", member), 1):
        if number in selected:
            matches = re.findall(r'"((?:[^"\\]|\\.)*)"', line)
            assert len(matches) == 1, (member, number, matches)
            add("nsisdl", str(number), matches[0], "nsis-upstream.zip", member, number, "download-plugin")
    for filename, selected in [("httpget.cpp", {15, 177, 256}), ("connection.cpp", {57, 69, 80, 131, 142, 160, 169})]:
        member = UPSTREAM + "NSISdl/" + filename
        for number, line in enumerate(sources.lines("nsis-upstream.zip", member), 1):
            if number in selected:
                value = re.findall(r'"((?:[^"\\]|\\.)*)"', line)[0]
                add("jnetlib", filename.replace(".cpp", "") + str(number), value, "nsis-upstream.zip", member, number, "download-transport")
    member = "package/dist-js/index.js"
    for number, key in [(180, "askYes"), (185, "askNo"), (211, "confirmOk"), (216, "confirmCancel")]:
        value = re.search(r"\?\? '([^']*)'", sources.lines("dialog-js.tgz", member)[number - 1])[1]
        add("dialogjs", key, value, "dialog-js.tgz", member, number, "custom-label-fallback")
    # Bounded compiler diagnostic route for a missing LangString. Preserve the
    # actual concatenated TCHAR format expressions rather than inventing a
    # flattened format string or claiming an observed compiler run.
    for member, number, key, stop, category in [
        ("nsis-313/Source/lang.cpp", 592, "named_language", ", lsn", "compiler-warning"),
        ("nsis-313/Source/lang.cpp", 594, "numeric_language", ", lsn", "compiler-warning"),
        ("nsis-313/Source/build.cpp", 3587, "immediate_envelope", ", showcode", "compiler-warning-envelope"),
        ("nsis-313/Source/build.cpp", 3663, "summary_heading", ",nw", "compiler-warning-summary"),
        ("nsis-313/Source/build.cpp", 3666, "summary_entry", ",p", "compiler-warning-summary"),
    ]:
        line = sources.lines("nsis-upstream.zip", member)[number - 1]
        start = line.index("_T(")
        value = line[start:line.index(stop, start)]
        add("compiler", key, value, "nsis-upstream.zip", member, number, category)
    member = "nsis-313/Source/build.cpp"
    line = sources.lines("nsis-upstream.zip", member)[3566 - 1]
    value = re.search(r'_T\("%u: "\)', line)[0]
    add("compiler", "diagnostic_code_prefix", value, "nsis-upstream.zip", member, 3566, "compiler-warning-envelope")
    line = sources.lines("nsis-upstream.zip", member)[3591 - 1]
    value = line[line.index("_T("):line.rindex(");")]
    add("compiler", "warning_treated_as_error", value, "nsis-upstream.zip", member, 3591, "compiler-warning-as-error")
    return sites


def read_csv(name, columns=None):
    with (HERE / name).open(encoding="utf-8", newline="") as handle:
        reader = csv.DictReader(handle)
        if columns:
            assert reader.fieldnames == columns, reader.fieldnames
        rows = list(reader)
    assert rows and all(None not in row for row in rows), name
    return rows


def verify(cache):
    sources = Sources(cache)
    for name in ARCHIVES:
        sources.archive_bytes(name)
    # Verify the download/source chain against immutable installed locks and crate lock.
    npm = json.loads((ROOT / "apps/launcher/package-lock.json").read_text(encoding="utf-8"))["packages"]
    assert npm["node_modules/@tauri-apps/cli"]["version"] == "2.12.4"
    assert base64.b64encode(hashlib.sha512(sources.archive_bytes("dialog-js.tgz")).digest()).decode() == npm["node_modules/@tauri-apps/plugin-dialog"]["integrity"].removeprefix("sha512-")
    locked = tomllib.loads((ROOT / "apps/launcher/src-tauri/Cargo.lock").read_text(encoding="utf-8"))["package"]
    for name, filename in [("rfd", "rfd.crate"), ("tauri-plugin-dialog", "dialog.crate")]:
        entry = next(p for p in locked if p["name"] == name)
        assert entry["version"] == ARCHIVES[filename][0]
        assert entry["checksum"] == ARCHIVES[filename][2]
    cli_lock = tomllib.loads(sources.text("tauri-cli.crate", "tauri-cli-2.12.4/Cargo.lock"))["package"]
    bundler = next(p for p in cli_lock if p["name"] == "tauri-bundler")
    assert bundler["version"] == "2.10.4" and bundler["checksum"] == ARCHIVES["tauri-bundler.crate"][2]
    for archive, member in [
        ("tauri-cli.crate", "tauri-cli-2.12.4/.cargo_vcs_info.json"),
        ("tauri-bundler.crate", "tauri-bundler-2.10.4/.cargo_vcs_info.json"),
    ]:
        assert json.loads(sources.text(archive, member))["git"]["sha1"] == "993038c49185307dfc895ab7657d77ca0d5ed7c7"
    bundler_source = sources.text("tauri-bundler.crate", TAURI + "mod.rs")
    assert ARCHIVES["nsis.zip"][1] in bundler_source
    assert "DB14F8AF2EA346B786C6AE19343F61AAF5E09B8E" in bundler_source
    assert hashlib.sha1(sources.archive_bytes("nsis.zip")).hexdigest().upper() == "DB14F8AF2EA346B786C6AE19343F61AAF5E09B8E"
    for basename in ("English.nlf", "English.nsh"):
        binary = sources.member("nsis.zip", NSIS + "Contrib/Language files/" + basename)
        upstream = sources.member("nsis-upstream.zip", UPSTREAM + "Language files/" + basename)
        assert binary.replace(b"\r\n", b"\n") == upstream.replace(b"\r\n", b"\n"), basename
    langdll = sources.member("nsis.zip", NSIS + "Plugins/x86-unicode/LangDLL.dll")
    assert all((text + "\0").encode("utf-16-le") in langdll for text in ("OK", "Cancel"))

    rows = read_csv("installer-dependencies.csv", COLUMNS)
    scope = read_csv("installer-dependencies-scope.csv")
    assert len({r["item_id"] for r in rows}) == len(rows)
    assert len({r["message_id"] for r in rows}) == len(rows)
    expected = expected_sites(sources)
    actual = {r["message_id"]: r for r in rows if r["message_id"] in expected}
    assert actual.keys() == expected.keys(), sorted(expected.keys() - actual.keys())
    boundary_ids = {
        "installer.dependencies.unresolved.choowHowToInstall",
        "installer.dependencies.unresolved.confirmation.buttons",
        "installer.dependencies.unresolved.folder.controls",
        "installer.dependencies.unresolved.native.errors",
        "installer.dependencies.unresolved.nsis.messagebox.buttons",
        "installer.dependencies.boundary.nsisdl.server-error",
    }
    assert {r["message_id"] for r in rows} == expected.keys() | boundary_ids
    for key, site in expected.items():
        assert actual[key]["english"] == site["english"], key
        assert actual[key]["english_location"] == site["english_location"], key
    original = {r["item_id"] for r in read_csv("launcher.csv") if not r["english"]}
    assert len(original) == 36
    dispositions = [r for r in scope if r["record_type"] == "original-boundary"]
    assert {r["source"] for r in dispositions} == original
    covered = set()
    scoped_sources = {r["source"] for r in scope if r["record_type"] in ("repo-source", "archive-member")}

    def check_anchor(value):
        name, number = value.rsplit(":", 1)
        assert name in scoped_sources, name
        if name.startswith("archive:"):
            archive, member = name.removeprefix("archive:").split("!/", 1)
            lines = sources.lines(archive, member)
        else:
            lines = (ROOT / name).read_text(encoding="utf-8").splitlines()
        assert 1 <= int(number) <= len(lines), value
        return lines[int(number) - 1]

    for row in rows:
        covered.update(re.findall(r"launcher-\d{4}", row["evidence"]))
        for field in ("item_id", "message_id", "english_location", "display_location", "trigger", "consumer_evidence", "translation_boundary", "evidence"):
            assert row[field].strip(), (row["item_id"], field)
        assert REVISION in row["evidence"]
        check_anchor(row["english_location"])
        for reference in row["consumer_evidence"].split(";"):
            check_anchor(reference.strip())
        if row["message_id"] in boundary_ids:
            assert row["english"] == "", row["message_id"]
            assert any(value in row["translation_boundary"] for value in ("UNRESOLVED", "Dynamic", "Source-proven empty"))
    assert covered >= original, sorted(original - covered)
    for entry in scope:
        if entry["record_type"] == "repo-source":
            assert hashlib.sha256((ROOT / entry["source"]).read_bytes()).hexdigest() == entry["sha256"], entry["source"]
        elif entry["record_type"] == "archive-member":
            archive, member = entry["source"].removeprefix("archive:").split("!/", 1)
            assert hashlib.sha256(sources.member(archive, member)).hexdigest() == entry["sha256"], entry["source"]
        elif entry["record_type"] == "archive":
            assert entry["sha256"] == ARCHIVES[entry["source"]][2], entry["source"]
    template = (ROOT / "packaging/launcher/installer.nsi").read_text(encoding="utf-8")
    english = sources.text("tauri-bundler.crate", TAURI + "languages/English.nsh")
    assert "$(choowHowToInstall)" in template
    assert "LangString choowHowToInstall" not in template and "LangString choowHowToInstall" not in english
    assert "LangString chooseHowToInstall" in english
    assert 'LangString choowHowToInstall 0 ""' in sources.text("tauri-bundler.crate", TAURI + "installer.nsi")
    assert 'features = ["common-controls-v6"]' in sources.text("dialog.crate", "tauri-plugin-dialog-2.8.3/Cargo.toml")
    assert "MessageButtons::OkCancel => (TDCBF_OK_BUTTON | TDCBF_CANCEL_BUTTON, vec![])" in sources.text("rfd.crate", "rfd-0.16.0/src/backend/win_cid/message_dialog.rs")
    assert "okLabel" not in (ROOT / "apps/launcher/src/App.tsx").read_text(encoding="utf-8")
    assert "okLabel" not in (ROOT / "apps/launcher/src/command-entry-section.tsx").read_text(encoding="utf-8")
    # Validate the static missing-name -> warning -> zero slot -> empty string
    # proof, with compiler policy and native delivery kept distinct.
    language = sources.text("nsis-upstream.zip", "nsis-313/Source/lang.cpp")
    build = sources.text("nsis-upstream.zip", "nsis-313/Source/build.cpp")
    build_header = sources.text("nsis-upstream.zip", "nsis-313/Source/build.h")
    assert "DW_LANGSTRING_NOTSETINLANG = 6040" in build_header
    assert "return wenabled;" in build_header
    assert "string_ptrs[i].set_zeroing(1);" in language
    assert "if (!str || !*str)" in language
    assert "if (lsn[0] != _T('^'))" in language
    assert "*ptr = add_string(str" in language
    assert "cur_langtables->add(string_ptrs[i].get()" in language
    grow = sources.text("nsis-upstream.zip", "nsis-313/Source/growbuf.cpp")
    assert "memset((BYTE*)m_s + orgused, 0, m_used - orgused)" in grow
    strings = sources.text("nsis-upstream.zip", "nsis-313/Source/strlist.cpp")
    assert 'outstr.assign(_T(""));' in strings
    assert "if (!*find) return 0;" in strings
    runtime = sources.text("nsis-upstream.zip", "nsis-313/Source/exehead/util.c")
    assert "GetNSISStringNP(GetNSISTab(strtab))" in runtime
    assert "while (*in &&" in runtime and "*out = 0;" in runtime
    pages = sources.text("nsis.zip", NSIS + "Contrib/Modern UI 2/Pages.nsh")
    assert 'SendMessage $mui.Header.SubText ${WM_SETTEXT} 0 "STR:${SUBTEXT}"' in pages
    invocation = "\n".join(sources.lines("tauri-bundler.crate", TAURI + "mod.rs")[709:722])
    assert "-INPUTCHARSET" in invocation and "-WX" not in invocation
    assert 'log::Level::Error => "-V1"' in invocation
    assert 'log::Level::Info => "-V3"' in invocation
    assert '_ => "-V4"' in invocation
    cli_bundle = sources.text("tauri-cli.crate", "tauri-cli-2.12.4/src/bundle.rs")
    assert "0 => log::Level::Error" in cli_bundle
    assert "1 => log::Level::Info" in cli_bundle
    assert "_ => log::Level::Trace" in cli_bundle
    command = sources.lines("tauri-bundler.crate", "tauri-bundler-2.10.4/src/utils/mod.rs")
    forwarding = "\n".join(command[37:46])
    assert "self.stdout(os_pipe::dup_stdout()?)" in forwarding
    assert "self.stderr(os_pipe::dup_stderr()?)" in forwarding
    assert "self.status()" in forwarding
    assert "display_warnings = lvl > 1;" in build
    assert "set_verbosity(3);" in build
    assert "if (!x || !display_warnings) return;" in build
    util_header = sources.text("nsis-upstream.zip", "nsis-313/Source/exehead/util.h")
    assert "strtab < 0 ? LANG_STR_TAB(strtab) : strtab" in util_header
    language_runtime = sources.text("nsis-upstream.zip", "nsis-313/Source/exehead/lang.h")
    assert "cur_langtable[-((int)x+1)]" in language_runtime
    for entry in scope:
        if entry["record_type"] == "repo-source" and not entry["source"].startswith("review/"):
            assert entry["version"] == "snapshot " + REVISION, entry["source"]
    for filename in ("English.nsh", "Japanese.nsh", "SimpChinese.nsh", "TradChinese.nsh"):
        assert "LangString choowHowToInstall" not in sources.text("tauri-bundler.crate", TAURI + "languages/" + filename)
    print(json.dumps({"rows": len(rows), "individual_dependency_definitions": len(expected),
                      "nonempty_dependency_definitions": sum(bool(x["english"]) for x in expected.values()),
                      "original_boundaries_accounted_for": len(original),
                      "archive_hashes": "passed", "lock_chain": "passed",
                      "exact_definition_coverage_and_source_hashes": "passed",
                      "unresolved": [r["source"] + ": " + r["status"] for r in dispositions if r["status"].startswith("unresolved")],
                      "missing_alias_compiler_trace": "warning 6040; zero/empty substitution if compilation continues; diagnostic-as-error path separately recorded",
                      "runtime_or_installer_execution": "not performed"}, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--cache-dir", type=Path, default=ROOT / "test-results/installer-dependency-sources",
                        help="Directory of the seven inert archives named in scope; verifier never downloads or executes them.")
    verify(parser.parse_args().cache_dir)
