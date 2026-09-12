#!/usr/bin/env python3
"""Hermetic POSIX tests for the public development helper; no npm installs or network."""

from __future__ import annotations

import errno
import os
import pty
import select
import shutil
import subprocess
import tempfile
import textwrap
import time
import unittest
from pathlib import Path

SOURCE_SCRIPT = Path(__file__).resolve().parents[1] / "dev-build.sh"
REAL_GIT = shutil.which("git")
REAL_NODE = shutil.which("node")


class DevBuildTests(unittest.TestCase):
    def setUp(self) -> None:
        if REAL_GIT is None:
            self.skipTest("git is not available")
        if REAL_NODE is None:
            self.skipTest("node is not available")
        self.temporary = tempfile.TemporaryDirectory(prefix="dev-build-test-")
        self.root = Path(self.temporary.name)
        self.private = self.root / "runner"
        self.private.mkdir()
        self.script = self.private / "dev-build.sh"
        shutil.copy2(SOURCE_SCRIPT, self.script)
        self.script.chmod(0o755)

        self.bin = self.root / "bin"
        self.bin.mkdir()
        self.log = self.root / "commands.log"
        self.clone_source = self.root / "clone-source"
        self._create_jouzu_repo(self.clone_source)
        self._write_fake_commands()
        self.env = {
            **os.environ,
            "PATH": f"{self.bin}{os.pathsep}{os.environ['PATH']}",
            "DEV_BUILD_TEST_LOG": str(self.log),
            "DEV_BUILD_TEST_REAL_GIT": REAL_GIT,
            "DEV_BUILD_TEST_REAL_NODE": REAL_NODE,
            "DEV_BUILD_TEST_CLONE_SOURCE": str(self.clone_source),
        }
        self.env["JOUZU_REPO"] = str(self.root / "jouzu")

    def tearDown(self) -> None:
        self.temporary.cleanup()

    def _git(
        self, cwd: Path, *args: str, env: dict[str, str] | None = None
    ) -> subprocess.CompletedProcess[str]:
        assert REAL_GIT is not None
        return subprocess.run(
            [REAL_GIT, *args],
            cwd=cwd,
            check=True,
            capture_output=True,
            text=True,
            env=env,
        )

    def _create_jouzu_repo(self, path: Path, *, with_typescript: bool = False) -> None:
        (path / "packages" / "cli").mkdir(parents=True)
        (path / "scripts").mkdir()
        (path / "package-lock.json").write_text("{}\n", encoding="utf-8")
        (path / "packages" / "cli" / "package.json").write_text(
            '{"dependencies":{"fixture-dependency":"1.0.0","fixture-bundle":"1.0.0"},'
            '"bundleDependencies":["fixture-bundle"]}\n', encoding="utf-8"
        )
        (path / "packages" / "cli" / "package-lock.json").write_text(
            "{}\n", encoding="utf-8"
        )
        (path / "scripts" / "check-dist-fresh.mjs").write_text("// test fixture\n", encoding="utf-8")
        shutil.copy2(SOURCE_SCRIPT.parent / "scripts" / "dev-smoke.mjs", path / "scripts" / "dev-smoke.mjs")
        (path / "scripts" / "apply-pi-content-policy.mjs").write_text(
            'import { appendFileSync } from "node:fs";\n'
            'appendFileSync(process.env.DEV_BUILD_TEST_LOG, "policy-setup\\n");\n'
            'if (process.env.DEV_BUILD_TEST_POLICY_FAILS) process.exit(1);\n',
            encoding="utf-8",
        )
        if with_typescript:
            tsc = path / "node_modules" / ".bin" / "tsc"
            tsc.parent.mkdir(parents=True)
            tsc.write_text("#!/usr/bin/env bash\nexit 0\n", encoding="utf-8")
            tsc.chmod(0o755)
        self._git(path, "init", "-q")
        self._git(path, "config", "user.email", "tester@example.com")
        self._git(path, "config", "user.name", "tester")
        self._git(
            path,
            "add",
            "package-lock.json",
            "packages/cli/package.json",
            "packages/cli/package-lock.json",
            "scripts/check-dist-fresh.mjs",
        )
        self._git(path, "commit", "-q", "-m", "test: create Jouzu fixture")

    def _write_fake_commands(self) -> None:
        node = self.bin / "node"
        node.write_text(
            textwrap.dedent(
                """\
                #!/usr/bin/env bash
                set -eu
                if [[ "${1:-}" == -p && "${2:-}" == 'require("node:path").dirname(process.execPath)' ]]; then
                \tcd -- "$(dirname -- "$0")"
                \tpwd -P
                \texit 0
                fi
                if [[ -n "${DEV_BUILD_TEST_OLD_NODE:-}" && "${2:-}" == *process.versions.node* ]]; then exit 1; fi
                exec "$DEV_BUILD_TEST_REAL_NODE" "$@"
                """
            ),
            encoding="utf-8",
        )
        node.chmod(0o755)

        npm = self.bin / "npm"
        npm.write_text(
            textwrap.dedent(
                """\
                #!/usr/bin/env bash
                set -eu
                {
                \tprintf 'npm'
                \tprintf '\\t%s' "$@"
                \tprintf '\\n'
                } >>"$DEV_BUILD_TEST_LOG"
                prefix=""
                is_ci=false
                is_build_dev=false
                is_link=false
                is_check=false
                while (($#)); do
                \tcase "$1" in
                \t\t--prefix)
                \t\t\tprefix="$2"
                \t\t\tshift 2
                \t\t\t;;
                \t\tcheck)
                \t\t\tis_check=true
                \t\t\tshift
                \t\t\t;;
                \t\tci)
                \t\t\tis_ci=true
                \t\t\tshift
                \t\t\t;;
                \t\tbuild:dev)
                \t\t\tis_build_dev=true
                \t\t\tshift
                \t\t\t;;
                \t\tlink)
                \t\t\tis_link=true
                \t\t\tshift
                \t\t\t;;
                \t\t*) shift ;;
                \tesac
                done
                if [[ -z "$prefix" ]]; then
                \tprefix="$PWD"
                fi
                if [[ "$is_check" == true && -n "${DEV_BUILD_TEST_CHECK_FAILS:-}" ]]; then exit 1; fi
                if [[ "$is_ci" == true ]]; then
                \tif [[ -n "${DEV_BUILD_TEST_CI_FAILS:-}" ]]; then
                \t\texit 1
                \tfi
                \tif [[ -n "${DEV_BUILD_TEST_CI_MUTATES_LOCK:-}" ]]; then
                \t\tprintf '{"mutated": true}\\n' >>"$prefix/package-lock.json"
                \tfi
                \tmkdir -p "$prefix/node_modules/.bin"
                \tprintf '#!/usr/bin/env bash\\nexit 0\\n' >"$prefix/node_modules/.bin/tsc"
                \tchmod 0755 "$prefix/node_modules/.bin/tsc"
                \tmkdir -p "$prefix/node_modules/fixture-dependency"
                \tprintf '%s\\n' '{"name":"fixture-dependency","version":"1.0.0"}' >"$prefix/node_modules/fixture-dependency/package.json"
                \tif [[ -n "${DEV_BUILD_TEST_CI_INCOMPLETE:-}" ]]; then
                \t\tprintf '%s\\n' '{}' >"$prefix/node_modules/fixture-dependency/package.json"
                \tfi
                fi
                if [[ "$is_build_dev" == true ]]; then
                \tmkdir -p "$prefix/packages/cli/dist"
                \tprintf '%s\\n' \\
                \t\t'#!/usr/bin/env node' \\
                \t\t'const valid = !process.env.DEV_BUILD_TEST_RPC_INVALID;' \\
                \t\t'console.log(JSON.stringify(valid ? { id: "dev-build", type: "response", command: "get_state", success: true, data: { isStreaming: false } } : {}));' \\
                \t\t>"$prefix/packages/cli/dist/cli.js"
                \tchmod 0755 "$prefix/packages/cli/dist/cli.js"
                fi
                if [[ "$is_link" == true ]]; then
                \tln -sfn "$prefix/packages/cli/dist/cli.js" "$(dirname "$DEV_BUILD_TEST_LOG")/bin/jz"
                \tln -sfn "$prefix/packages/cli/dist/cli.js" "$(dirname "$DEV_BUILD_TEST_LOG")/bin/jouzu"
                fi
                """
            ),
            encoding="utf-8",
        )
        npm.chmod(0o755)

        git = self.bin / "git"
        git.write_text(
            textwrap.dedent(
                """\
                #!/usr/bin/env bash
                set -eu
                if [[ "${1:-}" == clone ]]; then
                \tprintf 'git' >>"$DEV_BUILD_TEST_LOG"
                \tprintf '\\t%s' "$@" >>"$DEV_BUILD_TEST_LOG"
                \tprintf '\\n' >>"$DEV_BUILD_TEST_LOG"
                \tdestination="${@: -1}"
                \tcp -a "$DEV_BUILD_TEST_CLONE_SOURCE" "$destination"
                \texit 0
                fi
                exec "$DEV_BUILD_TEST_REAL_GIT" "$@"
                """
            ),
            encoding="utf-8",
        )
        git.chmod(0o755)

    def _run(
        self, *args: str, env: dict[str, str] | None = None
    ) -> subprocess.CompletedProcess[str]:
        return subprocess.run(
            [str(self.script), *(args or ("link",))],
            cwd=self.private,
            env=env or self.env,
            stdin=subprocess.DEVNULL,
            capture_output=True,
            text=True,
            timeout=15,
        )

    def _run_interactive(self, input_text: str, *args: str) -> tuple[int, str]:
        master, slave = pty.openpty()
        process = subprocess.Popen(
            [str(self.script), *args],
            cwd=self.private,
            env=self.env,
            stdin=slave,
            stdout=slave,
            stderr=slave,
            close_fds=True,
        )
        os.close(slave)
        os.write(master, input_text.encode())
        output = bytearray()
        deadline = time.monotonic() + 15
        try:
            while True:
                if time.monotonic() >= deadline:
                    process.kill()
                    self.fail("interactive dev-build.sh test timed out")
                readable, _, _ = select.select([master], [], [], 0.1)
                if readable:
                    try:
                        chunk = os.read(master, 4096)
                    except OSError as error:
                        if error.errno == errno.EIO:
                            break
                        raise
                    if not chunk:
                        break
                    output.extend(chunk)
                elif process.poll() is not None:
                    continue
        finally:
            os.close(master)
        return process.wait(timeout=5), output.decode(errors="replace")

    def test_incomplete_install_does_not_record_receipt(self) -> None:
        sibling = self.root / "jouzu"
        self._create_jouzu_repo(sibling)
        result = self._run(env={**self.env, "DEV_BUILD_TEST_CI_INCOMPLETE": "1"})
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("dependency bootstrap left required packages unavailable", result.stderr)
        self.assertFalse((sibling / "node_modules/.dev-build-receipt").exists())
        self.assertNotIn("\trun\tcheck\t", self.log.read_text())

    def test_matching_receipt_repairs_empty_dependency_directory(self) -> None:
        sibling = self.root / "jouzu"
        self._create_jouzu_repo(sibling)
        first = self._run()
        self.assertEqual(first.returncode, 0, first.stdout + first.stderr)
        package = sibling / "node_modules/fixture-dependency/package.json"
        package.unlink()
        second = self._run()
        self.assertEqual(second.returncode, 0, second.stdout + second.stderr)
        self.assertIn("missing installed dependency fixture-dependency", second.stderr)
        self.assertTrue(package.is_file())
        self.assertEqual(self.log.read_text().count("\tci\t"), 2)

    def test_fresh_sibling_checkout_installs_dependencies_once(self) -> None:
        sibling = self.root / "jouzu"
        self._create_jouzu_repo(sibling)

        first = self._run()
        self.assertEqual(first.returncode, 0, first.stderr)
        commands = self.log.read_text(encoding="utf-8")
        self.assertIn(f"npm\t--prefix\t{sibling}\tci\t--ignore-scripts\n", commands)
        self.assertIn("npm\tlink\t--workspace\tpackages/cli\t--ignore-scripts\n", commands)
        self.assertIn("dev-build: installing locked Jouzu dependencies", first.stdout)
        self.assertTrue((sibling / "node_modules" / ".bin" / "tsc").is_file())
        self.assertTrue((sibling / "node_modules" / ".dev-build-receipt").is_file())
        expected = (sibling / "packages" / "cli" / "dist" / "cli.js").resolve()
        self.assertEqual((self.bin / "jz").resolve(), expected)
        self.assertEqual((self.bin / "jouzu").resolve(), expected)
        self.assertIn("dev-build: Jouzu RPC smoke passed", first.stdout)

        self.log.write_text("", encoding="utf-8")
        second = self._run()
        self.assertEqual(second.returncode, 0, second.stderr)
        second_commands = self.log.read_text(encoding="utf-8")
        self.assertNotIn("\tci\t", second_commands)
        self.assertNotIn("\tlink\t", second_commands)

    def test_policy_setup_precedes_typecheck_and_failure_stops_build(self) -> None:
        sibling = self.root / "jouzu"
        self._create_jouzu_repo(sibling)
        result = self._run()
        self.assertEqual(result.returncode, 0, result.stderr)
        commands = self.log.read_text(encoding="utf-8")
        self.assertLess(commands.index("policy-setup"), commands.index("\tcheck\t"))
        self.log.write_text("", encoding="utf-8")
        self.env["DEV_BUILD_TEST_POLICY_FAILS"] = "1"
        failed = self._run()
        self.assertNotEqual(failed.returncode, 0)
        commands = self.log.read_text(encoding="utf-8")
        self.assertNotIn("\tcheck\t", commands)
        self.assertNotIn("\tbuild:dev", commands)
        self.assertIn("Pi content policy setup failed", failed.stderr)

    def test_existing_typescript_tree_reinstalls_after_lock_update(self) -> None:
        sibling = self.root / "jouzu"
        self._create_jouzu_repo(sibling, with_typescript=True)

        first = self._run()
        self.assertEqual(first.returncode, 0, first.stderr)
        receipt = sibling / "node_modules" / ".dev-build-receipt"
        self.assertTrue(receipt.is_file())

        self.log.write_text("", encoding="utf-8")
        (sibling / "package-lock.json").write_text(
            '{"updated": true}\n', encoding="utf-8"
        )

        second = self._run()
        self.assertEqual(second.returncode, 0, second.stderr)
        self.assertIn(
            f"npm\t--prefix\t{sibling}\tci\t--ignore-scripts\n",
            self.log.read_text(encoding="utf-8"),
        )
        self.assertTrue(receipt.is_file())

        self.log.write_text("", encoding="utf-8")
        third = self._run()
        self.assertEqual(third.returncode, 0, third.stderr)
        self.assertNotIn("\tci\t", self.log.read_text(encoding="utf-8"))

    def test_failed_install_writes_no_receipt(self) -> None:
        sibling = self.root / "jouzu"
        self._create_jouzu_repo(sibling)
        env = {**self.env, "DEV_BUILD_TEST_CI_FAILS": "1"}

        failed = self._run(env=env)
        self.assertEqual(failed.returncode, 1)
        self.assertIn("dev-build: Jouzu dependency bootstrap failed", failed.stderr)
        self.assertFalse((sibling / "node_modules" / ".dev-build-receipt").exists())

        retry = self._run()
        self.assertEqual(retry.returncode, 0, retry.stderr)
        self.assertIn(
            f"npm\t--prefix\t{sibling}\tci\t--ignore-scripts\n",
            self.log.read_text(encoding="utf-8"),
        )
        self.assertTrue((sibling / "node_modules" / ".dev-build-receipt").is_file())

    def test_cli_lock_update_reinstalls(self) -> None:
        sibling = self.root / "jouzu"
        self._create_jouzu_repo(sibling, with_typescript=True)

        first = self._run()
        self.assertEqual(first.returncode, 0, first.stderr)

        self.log.write_text("", encoding="utf-8")
        (sibling / "packages" / "cli" / "package-lock.json").write_text(
            '{"updated": true}\n', encoding="utf-8"
        )

        second = self._run()
        self.assertEqual(second.returncode, 0, second.stderr)
        self.assertIn(
            f"npm\t--prefix\t{sibling}\tci\t--ignore-scripts\n",
            self.log.read_text(encoding="utf-8"),
        )

        self.log.write_text("", encoding="utf-8")
        third = self._run()
        self.assertEqual(third.returncode, 0, third.stderr)
        self.assertNotIn("\tci\t", self.log.read_text(encoding="utf-8"))

    def test_failed_install_then_reverted_inputs_still_require_install(self) -> None:
        sibling = self.root / "jouzu"
        self._create_jouzu_repo(sibling, with_typescript=True)
        lock = sibling / "package-lock.json"
        original_lock = lock.read_text(encoding="utf-8")

        first = self._run()
        self.assertEqual(first.returncode, 0, first.stderr)

        self.log.write_text("", encoding="utf-8")
        lock.write_text('{"updated": true}\n', encoding="utf-8")

        failed_env = {**self.env, "DEV_BUILD_TEST_CI_FAILS": "1"}
        failed = self._run(env=failed_env)
        self.assertEqual(failed.returncode, 1)
        self.assertIn("dev-build: Jouzu dependency bootstrap failed", failed.stderr)
        self.assertFalse((sibling / "node_modules" / ".dev-build-receipt").exists())

        self.log.write_text("", encoding="utf-8")
        lock.write_text(original_lock, encoding="utf-8")

        second = self._run()
        self.assertEqual(second.returncode, 0, second.stderr)
        self.assertIn(
            f"npm\t--prefix\t{sibling}\tci\t--ignore-scripts\n",
            self.log.read_text(encoding="utf-8"),
        )
        self.assertTrue((sibling / "node_modules" / ".dev-build-receipt").is_file())

    def test_mid_install_input_change_fails_build_without_receipt(self) -> None:
        sibling = self.root / "jouzu"
        self._create_jouzu_repo(sibling)
        env = {**self.env, "DEV_BUILD_TEST_CI_MUTATES_LOCK": "1"}

        result = self._run(env=env)
        self.assertEqual(result.returncode, 1)
        self.assertIn(
            "dev-build: Jouzu dependency inputs changed during install", result.stderr
        )
        self.assertIn(
            "dev-build: existing CLI dist files were not rebuilt", result.stderr
        )
        self.assertFalse((sibling / "node_modules" / ".dev-build-receipt").exists())

        second = self._run()
        self.assertEqual(second.returncode, 0, second.stderr)
        self.assertIn(
            f"npm\t--prefix\t{sibling}\tci\t--ignore-scripts\n",
            self.log.read_text(encoding="utf-8"),
        )
        self.assertTrue((sibling / "node_modules" / ".dev-build-receipt").is_file())

    def test_explicit_checkout_override_wins_over_sibling(self) -> None:
        sibling = self.root / "jouzu"
        alternate = self.root / "alternate Jouzu"
        self._create_jouzu_repo(sibling, with_typescript=True)
        self._create_jouzu_repo(alternate, with_typescript=True)
        env = {**self.env, "JOUZU_REPO": str(alternate)}

        result = self._run(env=env)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn(f"({alternate})", result.stdout)
        self.assertNotIn(f"\t{sibling}\t", self.log.read_text(encoding="utf-8"))

    def test_noninteractive_missing_checkout_prints_recovery(self) -> None:
        result = self._run()
        self.assertEqual(result.returncode, 1)
        self.assertIn("checkout does not exist", result.stderr)

    def test_hook_run_never_prompts_for_a_missing_checkout(self) -> None:
        returncode, output = self._run_interactive("", "__hook", "post-commit")
        self.assertEqual(returncode, 0, output)
        self.assertIn("post-commit hook could not locate the Jouzu checkout", output)
        self.assertNotIn("Path to an existing Jouzu checkout", output)

    def test_rebase_hooks_build_only_the_final_commit(self) -> None:
        sibling = self.root / "jouzu"
        self._create_jouzu_repo(sibling, with_typescript=True)
        base = self._git(sibling, "rev-parse", "HEAD").stdout.strip()

        self._git(sibling, "switch", "-q", "-c", "local")
        for number in (1, 2):
            path = sibling / f"local-{number}.txt"
            path.write_text(f"local {number}\n", encoding="utf-8")
            self._git(sibling, "add", path.name)
            self._git(sibling, "commit", "-q", "-m", f"local {number}")

        self._git(sibling, "switch", "-q", "-c", "upstream", base)
        (sibling / "upstream.txt").write_text("upstream\n", encoding="utf-8")
        self._git(sibling, "add", "upstream.txt")
        self._git(sibling, "commit", "-q", "-m", "upstream")
        self._git(sibling, "switch", "-q", "local")

        installed = self._run("install-hooks")
        self.assertEqual(installed.returncode, 0, installed.stderr)
        self.log.write_text("", encoding="utf-8")

        self._git(sibling, "rebase", "upstream", env=self.env)
        commands = self.log.read_text(encoding="utf-8").splitlines()
        builds = [line for line in commands if line.endswith("\trun\tbuild:dev")]
        self.assertEqual(len(builds), 1, "\n".join(commands))

    def test_fast_forward_rebase_still_builds_once(self) -> None:
        sibling = self.root / "jouzu"
        self._create_jouzu_repo(sibling, with_typescript=True)
        upstream_branch = self._git(
            sibling, "branch", "--show-current"
        ).stdout.strip()
        self._git(sibling, "branch", "behind")
        (sibling / "upstream.txt").write_text("upstream\n", encoding="utf-8")
        self._git(sibling, "add", "upstream.txt")
        self._git(sibling, "commit", "-q", "-m", "upstream")
        self._git(sibling, "switch", "-q", "behind")

        installed = self._run("install-hooks")
        self.assertEqual(installed.returncode, 0, installed.stderr)
        self.log.write_text("", encoding="utf-8")

        self._git(sibling, "rebase", upstream_branch, env=self.env)
        commands = self.log.read_text(encoding="utf-8").splitlines()
        builds = [line for line in commands if line.endswith("\trun\tbuild:dev")]
        self.assertEqual(len(builds), 1, "\n".join(commands))

    def test_invalid_linked_runtime_response_fails_the_build(self) -> None:
        sibling = self.root / "jouzu"
        self._create_jouzu_repo(sibling, with_typescript=True)
        env = {**self.env, "DEV_BUILD_TEST_RPC_INVALID": "1"}

        result = self._run(env=env)
        self.assertEqual(result.returncode, 1)
        self.assertIn("Jouzu RPC smoke returned invalid output", result.stderr)
        self.assertIn("development build exists, but the runtime smoke failed", result.stderr)

    def test_shadowed_commands_fail_after_linking(self) -> None:
        sibling = self.root / "jouzu"
        self._create_jouzu_repo(sibling, with_typescript=True)
        shadow = self.root / "shadow"
        shadow.mkdir()
        for name in ("jz", "jouzu"):
            command = shadow / name
            command.write_text("#!/usr/bin/env bash\nexit 0\n", encoding="utf-8")
            command.chmod(0o755)
        env = {**self.env, "PATH": f"{shadow}{os.pathsep}{self.env['PATH']}"}

        result = self._run(env=env)
        self.assertEqual(result.returncode, 1)
        self.assertIn("remove or reorder the competing jz/jouzu command on PATH", result.stderr)
        self.assertIn("npm\tlink\t--workspace\tpackages/cli\t--ignore-scripts\n", self.log.read_text())

    def test_default_build_discovers_own_checkout_without_linking(self) -> None:
        checkout = self.root / "jouzu"
        self._create_jouzu_repo(checkout)
        script = checkout / "dev-build.sh"
        shutil.copy2(SOURCE_SCRIPT, script)
        script.chmod(0o755)
        env = dict(self.env)
        env.pop("JOUZU_REPO")
        result = subprocess.run([str(script)], cwd=self.root, env=env, capture_output=True, text=True, timeout=15)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertNotIn("\tlink\t", self.log.read_text())
        self.assertFalse((self.bin / "jz").exists())
        self.assertIn("RPC smoke passed", result.stdout)

    def test_unmanaged_hook_and_symlink_are_preserved(self) -> None:
        checkout = self.root / "jouzu"
        self._create_jouzu_repo(checkout)
        hook = checkout / ".git" / "hooks" / "post-commit"
        hook.write_text("#!/bin/sh\n# user hook\n")
        result = self._run("install-hooks")
        self.assertNotEqual(result.returncode, 0)
        self.assertEqual(hook.read_text(), "#!/bin/sh\n# user hook\n")
        hook.unlink()
        target = self.root / "hook-target"
        target.write_text("# Managed by Jouzu dev-build.sh; rerun install-hooks to update.\n")
        hook.symlink_to(target)
        result = self._run("install-hooks")
        self.assertNotEqual(result.returncode, 0)
        self.assertTrue(hook.is_symlink())
        self.assertEqual(target.read_text(), "# Managed by Jouzu dev-build.sh; rerun install-hooks to update.\n")

    def test_hook_builds_do_not_link_global_commands(self) -> None:
        checkout = self.root / "jouzu"
        self._create_jouzu_repo(checkout)
        result = self._run("__hook", "post-commit", str(checkout))
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertNotIn("\tlink\t", self.log.read_text())

    def test_typecheck_failure_does_not_replace_cli_dist(self) -> None:
        checkout = self.root / "jouzu"
        self._create_jouzu_repo(checkout)
        self.assertEqual(self._run("build").returncode, 0)
        entry = checkout / "packages" / "cli" / "dist" / "cli.js"
        before = entry.read_bytes()
        self.log.write_text("")
        result = self._run("build", env={**self.env, "DEV_BUILD_TEST_CHECK_FAILS": "1"})
        self.assertNotEqual(result.returncode, 0)
        self.assertEqual(entry.read_bytes(), before)
        self.assertNotIn("\trun\tbuild:dev", self.log.read_text())

    def test_node_requirement_fails_before_install(self) -> None:
        result = self._run("build", env={**self.env, "DEV_BUILD_TEST_OLD_NODE": "1"})
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("Node.js >=22.19.0", result.stderr)
        self.assertFalse(self.log.exists())

    def test_hook_install_and_uninstall_are_explicit_and_preserve_configuration(self) -> None:
        checkout = self.root / "jouzu"
        self._create_jouzu_repo(checkout)
        self._git(checkout, "config", "core.hooksPath", ".custom-hooks")
        self.assertEqual(self._run("install-hooks").returncode, 0)
        hooks = checkout / ".custom-hooks"
        self.assertTrue((hooks / "post-commit").is_file())
        self.assertNotIn("runner", (hooks / "post-commit").read_text().split("target=")[1].splitlines()[0])
        self.assertEqual(self._run("uninstall-hooks").returncode, 0)
        self.assertFalse((hooks / "post-commit").exists())
        self.assertEqual(self._git(checkout, "config", "--get", "core.hooksPath").stdout.strip(), ".custom-hooks")

    def test_unknown_command_and_extra_arguments_are_rejected(self) -> None:
        self.assertEqual(self._run("unknown").returncode, 2)
        self.assertEqual(self._run("build", "unexpected").returncode, 2)

    def _lock_path(self, checkout: Path) -> Path:
        common = self._git(checkout, "rev-parse", "--git-common-dir").stdout.strip()
        return (checkout / common / "jouzu-dev-build.lock").resolve()

    def _hold_build_lock(self, lock_path: Path, seconds: float) -> subprocess.Popen[bytes]:
        """Hold the build lock with a real flock process until it is released."""
        flock = shutil.which("flock")
        if flock is None:
            self.skipTest("flock is not available")
        ready = self.root / "lock-ready"
        process = subprocess.Popen(
            [flock, str(lock_path), "bash", "-c", 'touch "$1"; sleep "$2"', "_", str(ready), str(seconds)],
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
        )
        deadline = time.monotonic() + 10
        while not ready.exists():
            if process.poll() is not None or time.monotonic() > deadline:
                process.kill()
                self.fail("the test lock holder did not start")
            time.sleep(0.02)
        return process

    def test_build_lock_lives_in_the_git_common_directory(self) -> None:
        checkout = self.root / "jouzu"
        self._create_jouzu_repo(checkout, with_typescript=True)
        result = self._run("build")
        self.assertEqual(result.returncode, 0, result.stderr)
        # Outside node_modules, so the installs it serializes cannot delete it.
        self.assertTrue(self._lock_path(checkout).is_file())
        self.assertFalse((checkout / "node_modules" / "jouzu-dev-build.lock").exists())

    def test_contended_build_waits_for_the_lock_and_then_builds(self) -> None:
        checkout = self.root / "jouzu"
        self._create_jouzu_repo(checkout, with_typescript=True)
        holder = self._hold_build_lock(self._lock_path(checkout), 2)
        try:
            result = self._run("build", env={**self.env, "JOUZU_DEV_BUILD_LOCK_TIMEOUT_SECONDS": "60"})
        finally:
            holder.wait(timeout=10)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn("another build holds the build lock", result.stdout)
        self.assertIn("dev-build: Jouzu rebuild complete", result.stdout)

    def test_build_lock_timeout_reports_and_fails(self) -> None:
        checkout = self.root / "jouzu"
        self._create_jouzu_repo(checkout, with_typescript=True)
        holder = self._hold_build_lock(self._lock_path(checkout), 5)
        try:
            result = self._run("build", env={**self.env, "JOUZU_DEV_BUILD_LOCK_TIMEOUT_SECONDS": "1"})
        finally:
            holder.wait(timeout=10)
        self.assertEqual(result.returncode, 75)
        self.assertIn("timed out after 1s waiting for the build lock", result.stderr)
        self.assertNotIn("dev-build: Jouzu rebuild complete", result.stdout)

    def test_hook_skips_the_rebuild_when_the_lock_times_out(self) -> None:
        checkout = self.root / "jouzu"
        self._create_jouzu_repo(checkout, with_typescript=True)
        holder = self._hold_build_lock(self._lock_path(checkout), 5)
        try:
            result = self._run(
                "__hook",
                "post-commit",
                str(checkout),
                env={**self.env, "JOUZU_DEV_BUILD_LOCK_TIMEOUT_SECONDS": "1"},
            )
        finally:
            holder.wait(timeout=10)
        # A hook must never fail the Git operation it runs for.
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn("post-commit hook skipped the rebuild", result.stderr)

    def test_directory_lock_is_released_after_the_build(self) -> None:
        checkout = self.root / "jouzu"
        self._create_jouzu_repo(checkout, with_typescript=True)
        result = self._run("build", env={**self.env, "JOUZU_DEV_BUILD_LOCK_MODE": "directory"})
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertNotIn("another build holds", result.stdout)
        self.assertFalse(Path(f"{self._lock_path(checkout)}.d").exists())

    def test_stale_directory_lock_is_reclaimed(self) -> None:
        checkout = self.root / "jouzu"
        self._create_jouzu_repo(checkout, with_typescript=True)
        lock_directory = Path(f"{self._lock_path(checkout)}.d")
        lock_directory.mkdir(parents=True)
        stopped = subprocess.Popen(["true"])
        stopped.wait()
        (lock_directory / "pid").write_text(f"{stopped.pid}\n", encoding="utf-8")

        result = self._run("build", env={**self.env, "JOUZU_DEV_BUILD_LOCK_MODE": "directory"})

        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn("reclaimed the build lock left by a stopped build", result.stderr)
        self.assertFalse(lock_directory.exists())

    def test_live_directory_lock_is_not_reclaimed(self) -> None:
        checkout = self.root / "jouzu"
        self._create_jouzu_repo(checkout, with_typescript=True)
        lock_directory = Path(f"{self._lock_path(checkout)}.d")
        lock_directory.mkdir(parents=True)
        (lock_directory / "pid").write_text(f"{os.getpid()}\n", encoding="utf-8")

        result = self._run(
            "build",
            env={**self.env, "JOUZU_DEV_BUILD_LOCK_MODE": "directory", "JOUZU_DEV_BUILD_LOCK_TIMEOUT_SECONDS": "1"},
        )

        self.assertEqual(result.returncode, 75)
        self.assertIn("timed out after 1s waiting for the build lock", result.stderr)
        self.assertTrue(lock_directory.exists())

    def test_held_lock_environment_skips_acquisition(self) -> None:
        checkout = self.root / "jouzu"
        self._create_jouzu_repo(checkout, with_typescript=True)
        lock_directory = Path(f"{self._lock_path(checkout)}.d")
        lock_directory.mkdir(parents=True)
        (lock_directory / "pid").write_text(f"{os.getpid()}\n", encoding="utf-8")

        # The private wrapper holds the lock across its patch revert and re-apply, then
        # runs this script; the nested invocation must not wait on its own lock.
        result = self._run(
            "build",
            env={
                **self.env,
                "JOUZU_DEV_BUILD_LOCK_MODE": "directory",
                "JOUZU_DEV_BUILD_LOCK_HELD": "1",
                "JOUZU_DEV_BUILD_LOCK_TIMEOUT_SECONDS": "1",
            },
        )

        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertNotIn("another build holds", result.stdout)
        self.assertIn("dev-build: Jouzu rebuild complete", result.stdout)
        self.assertTrue(lock_directory.exists())

    def test_unknown_lock_mode_is_rejected(self) -> None:
        checkout = self.root / "jouzu"
        self._create_jouzu_repo(checkout, with_typescript=True)
        result = self._run("build", env={**self.env, "JOUZU_DEV_BUILD_LOCK_MODE": "nonsense"})
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("JOUZU_DEV_BUILD_LOCK_MODE must be auto, flock, or directory", result.stderr)


if __name__ == "__main__":
    unittest.main()
