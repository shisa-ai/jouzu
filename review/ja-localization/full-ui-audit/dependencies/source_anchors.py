"""Bounded source-only anchors for the dependency audit; not a JavaScript parser.

Only unique, line-start declaration shapes receive declaration/implementation labels.
Expressions and first textual occurrences remain explicitly non-implementation evidence.
"""
import re


_IDENTIFIER = re.compile(r"[A-Za-z_$][\w$]*\Z")


def _declarations(data, symbol):
    """Return unique declaration/body shapes, never ordinary calls or callbacks."""
    name = symbol.rsplit(".", 1)[-1]
    if not _IDENTIFIER.fullmatch(name):
        return []
    escaped = re.escape(name)
    patterns = [
        ("implementation:class", rf"^[ \t]*(?:export[ \t]+)?(?:default[ \t]+)?class[ \t]+{escaped}\b[^\n;]*\{{"),
        ("implementation:function", rf"^[ \t]*(?:export[ \t]+)?(?:default[ \t]+)?(?:async[ \t]+)?function[ \t]+{escaped}[ \t]*(?:<[^\n;]+>)?\([^;]*?\)[ \t]*(?::[^\n{{;]+)?\s*\{{"),
        ("implementation:method", rf"^[ \t]+(?:(?:public|private|protected|static|async|override)[ \t]+)*{escaped}[ \t]*(?:<[^\n;]+>)?\([^\n;]*\)[ \t]*(?::[^\n{{;]+)?[ \t]*\{{"),
        ("declaration:initializer", rf"^[ \t]*(?:export[ \t]+)?(?:const|let|var)[ \t]+{escaped}\b[^\n=;]*=[ \t]*(?!=)"),
    ]
    if name == "default":
        patterns.append(("implementation:function", r"^[ \t]*export[ \t]+default[ \t]+(?:async[ \t]+)?function(?:[ \t]+[A-Za-z_$][\w$]*)?[ \t]*\([^;]*?\)[ \t]*(?::[^\n{;]+)?\s*\{"))
    # Qualified class methods require the claimed class to exist in this source.
    # A repeated declaration shape remains ambiguous rather than silently selecting one.
    if "." in symbol:
        owner = symbol.rsplit(".", 1)[0]
        owner_pattern = rf"^[ \t]*(?:export[ \t]+)?class[ \t]+{re.escape(owner)}\b[^\n;]*\{{"
        if not re.search(owner_pattern, data, re.MULTILINE):
            return []
        patterns = [item for item in patterns if item[0] == "implementation:method"]
    matches = {}
    for kind, pattern in patterns:
        for match in re.finditer(pattern, data, re.MULTILINE):
            matches[match.start()] = (kind, match)
    return list(matches.values())


def resolve_source_anchor(data, symbol, anchor="", line_no=None):
    """Resolve a declaration or label exact-expression/textual-reference evidence.

    Explicit extraction anchors stay expressions/references. For ordinary symbol
    lookups, a unique declaration wins even when a call/import appears earlier.
    Initializers are labeled as declarations, not asserted function bodies.
    """
    needle = anchor or symbol.rsplit(".", 1)[-1]
    assert needle and needle in data, (symbol, needle)
    lines = data.splitlines()
    if line_no is not None:
        assert 1 <= line_no <= len(lines), (symbol, line_no)
        start = sum(len(line) + 1 for line in lines[:line_no - 1])
        assert data.startswith(needle, start + len(lines[line_no - 1]) - len(lines[line_no - 1].lstrip())) or needle in lines[line_no - 1], (symbol, line_no, needle)
        kind, offset, reason = "source-expression", start, "Explicit extraction line; not an implementation anchor."
    else:
        declarations = _declarations(data, symbol) if not anchor else []
        if len(declarations) == 1:
            kind, match = declarations[0]
            offset = match.start()
            line_no = data.count("\n", 0, offset) + 1
            reason = "Unique line-start declaration/body shape; source-only, not runtime verification."
        else:
            offset = data.index(needle)
            line_no = data.count("\n", 0, offset) + 1
            kind = "textual-reference"
            reason = "Explicit textual anchor; not an implementation claim." if anchor else "No unique supported declaration/body match; first textual occurrence only, not an implementation claim."
    earlier_line, earlier_kind, earlier_source = "", "", ""
    name = symbol.rsplit(".", 1)[-1]
    if kind.startswith(("implementation:", "declaration:")):
        # Keep actual earlier this.method(...) calls separate from the body anchor.
        caller = re.search(rf"\bthis\.{re.escape(name)}[ \t]*\(", data[:offset])
        reference = caller.start() if caller else data.find(name, 0, offset)
        if reference >= 0:
            earlier_line = data.count("\n", 0, reference) + 1
            earlier_kind = "caller-reference" if caller else "textual-reference"
            earlier_source = lines[earlier_line - 1].strip()
    return {
        "anchor_kind": kind,
        "line": line_no,
        "matched_source": lines[line_no - 1].strip(),
        "earlier_reference_kind": earlier_kind,
        "earlier_reference_line": earlier_line,
        "earlier_reference_source": earlier_source,
        "anchor_limit": reason,
    }
