"""Minimal console entry point for the Jouzu package-name reservation."""

from __future__ import annotations

import argparse
import json
import platform
from collections.abc import Sequence

from jouzu import __version__

_PREVIEW_MESSAGE = (
    "Jouzu is reserved for an upcoming CJK-safe Pi distribution. "
    "This preview package is not functional yet."
)


def _parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(prog="jouzu", description=_PREVIEW_MESSAGE)
    parser.add_argument("--version", action="version", version=__version__)
    subparsers = parser.add_subparsers(dest="command")
    subparsers.add_parser("doctor", help="show preview package diagnostics")
    return parser


def main(argv: Sequence[str] | None = None) -> int:
    """Run the minimal Jouzu preview command."""
    args = _parser().parse_args(argv)
    if args.command == "doctor":
        print(
            json.dumps(
                {
                    "name": "jouzu",
                    "version": __version__,
                    "status": "package-name-reservation",
                    "python": platform.python_version(),
                    "platform": platform.system().lower(),
                    "architecture": platform.machine(),
                },
                indent=2,
            )
        )
        return 0
    print(_PREVIEW_MESSAGE)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
