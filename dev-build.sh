#!/usr/bin/env bash
set -uo pipefail

readonly SCRIPT_ROOT="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)"
readonly SCRIPT_PATH="${SCRIPT_ROOT}/$(basename -- "${BASH_SOURCE[0]}")"
readonly DEFAULT_JOUZU_REPO="$SCRIPT_ROOT"
readonly HOOK_MARKER="# Managed by Jouzu dev-build.sh; rerun install-hooks to update."
LINK_DEVELOPMENT=false
readonly HOOK_NAMES=(post-commit post-merge post-checkout post-rewrite)

usage() {
	cat <<'EOF'
Usage: ./dev-build.sh [build|link|install-hooks|uninstall-hooks]

  build            Install locked dependencies, type-check, build, and smoke-test (default).
  link             Build and replace the global jz/jouzu links with this checkout.
  install-hooks    Opt in to rebuild after commit, merge, checkout, and rebase.
  uninstall-hooks  Remove only hooks managed by this script.

Requires Bash, Git, npm, and Node.js >=22.19.0. Uses this checkout by default;
set JOUZU_REPO to select another local checkout. Never clones or publishes.
Dependency installs disable lifecycle scripts and repeat when manifests or locks change.
Builds record development identity and run a bounded offline RPC smoke test.
Only link changes global commands. Hooks build without linking and report failures
without failing Git. Existing unmanaged hooks are never replaced.
EOF
}

require_commands() {
	local command_name
	for command_name in git npm node; do
		if ! command -v "$command_name" >/dev/null 2>&1; then
			echo "dev-build: $command_name is not available on PATH" >&2
			return 1
		fi
	done
	if ! node -e 'const [major, minor] = process.versions.node.split(".").map(Number); process.exit(major > 22 || (major === 22 && minor >= 19) ? 0 : 1)'; then
		echo "dev-build: Node.js >=22.19.0 is required" >&2
		return 1
	fi
}

validate_jouzu_repo() {
	local requested="$1"
	if [[ ! -d "$requested" ]]; then
		echo "dev-build: Jouzu checkout does not exist: $requested" >&2
		return 1
	fi

	JOUZU_REPO="$(cd -- "$requested" && pwd -P)" || return 1
	if ! git -C "$JOUZU_REPO" rev-parse --show-toplevel >/dev/null 2>&1; then
		echo "dev-build: not a Git checkout: $JOUZU_REPO" >&2
		return 1
	fi
	if [[ ! -f "$JOUZU_REPO/packages/cli/package.json" ]]; then
		echo "dev-build: missing Jouzu CLI package: $JOUZU_REPO/packages/cli/package.json" >&2
		return 1
	fi
}

resolve_jouzu_repo() {
	require_commands || return 1
	validate_jouzu_repo "${JOUZU_REPO:-$DEFAULT_JOUZU_REPO}"
}

typescript_available() {
	[[ -f "$JOUZU_REPO/node_modules/.bin/tsc" || -f "$JOUZU_REPO/node_modules/.bin/tsc.cmd" ]]
}

dependency_receipt_path() {
	printf '%s\n' "$JOUZU_REPO/node_modules/.dev-build-receipt"
}

# Hash the manifests and lockfiles that determine the installed tree: the
# root manifest and lock cover the workspace tree, the CLI lock covers the
# CLI build's own install, and the CLI and Session UI manifests complete
# the workspace inputs. Presence participates in the hash alongside
# content, so a file that appears or disappears changes the fingerprint.
dependency_fingerprint() {
	local parts relative
	parts="dev-build-receipt-v1"$'\n'
	while IFS= read -r relative; do
		if [[ -f "$JOUZU_REPO/$relative" ]]; then
			parts+="$relative $(git -C "$JOUZU_REPO" hash-object -- "$relative")"$'\n' || {
				echo "dev-build: could not hash Jouzu dependency input: $relative" >&2
				return 1
			}
		else
			parts+="$relative missing"$'\n'
		fi
	done <<'DEPENDENCY_INPUTS'
package.json
package-lock.json
packages/cli/package.json
packages/cli/package-lock.json
packages/session-ui/package.json
DEPENDENCY_INPUTS
	printf '%s' "$parts" | git hash-object --stdin || {
		echo "dev-build: could not fingerprint Jouzu dependency inputs" >&2
		return 1
	}
}

dependency_receipt_matches_inputs() {
	local receipt_path current_fingerprint
	receipt_path="$(dependency_receipt_path)"
	[[ -f "$receipt_path" ]] || return 1
	current_fingerprint="$(dependency_fingerprint)" || return 1
	[[ "$current_fingerprint" == "$(<"$receipt_path")" ]]
}

direct_dependencies_available() {
	node --input-type=module - "$JOUZU_REPO" <<'NODE'
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
const root = process.argv[2];
for (const relative of ["", "packages/cli", "packages/session-ui"]) {
	const base = join(root, relative);
	const manifestPath = join(base, "package.json");
	if (!existsSync(manifestPath)) continue;
	const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
	// The CLI build installs its release bundle separately after type checking.
	const bundled = new Set(Array.isArray(manifest.bundleDependencies) ? manifest.bundleDependencies : []);
	for (const name of Object.keys({ ...manifest.dependencies, ...manifest.devDependencies })) {
		if (bundled.has(name)) continue;
		let directory = base;
		let found = false;
		while (true) {
			const installed = join(directory, "node_modules", name, "package.json");
			if (existsSync(installed)) {
				try {
					found = JSON.parse(readFileSync(installed, "utf8")).name === name;
				} catch {}
				break;
			}
			const parent = dirname(directory);
			if (parent === directory) break;
			directory = parent;
		}
		if (!found) {
			console.error(`dev-build: missing installed dependency ${name} for ${relative || "root"}`);
			process.exit(1);
		}
	}
}
NODE
}

write_dependency_receipt() {
	local receipt_path temp
	receipt_path="$(dependency_receipt_path)"
	temp="$receipt_path.tmp.$$"
	if ! printf '%s\n' "$1" >"$temp"; then
		rm -f -- "$temp"
		return 1
	fi
	mv -f -- "$temp" "$receipt_path"
}

bootstrap_dependencies() {
	local before_fingerprint after_fingerprint

	if [[ ! -f "$JOUZU_REPO/package-lock.json" ]]; then
		echo "dev-build: missing Jouzu lockfile: $JOUZU_REPO/package-lock.json" >&2
		return 1
	fi
	if typescript_available && dependency_receipt_matches_inputs && direct_dependencies_available; then
		return
	fi

	before_fingerprint="$(dependency_fingerprint)" || return 1
	# Invalidate our own receipt before installing: a failed install or a
	# mid-install input change must not leave an old receipt that matches
	# again after the inputs are reverted, while the tree state is unknown.
	if ! rm -f -- "$(dependency_receipt_path)"; then
		echo "dev-build: could not remove the stale Jouzu dependency install receipt" >&2
		return 1
	fi
	echo "dev-build: installing locked Jouzu dependencies without lifecycle scripts"
	if ! npm --prefix "$JOUZU_REPO" ci --ignore-scripts; then
		echo "dev-build: Jouzu dependency bootstrap failed" >&2
		return 1
	fi
	if ! typescript_available; then
		echo "dev-build: dependency bootstrap did not install TypeScript under $JOUZU_REPO/node_modules" >&2
		return 1
	fi

	if ! direct_dependencies_available; then
		echo "dev-build: dependency bootstrap left required packages unavailable" >&2
		return 1
	fi

	# Record the receipt only when the before- and after-install fingerprints
	# match. This compares two snapshots; transient changes that are reverted
	# during the install are not detected.
	after_fingerprint="$(dependency_fingerprint)" || {
		echo "dev-build: could not fingerprint Jouzu dependency inputs after install" >&2
		return 1
	}
	if [[ "$after_fingerprint" != "$before_fingerprint" ]]; then
		echo "dev-build: Jouzu dependency inputs changed during install; rerun to install the updated inputs" >&2
		return 1
	fi
	if ! write_dependency_receipt "$after_fingerprint"; then
		echo "dev-build: could not record the Jouzu dependency install receipt; the next build will reinstall" >&2
	fi
}

realpath_file() {
	node -e 'process.stdout.write(require("node:fs").realpathSync(process.argv[1]))' "$1" 2>/dev/null
}

command_target() {
	local command_path
	command_path="$(command -v "$1" 2>/dev/null)" || return 1
	[[ -n "$command_path" ]] || return 1
	realpath_file "$command_path"
}

ensure_development_link() {
	local expected name target needs_link=false failed=false
	expected="$(realpath_file "$JOUZU_REPO/packages/cli/dist/cli.js")" || {
		echo "dev-build: rebuilt CLI entrypoint is missing: $JOUZU_REPO/packages/cli/dist/cli.js" >&2
		return 1
	}

	for name in jz jouzu; do
		target="$(command_target "$name" || true)"
		if [[ "$target" != "$expected" ]]; then
			needs_link=true
		fi
	done
	if [[ "$needs_link" == true ]]; then
		echo "dev-build: linking jz and jouzu to $JOUZU_REPO/packages/cli"
		if ! (cd -- "$JOUZU_REPO" && npm link --workspace packages/cli --ignore-scripts); then
			echo "dev-build: npm could not link the Jouzu CLI workspace" >&2
			return 1
		fi
		hash -r 2>/dev/null || true
	fi

	for name in jz jouzu; do
		target="$(command_target "$name" || true)"
		if [[ "$target" != "$expected" ]]; then
			echo "dev-build: $name resolves to ${target:-<missing>}; expected $expected" >&2
			failed=true
		fi
	done
	if [[ "$failed" == true ]]; then
		echo "dev-build: remove or reorder the competing jz/jouzu command on PATH" >&2
		return 1
	fi
	echo "dev-build: jz and jouzu resolve to $expected"
}

build_jouzu() {
	local head
	head="$(git -C "$JOUZU_REPO" rev-parse --short HEAD)" || return 1
	echo "dev-build: preparing Jouzu at $head ($JOUZU_REPO)"

	if ! bootstrap_dependencies; then
		echo "dev-build: existing CLI dist files were not rebuilt" >&2
		return 1
	fi

	# A clean checkout has no Session UI dist. Build that workspace before the
	# CLI check because the CLI imports its declarations through package exports.
	if ! npm --prefix "$JOUZU_REPO" run build --workspace packages/session-ui; then
		echo "dev-build: Session UI bootstrap failed; existing CLI dist files were not rebuilt" >&2
		return 1
	fi

	if ! node "$JOUZU_REPO/scripts/apply-pi-content-policy.mjs"; then
		echo "dev-build: Pi content policy setup failed; existing CLI dist files were not rebuilt" >&2
		return 1
	fi

	echo "dev-build: type-checking Jouzu CLI"
	# The no-emit CLI check prevents a failed TypeScript compile from replacing
	# the working globally linked CLI dist files with partial output.
	if ! npm --prefix "$JOUZU_REPO" run check --workspace packages/cli; then
		echo "dev-build: type-check failed; existing dist files were not rebuilt" >&2
		return 1
	fi

	echo "dev-build: rebuilding Jouzu with development identity"
	if ! npm --prefix "$JOUZU_REPO" run build:dev; then
		echo "dev-build: rebuild failed" >&2
		return 1
	fi
	if ! node "$JOUZU_REPO/scripts/check-dist-fresh.mjs"; then
		echo "dev-build: rebuilt dist did not pass the freshness check" >&2
		return 1
	fi
	if [[ "$LINK_DEVELOPMENT" == true ]] && ! ensure_development_link; then
		echo "dev-build: development build exists, but command linking failed" >&2
		return 1
	fi
	if ! node "$JOUZU_REPO/scripts/dev-smoke.mjs" "$JOUZU_REPO/packages/cli/dist/cli.js"; then
		echo "dev-build: development build exists, but the runtime smoke failed" >&2
		return 1
	fi

	echo "dev-build: Jouzu rebuild complete"
}

hooks_dir() {
	local path
	path="$(git -C "$JOUZU_REPO" rev-parse --git-path hooks)" || return 1
	if [[ "$path" = /* ]]; then
		printf '%s\n' "$path"
	else
		printf '%s\n' "$JOUZU_REPO/$path"
	fi
}

is_managed_hook() {
	local path="$1"
	[[ -f "$path" && ! -L "$path" ]] && grep -Fqx "$HOOK_MARKER" "$path"
}

install_hooks() {
	local dir hook path temp node_bin
	dir="$(hooks_dir)" || return 1
	mkdir -p -- "$dir" || return 1

	for hook in "${HOOK_NAMES[@]}"; do
		path="$dir/$hook"
		if [[ -e "$path" || -L "$path" ]]; then
			if ! is_managed_hook "$path"; then
				echo "dev-build: refusing to replace existing hook: $path" >&2
				return 1
			fi
		fi
	done

	node_bin="$(node -p 'require("node:path").dirname(process.execPath)')" || return 1
	for hook in "${HOOK_NAMES[@]}"; do
		path="$dir/$hook"
		temp="$(mktemp "$dir/.${hook}.tmp.XXXXXX")" || return 1
		{
			printf '%s\n' '#!/usr/bin/env bash'
			printf '%s\n' "$HOOK_MARKER"
			printf 'export PATH=%q:"$PATH"\n' "$node_bin"
			printf 'target=%q\n' "$JOUZU_REPO"
			printf 'current="$(git rev-parse --show-toplevel 2>/dev/null)" || exit 0\n'
			printf 'current="$(cd -- "$current" && pwd -P)" || exit 0\n'
			printf '[[ "$current" == "$target" ]] || exit 0\n'
			printf 'exec %q __hook %q "$target" "$@"\n' "$SCRIPT_PATH" "$hook"
		} >"$temp"
		chmod 0755 "$temp" || return 1
		mv -f -- "$temp" "$path" || return 1
		echo "dev-build: installed $path"
	done
}

uninstall_hooks() {
	local dir hook path
	dir="$(hooks_dir)" || return 1

	for hook in "${HOOK_NAMES[@]}"; do
		path="$dir/$hook"
		if is_managed_hook "$path"; then
			rm -- "$path" || return 1
			echo "dev-build: removed $path"
		elif [[ -e "$path" || -L "$path" ]]; then
			echo "dev-build: left non-managed hook unchanged: $path" >&2
		fi
	done
}

rebase_in_progress() {
	local git_dir
	git_dir="$(git -C "$JOUZU_REPO" rev-parse --absolute-git-dir 2>/dev/null)" || return 1
	[[ -d "$git_dir/rebase-merge" || -d "$git_dir/rebase-apply" ]]
}

should_defer_hook_build() {
	local hook_name="$1"
	local previous_head="${2:-}"
	local checked_out_head="${3:-}"

	if ! rebase_in_progress; then
		return 1
	fi
	case "$hook_name" in
		post-commit)
			return 0
			;;
		post-checkout)
			# A branch that is only behind its new base completes the rebase with this
			# checkout and has no later post-rewrite hook.
			if [[ -n "$previous_head" && -n "$checked_out_head" ]] &&
				git -C "$JOUZU_REPO" merge-base --is-ancestor "$previous_head" "$checked_out_head" 2>/dev/null; then
				return 1
			fi
			return 0
			;;
		*)
			return 1
			;;
	esac
}

run_hook() {
	local hook_name="${1:-unknown}"
	if [[ -n "${2:-}" ]]; then
		JOUZU_REPO="$2"
	fi
	if ! resolve_jouzu_repo; then
		echo "dev-build: $hook_name hook could not locate the Jouzu checkout" >&2
		return 0
	fi
	if should_defer_hook_build "$hook_name" "${@:3}"; then
		echo "dev-build: deferring $hook_name rebuild until rebase completes"
		return 0
	fi
	if ! build_jouzu; then
		echo "dev-build: $hook_name hook rebuild failed; run $SCRIPT_PATH for details" >&2
	fi
	return 0
}

main() {
	local command="${1:-build}"
	if [[ "$command" != __hook && $# -gt 1 ]]; then
		echo "dev-build: unexpected arguments" >&2
		return 2
	fi
	case "$command" in
		build|link)
			[[ "$command" == link ]] && LINK_DEVELOPMENT=true
			resolve_jouzu_repo && build_jouzu
			;;
		install-hooks)
			resolve_jouzu_repo && install_hooks
			;;
		uninstall-hooks)
			resolve_jouzu_repo && uninstall_hooks
			;;
		__hook)
			run_hook "${@:2}"
			;;
		-h|--help|help)
			usage
			;;
		*)
			echo "dev-build: unknown command: $command" >&2
			usage >&2
			return 2
			;;
	esac
}

main "$@"
