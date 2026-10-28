"""Read-only complete nonblank-line documentation export verification.

This is source-text extraction, not runtime/caller/behavior qualification.
No document instructions, API examples, asset prompts, links or commands execute.
"""
import csv,hashlib,json,re,unicodedata
from collections import Counter,defaultdict
from functools import cache
from pathlib import Path
ROOT=Path(__file__).resolve().parents[2]
HERE=Path(__file__).resolve().parent
REVISION="346d1e481757a55eb62fc066e43bbc7999b8e6dd"
COLUMNS=["item_id","source_text","source_location","audience","line_kind","source_scripts","read_condition","prior_coverage","evidence"]
SCOPE_COLUMNS=["source","status","coverage","sha256","revision","detail"]
@cache
def raw(path):return (ROOT/path).read_bytes()
@cache
def text(path):return raw(path).decode("utf-8")
@cache
def source_lines(path):
    result=[];offset=0
    for number,line in enumerate(text(path).splitlines(keepends=True),1):
        ending="CRLF" if line.endswith("\r\n") else "LF" if line.endswith("\n") else "CR" if line.endswith("\r") else "none"
        content=line[:-2] if ending=="CRLF" else line[:-1] if ending in ("LF","CR") else line
        result.append((number,offset,offset+len(content),content,ending));offset+=len(line)
    assert offset==len(text(path));return result

PRIVACY_PATTERNS={
"home-absolute":r'(?<![A-Za-z0-9])(?:[A-Za-z]:[\\/](?:Users|Documents and Settings)[\\/]|/(?:Users|home)/)[^\s`"<>|]+',
"local-host":r'\b(?:localhost|127(?:\.\d{1,3}){3}|0\.0\.0\.0|(?:DESKTOP|LAPTOP)-[A-Za-z0-9_-]+)\b|\[::1\]',
"private-ip":r'\b(?:10(?:\.\d{1,3}){3}|192\.168(?:\.\d{1,3}){2}|172\.(?:1[6-9]|2\d|3[01])(?:\.\d{1,3}){2})\b',
"credential-shape":r'\b(?:sk-[A-Za-z0-9_-]{16,}|gh[pousr]_[A-Za-z0-9]{20,}|AKIA[A-Z0-9]{16})\b|-----BEGIN (?:RSA |OPENSSH |EC )?PRIVATE KEY-----',
"url-userinfo":r'https?://[^\s/:@`]+:[^\s/@`]+@',
"workspace-absolute":r'\b[A-Za-z]:[\\/]AI Projects[\\/][^`\n"<>|]+'
}
WIDE_SCREEN=r'(?<![A-Za-z0-9])(?:[A-Za-z]:[\\/]|/(?:mnt/[a-z]/|Users/|home/)|\\\\[A-Za-z])|(?i:api[_-]?key|token|secret|password)\s*[=:]'

def redact(line):
    found=[]
    for kind,pattern in PRIVACY_PATTERNS.items():
        found.extend((m.start(),m.end(),kind) for m in re.finditer(pattern,line,re.I))
    if hashlib.sha256(line.encode('utf-8')).hexdigest() not in {r['sha256'] for r in CREDENTIAL_EXAMPLES_REVIEWED}:
        for match in re.finditer(CREDENTIAL_ASSIGNMENT_PATTERN,line):
            a,b=match.span(1 if match[1] else 2);found.append((a,b,'credential-assignment'))
    # Merge overlaps so no sensitive substring leaks through competing matches.
    groups=[]
    for start,end,kind in sorted(found):
        if groups and start<=groups[-1][1]:groups[-1]=(groups[-1][0],max(end,groups[-1][1]),groups[-1][2]|{kind})
        else:groups.append((start,end,{kind}))
    pieces=[];previous=0;evidence=[]
    for a,b,kinds in groups:
        label="[REDACTED:"+"+".join(sorted(kinds))+"]";pieces.extend([line[previous:a],label]);previous=b
        evidence.append(dict(start=a,end=b,kinds=sorted(kinds),sha256=hashlib.sha256(line[a:b].encode("utf-8")).hexdigest(),replacement=label))
    pieces.append(line[previous:]);return "".join(pieces),evidence


def scripts(line):
    found=set()
    for c in line:
        if not c.isalpha():continue
        name=unicodedata.name(c,"")
        if 'LATIN' in name:found.add('Latin')
        elif 'CJK' in name or 'IDEOGRAPH' in name:found.add('Han')
        elif 'HIRAGANA' in name:found.add('Hiragana')
        elif 'KATAKANA' in name:found.add('Katakana')
        elif 'HANGUL' in name:found.add('Hangul')
        elif 'CYRILLIC' in name:found.add('Cyrillic')
        elif 'GREEK' in name:found.add('Greek')
        else:found.add('Other-letter')
    return ";".join(sorted(found)) if found else "none"


def line_kinds(path):
    result={};fence=None
    for number,start,end,line,ending in source_lines(path):
        if not line.strip():continue
        marker=re.match(r"^\s*(`{3,}|~{3,})(.*)$",line)
        if marker and fence and marker[1][0]==fence[0] and len(marker[1])>=fence[1] and not marker[2].strip():kind='fence-close';fence=None
        elif marker and not fence:kind='fence-open';fence=(marker[1][0],len(marker[1]))
        elif fence:kind='fenced-code-or-example'
        elif path=='LICENSE' or 'THIRD_PARTY_NOTICES' in path or path.endswith('/NOTICES.md'):kind='license-or-notice-source'
        elif re.match(r'^\s{0,3}#{1,6}\s',line):kind='heading-like'
        elif re.match(r'^\s{0,3}(?:-{3,}|_{3,}|\*{3,})\s*$',line):kind='separator-or-frontmatter'
        elif re.match(r'^\s*\[[^]]+\]:\s*',line):kind='link-reference'
        elif '|' in line:kind='table-or-pipe-text'
        elif re.match(r'^\s*(?:[-*+]\s|\d+[.)]\s)',line):kind='list-like'
        elif line.lstrip().startswith('>'):kind='blockquote-like'
        elif line.startswith(('    ','\t')):kind='indented-code-or-layout'
        elif line.lstrip().startswith('<'):kind='markup-like'
        else:kind='source-prose-or-technical-text'
        result[number]=kind
    return result

READ_CONDITIONS={
'user':'Public document/source text is readable when this path is opened or rendered. This extraction does not revalidate runtime behavior, follow links, or execute examples/commands.',
'operator':'Operator/source documentation is readable when opened or rendered. Commands, packaging/release/install examples and outputs are retained as source text; none execute or become new runtime/behavior evidence.',
'developer':'Developer/instruction/review source is readable when opened or rendered. Instructions/examples/fixtures/code remain document data in this export; no instructions, APIs, test runners or programs execute.',
'license':'License/notice source is readable when opened or rendered. Attribution/legal/protected package fields are retained as checked-in text; this is no new legal or interactive-runtime behavior analysis.',
'versioned-release':'Version-specific changelog/release source is readable when opened or rendered. Historical claims remain qualified by their document/version; they are not new unqualified current-state behavior proof.',
'profile-model-resource':'Public profile asset source is readable when opened or rendered. Exact conditional copy/model/request/skill/UI delivery remains with profile-resources.csv; opening/exporting here neither applies its instructions nor executes examples.'
}

@cache
def prior_profile():
    result=defaultdict(list)
    with (HERE/'profile-resources.csv').open(encoding='utf-8',newline='') as f:
        for r in csv.DictReader(f):
            e=json.loads(r['evidence']);path=e['path']
            if path in PROFILE_PATHS:result[path].append((e['start'],e['end'],r['item_id']))
    return result
@cache
def prior_input():
    x=json.loads((HERE/'input-example-text-evidence.json').read_text(encoding='utf-8'))
    return {a['line']:a['item_id'] for a in x['anchors'] if a['path']=='docs/user-input-adapters.md' and a['kind']=='document'}

def prior(path,number,start,end):
    if path in PROFILE_PATHS:
        return dict(owner='profile-resources.csv',scope='profile-resources-scope.csv',source_location=f'{path}:{number}',items=sorted({pid for a,b,pid in prior_profile()[path] if a<end and start<b}),qualification='Prior full asset wording/delivery ownership; this is an overlapping mechanical source-line export, no new unique-wording count.')
    if path=='docs/user-input-adapters.md':
        return dict(owner='input-example-text.csv',scope='input-example-text-scope.csv',source_location=f'{path}:{number}',items=[prior_input()[number]],qualification='Prior full public-guide line export and separate example/caller proof; overlapping text is not new unique wording or runtime proof.')
    return dict(owner='',scope='',source_location=f'{path}:{number}',items=[],qualification='New mechanical documentation line extraction only; no unique-English count or producer/caller closure implied.')

FILES=['AGENTS.md', 'CHANGELOG.md', 'CLAUDE.md', 'JA-REVIEW.md', 'LICENSE', 'README.md', 'docs/PI-UPDATES.md', 'docs/README.md', 'docs/acp.md', 'docs/analysis/ZCODE-PRIVACY-AUDIT.md', 'docs/architecture.md', 'docs/astra.md', 'docs/bug-reporting.md', 'docs/cache-warming.md', 'docs/catalogs.md', 'docs/ci.md', 'docs/configuration.md', 'docs/development.md', 'docs/diagnostics.md', 'docs/evaluation/per-language-eval-criteria.md', 'docs/flow-control.md', 'docs/interface.md', 'docs/key-collisions.md', 'docs/keybindings.md', 'docs/language.md', 'docs/localization-cjk-verification.md', 'docs/localization-glossary.md', 'docs/localization-zh-hans-glossary.md', 'docs/localization-zh-hant-glossary.md', 'docs/localization.md', 'docs/models.md', 'docs/palette-ux.md', 'docs/profiles.md', 'docs/releases/v0.1.0.md', 'docs/releases/v0.1.1.md', 'docs/releases/v0.1.10.md', 'docs/releases/v0.1.11.md', 'docs/releases/v0.1.12.md', 'docs/releases/v0.1.13.md', 'docs/releases/v0.1.14.md', 'docs/releases/v0.1.15.md', 'docs/releases/v0.1.16.md', 'docs/releases/v0.1.17.md', 'docs/releases/v0.1.18.md', 'docs/releases/v0.1.2.md', 'docs/releases/v0.1.3.md', 'docs/releases/v0.1.4.md', 'docs/releases/v0.1.5.md', 'docs/releases/v0.1.6.md', 'docs/releases/v0.1.7.md', 'docs/releases/v0.1.8.md', 'docs/releases/v0.1.9.md', 'docs/releases/v0.2.0.md', 'docs/releases/v0.2.1.md', 'docs/releases/v0.2.2.md', 'docs/releases/v0.2.3.md', 'docs/session-labels.md', 'docs/shisa.md', 'docs/subagents.md', 'docs/testing.md', 'docs/textguard.md', 'docs/tools.md', 'docs/updates.md', 'docs/user-input-adapters.md', 'docs/ux.md', 'docs/voice.md', 'docs/web.md', 'docs/windows.md', 'packages/cli/README.md', 'packages/cli/THIRD_PARTY_NOTICES.md', 'packages/cli/profiles/core/assets/jouzu-anti-slop-skill.md', 'packages/cli/profiles/core/assets/jouzu-clear-writing-skill.md', 'packages/cli/profiles/core/assets/jouzu-delegation-skill.md', 'packages/cli/profiles/core/assets/jouzu-reference-skill.md', 'packages/cli/profiles/core/assets/jouzu-reference/configuration.md', 'packages/cli/profiles/core/assets/jouzu-reference/controls.md', 'packages/cli/profiles/core/assets/jouzu-reference/history.md', 'packages/cli/profiles/core/assets/jouzu-reference/models.md', 'packages/cli/profiles/core/assets/jouzu-review.md', 'packages/cli/profiles/core/assets/jouzu-source-check-skill.md', 'packages/cli/profiles/ja/assets/APPEND_SYSTEM.md', 'packages/session-ui/README.md', 'packages/session-ui/THIRD_PARTY_NOTICES.md', 'packaging/launcher/NOTICES.md', 'packaging/launcher/README.md', 'python/jouzu/README.md', 'upstream/textguard/README.md']
PROFILE_PATHS=['packages/cli/profiles/core/assets/jouzu-anti-slop-skill.md', 'packages/cli/profiles/core/assets/jouzu-clear-writing-skill.md', 'packages/cli/profiles/core/assets/jouzu-delegation-skill.md', 'packages/cli/profiles/core/assets/jouzu-reference-skill.md', 'packages/cli/profiles/core/assets/jouzu-reference/configuration.md', 'packages/cli/profiles/core/assets/jouzu-reference/controls.md', 'packages/cli/profiles/core/assets/jouzu-reference/history.md', 'packages/cli/profiles/core/assets/jouzu-reference/models.md', 'packages/cli/profiles/core/assets/jouzu-review.md', 'packages/cli/profiles/core/assets/jouzu-source-check-skill.md', 'packages/cli/profiles/ja/assets/APPEND_SYSTEM.md']
AUDIENCES={'AGENTS.md': 'developer', 'CHANGELOG.md': 'versioned-release', 'CLAUDE.md': 'developer', 'JA-REVIEW.md': 'developer', 'LICENSE': 'license', 'README.md': 'user', 'docs/PI-UPDATES.md': 'operator', 'docs/README.md': 'user', 'docs/acp.md': 'user', 'docs/analysis/ZCODE-PRIVACY-AUDIT.md': 'developer', 'docs/architecture.md': 'developer', 'docs/astra.md': 'user', 'docs/bug-reporting.md': 'user', 'docs/cache-warming.md': 'user', 'docs/catalogs.md': 'user', 'docs/ci.md': 'operator', 'docs/configuration.md': 'user', 'docs/development.md': 'developer', 'docs/diagnostics.md': 'operator', 'docs/evaluation/per-language-eval-criteria.md': 'developer', 'docs/flow-control.md': 'user', 'docs/interface.md': 'user', 'docs/key-collisions.md': 'developer', 'docs/keybindings.md': 'user', 'docs/language.md': 'user', 'docs/localization-cjk-verification.md': 'developer', 'docs/localization-glossary.md': 'developer', 'docs/localization-zh-hans-glossary.md': 'developer', 'docs/localization-zh-hant-glossary.md': 'developer', 'docs/localization.md': 'developer', 'docs/models.md': 'user', 'docs/palette-ux.md': 'developer', 'docs/profiles.md': 'user', 'docs/releases/v0.1.0.md': 'versioned-release', 'docs/releases/v0.1.1.md': 'versioned-release', 'docs/releases/v0.1.10.md': 'versioned-release', 'docs/releases/v0.1.11.md': 'versioned-release', 'docs/releases/v0.1.12.md': 'versioned-release', 'docs/releases/v0.1.13.md': 'versioned-release', 'docs/releases/v0.1.14.md': 'versioned-release', 'docs/releases/v0.1.15.md': 'versioned-release', 'docs/releases/v0.1.16.md': 'versioned-release', 'docs/releases/v0.1.17.md': 'versioned-release', 'docs/releases/v0.1.18.md': 'versioned-release', 'docs/releases/v0.1.2.md': 'versioned-release', 'docs/releases/v0.1.3.md': 'versioned-release', 'docs/releases/v0.1.4.md': 'versioned-release', 'docs/releases/v0.1.5.md': 'versioned-release', 'docs/releases/v0.1.6.md': 'versioned-release', 'docs/releases/v0.1.7.md': 'versioned-release', 'docs/releases/v0.1.8.md': 'versioned-release', 'docs/releases/v0.1.9.md': 'versioned-release', 'docs/releases/v0.2.0.md': 'versioned-release', 'docs/releases/v0.2.1.md': 'versioned-release', 'docs/releases/v0.2.2.md': 'versioned-release', 'docs/releases/v0.2.3.md': 'versioned-release', 'docs/session-labels.md': 'user', 'docs/shisa.md': 'user', 'docs/subagents.md': 'user', 'docs/testing.md': 'developer', 'docs/textguard.md': 'user', 'docs/tools.md': 'user', 'docs/updates.md': 'operator', 'docs/user-input-adapters.md': 'developer', 'docs/ux.md': 'developer', 'docs/voice.md': 'user', 'docs/web.md': 'user', 'docs/windows.md': 'operator', 'packages/cli/README.md': 'user', 'packages/cli/THIRD_PARTY_NOTICES.md': 'license', 'packages/cli/profiles/core/assets/jouzu-anti-slop-skill.md': 'profile-model-resource', 'packages/cli/profiles/core/assets/jouzu-clear-writing-skill.md': 'profile-model-resource', 'packages/cli/profiles/core/assets/jouzu-delegation-skill.md': 'profile-model-resource', 'packages/cli/profiles/core/assets/jouzu-reference-skill.md': 'profile-model-resource', 'packages/cli/profiles/core/assets/jouzu-reference/configuration.md': 'profile-model-resource', 'packages/cli/profiles/core/assets/jouzu-reference/controls.md': 'profile-model-resource', 'packages/cli/profiles/core/assets/jouzu-reference/history.md': 'profile-model-resource', 'packages/cli/profiles/core/assets/jouzu-reference/models.md': 'profile-model-resource', 'packages/cli/profiles/core/assets/jouzu-review.md': 'profile-model-resource', 'packages/cli/profiles/core/assets/jouzu-source-check-skill.md': 'profile-model-resource', 'packages/cli/profiles/ja/assets/APPEND_SYSTEM.md': 'profile-model-resource', 'packages/session-ui/README.md': 'developer', 'packages/session-ui/THIRD_PARTY_NOTICES.md': 'license', 'packaging/launcher/NOTICES.md': 'license', 'packaging/launcher/README.md': 'operator', 'python/jouzu/README.md': 'operator', 'upstream/textguard/README.md': 'developer'}
WIDE_SCREEN_REVIEWED=[{'path': 'JA-REVIEW.md', 'line': 66, 'sha256': '026d1552bb635bb7b7fa9c749749bfa0dfec2245b58d413b3ea02bfc41bbfed2', 'reason': 'Generic public Program Files Node.js installation path in a WSL example; no user/home/workspace identity.'}, {'path': 'JA-REVIEW.md', 'line': 74, 'sha256': 'd2f6a54186755ab5a2d622baf0ddc3aa6ca18f1d050637ac057754ae641a966e', 'reason': 'Generic /mnt drive placeholder with ellipsis; no actual private user path.'}, {'path': 'docs/evaluation/per-language-eval-criteria.md', 'line': 44, 'sha256': '3cb9da41c26411367b949d74929859453db0348629e4fc4c6e54822e26170a11', 'reason': 'Six-character synthetic API_KEY literal in documented evaluation fixture; no provider credential prefix or live account context.'}]

CREDENTIAL_ASSIGNMENT_PATTERN='(?i)(?:"(?:[a-z0-9_]*(?:key|token|secret|password)|apiKey|authorization)"\\s*:\\s*"([^"\\n]+)"|\\b[A-Z0-9_]*(?:API_KEY|TOKEN|SECRET|PASSWORD)\\s*=\\s*([^\\s`]+))'
CREDENTIAL_EXAMPLES_REVIEWED=[{'path': 'docs/evaluation/per-language-eval-criteria.md', 'line': 44, 'sha256': '3cb9da41c26411367b949d74929859453db0348629e4fc4c6e54822e26170a11', 'reason': 'Documented synthetic six-character fixture sentinel, not provider credentials.'}, {'path': 'docs/tools.md', 'line': 36, 'sha256': 'b1e98d9627b774709ac2f0b071dd7f7ed692f535e8189d9156993191146d1253', 'reason': 'Bearer Authorization example contains an explicit template placeholder; no live token.'}]

SOURCE_BLOBS={'AGENTS.md': '2f379107a8c0ef5e5618e5ba6095dc8e3c43ff9d', 'CHANGELOG.md': '53d56217242470975a5c0c0adf925835cccfa134', 'CLAUDE.md': '47dc3e3d863cfb5727b87d785d09abf9743c0a72', 'JA-REVIEW.md': 'de8d66c4101a0761b8f029de50c48e63082b12fc', 'LICENSE': 'b07bcc81c52c06c5e8266db2ce71cc66f6e5ba5e', 'README.md': 'd687dc00965e0952eb6d2bb0192dc365b3f8dc82', 'docs/PI-UPDATES.md': '9a55e481e3798220d460dde29eefbc46ce250def', 'docs/README.md': '32989a24c1bd55d633cb3254031be7dc4ba9d68b', 'docs/acp.md': 'd4288f4636b1a18274f21e234ead852a24e81dc2', 'docs/analysis/ZCODE-PRIVACY-AUDIT.md': '3268c62e4a5202ed37dccde684381e4cfd752d58', 'docs/architecture.md': '4f978f0e99ea6fa3c1a1d6c24cf98322b78dce36', 'docs/astra.md': '9b27c265a1ab093e06b412c746adf2d1402eb84c', 'docs/bug-reporting.md': '351540f1f7a90d7eb0e1bb49624b73e0798a2827', 'docs/cache-warming.md': 'a03ca4950b6e3fab2044625d522bcd457d6c1ed4', 'docs/catalogs.md': 'f441c119178b6869727722ee5fe9cccc1e421876', 'docs/ci.md': 'cb1c47a61a0ab8b3342b30218481c9c59c68a45e', 'docs/configuration.md': 'bf8f1b4aed90ca0b4355ed692f006ba54c2ccdc1', 'docs/development.md': 'de566d84a7b824420b982386ac985e38db7a57a7', 'docs/diagnostics.md': '2b2030c648fcc4112d3eb26162cde38aebd6b069', 'docs/evaluation/per-language-eval-criteria.md': '11c14a8e7ce53a68346b6174e6ce9a4e9420ab2f', 'docs/flow-control.md': '24168cce4e2d07003b4bb7acd304634c1a3ee7df', 'docs/interface.md': '375248e8a8fd5272ebf987a00c7ef09760f8f79e', 'docs/key-collisions.md': '68dcf4f1cb7194a01739970d3d898a6bcdd74b67', 'docs/keybindings.md': '380808e9367f449241499ba0a4acf1f69a08bc8c', 'docs/language.md': '9605eff0bd7181b8161c28cd320c2312f6992b66', 'docs/localization-cjk-verification.md': 'f942adc1ef2b35f9f35b4dfb405ec985fc976d63', 'docs/localization-glossary.md': '7242c2ef20e6c00a16eaa4694b63bcbb50251212', 'docs/localization-zh-hans-glossary.md': '5c3a7f0aadf296564c5444785340c9f21f276fdf', 'docs/localization-zh-hant-glossary.md': '94bb96ec20f73c15e9e27ddefe3f48e78fe7b300', 'docs/localization.md': '7f9bdcc66df88fb141ae9d5e41f6e840adcc9458', 'docs/models.md': '0b928442afa164622683bb22dfd92c6395062954', 'docs/palette-ux.md': '794dcaa412a8a512ed27debaf4d4b91cac104e4b', 'docs/profiles.md': '817e3ce4847a4b6cfcf5b662e301573badadc9e3', 'docs/releases/v0.1.0.md': '829d52c7e2b5b94a6a2c5951d748c8fdef127987', 'docs/releases/v0.1.1.md': 'e15e0a256fba2320945b0964a59dde39275b8dfd', 'docs/releases/v0.1.10.md': '6cff82d93d0cb8230927dedb4f4023b9bd873f94', 'docs/releases/v0.1.11.md': '690edd8fecb7b47a63173790093d6fa4e897b8f0', 'docs/releases/v0.1.12.md': '108d423c0fd07cbabbf027b21b47c6e893f38c4b', 'docs/releases/v0.1.13.md': 'a435d5d991a2a6011361e8c960bf151f161569a3', 'docs/releases/v0.1.14.md': '3981af8abca99de4c9f34340e44213adfe5cdf47', 'docs/releases/v0.1.15.md': 'fa8601c58eba7d158b9d60624e4157f1ae23e394', 'docs/releases/v0.1.16.md': '2cf1f63127375e05e29ea2f3675c987ef566f4ef', 'docs/releases/v0.1.17.md': '60e75139a1f8e9e0eca7e8811b67f30d7f4d481e', 'docs/releases/v0.1.18.md': 'a3b8e5a333dec8ca0d208e1ab6852a02876c7c09', 'docs/releases/v0.1.2.md': '589c067997444e327b96e1a14b1cd1f47e986404', 'docs/releases/v0.1.3.md': 'ac84d35e599be485d3a14a902acea077fac8560d', 'docs/releases/v0.1.4.md': 'cc426fe393b77a23db501cb94cc385940350945f', 'docs/releases/v0.1.5.md': 'b7aae909aece102711788b62cc1bbaeb36cc9a8e', 'docs/releases/v0.1.6.md': '09874bb0431e39b992187e88a61c14d7936e8643', 'docs/releases/v0.1.7.md': '34c8cc8ee1e0fdf772f1738fb9926cd44b8a3dfb', 'docs/releases/v0.1.8.md': '1cf0fbd9e3ea85d88cd33d3ee24797c16eb25334', 'docs/releases/v0.1.9.md': 'cb661421d0a68aec9fa787f6bcc8701eaf0e5498', 'docs/releases/v0.2.0.md': 'a9eb35cd917d58e18fc37cc59eca6f67f5bf13cf', 'docs/releases/v0.2.1.md': 'c57d1798db5b15e7c0e14fbff9f900ab411fa57f', 'docs/releases/v0.2.2.md': 'fe5b7f0c7b6e2b7e182cf9d8206765580a90259a', 'docs/releases/v0.2.3.md': 'caf117834478e3ebde759647e12066359e7ffc91', 'docs/session-labels.md': 'cbde4235e73cd3bc9bb7aa53c413ebe9067f0e9b', 'docs/shisa.md': '00c520b8412384817ead4064a8166d913294b98f', 'docs/subagents.md': '35603239ab83aeaab6b8e7e7600a80c4a7779b48', 'docs/testing.md': '88914c35c6541eaf5686c39f5bb8a5d8bff552d6', 'docs/textguard.md': '21653429a19144cbef20a7c6020b431304c7115c', 'docs/tools.md': '8afd1b142d275cfe8be30375ad2da64b49e4bae4', 'docs/updates.md': '2a109e7b34febaca9b3850c7967b7e4fc89931b2', 'docs/user-input-adapters.md': 'd7d2ef6601e5b817767bb6f0ec3ee35a7b8ccb19', 'docs/ux.md': '3ee5cdbdef6ee50b4ea0632ef0bc211cdf194a2a', 'docs/voice.md': '31958b47773b556986ee29fdca9e0a3f205dbf3d', 'docs/web.md': '72cb5c028d30952ea168e5492a69536e4ded9049', 'docs/windows.md': 'aa28cb9e29bf9f7511b9e2d7928a1d37f4cc1f2d', 'packages/cli/README.md': 'd687dc00965e0952eb6d2bb0192dc365b3f8dc82', 'packages/cli/THIRD_PARTY_NOTICES.md': '0b4438817baf4d7f375e2a3a6509d56490e94c67', 'packages/cli/profiles/core/assets/jouzu-anti-slop-skill.md': '1373659e03551a44e6b54424876bdb8249876346', 'packages/cli/profiles/core/assets/jouzu-clear-writing-skill.md': '99006ef4cab08a242dfd185ebf0190956f417d8d', 'packages/cli/profiles/core/assets/jouzu-delegation-skill.md': '0d213a9162233c20b2a1198b60fad9de37d0038f', 'packages/cli/profiles/core/assets/jouzu-reference-skill.md': '1e841e2e1c552c63aa00acfe0a8c531f07eae2ef', 'packages/cli/profiles/core/assets/jouzu-reference/configuration.md': '4d3892cf44aadcf7b58c6c1c98381e77cded58b4', 'packages/cli/profiles/core/assets/jouzu-reference/controls.md': 'cf97d173f7256678ad034ea0d911ff0e8a9cdcf8', 'packages/cli/profiles/core/assets/jouzu-reference/history.md': '3c4b4ff40f3f54e088476fd3e5801cec91b8032c', 'packages/cli/profiles/core/assets/jouzu-reference/models.md': '395399e2f3a3e18fb80ba0affaf5581e07983044', 'packages/cli/profiles/core/assets/jouzu-review.md': 'd5007a216210525512bc4e629340d6cb3e4083cc', 'packages/cli/profiles/core/assets/jouzu-source-check-skill.md': 'bdf8cc2777096932b4d688625bdc9f7f46adc729', 'packages/cli/profiles/ja/assets/APPEND_SYSTEM.md': '38a3478bf13a4de96b3c35cbbd9761be2b1d9061', 'packages/session-ui/README.md': '446cf49e747fdac4a1c6bf48f86211b14ce59ed3', 'packages/session-ui/THIRD_PARTY_NOTICES.md': '2ba8861eaa2abda3ce341f1268ee9ac6b1e1b4ab', 'packaging/launcher/NOTICES.md': 'b3c4e921d8a5712d30d2123eec547f226d3fc2ba', 'packaging/launcher/README.md': 'a888f73caff8fa7a831483650f0d57819cef1d90', 'python/jouzu/README.md': 'bafbb9e3c63db6a97dff2d7b55712964f7d1fca8', 'upstream/textguard/README.md': 'b0e0e667853ad1290b5bb900c72d54dc3a241424'}
TABLE_HASHES={'documentation-text.csv': '81f289ebf6d2fc980fb0c6c086336344160e229af40a499b0be9421dae8cb412', 'documentation-text-scope.csv': '991e792ca55c30fba0de78c828fe46b097b199b6d2f5b45e1b1c3291e010b4f7'}


def table(name,columns):
    with (HERE/name).open(encoding='utf-8',newline='') as handle:
        reader=csv.DictReader(handle);assert reader.fieldnames==columns,name;rows=list(reader)
    assert all(set(r)==set(columns) and None not in r.values() for r in rows),name
    return rows


def main():
    for name,digest in TABLE_HASHES.items():assert hashlib.sha256((HERE/name).read_text(encoding='utf-8').encode()).hexdigest()==digest,name
    rows=table('documentation-text.csv',COLUMNS);scope=table('documentation-text-scope.csv',SCOPE_COLUMNS)
    assert len(rows)==6142 and len(scope)==92 and len({r['source'] for r in scope})==92
    assert all(r['revision']==REVISION for r in scope)
    assert Counter(r['status'] for r in scope)==Counter({'complete-nonblank-line-text-export':87,'finite-scope':1,'mechanical-source-export-method':1,'prior-owner-overlap':1,'bounded-source-privacy-screen':1,'read-only-source-authority':1})
    with (HERE/'source-census.csv').open(encoding='utf-8',newline='') as f:census={r['path']:r for r in csv.DictReader(f)}
    assert {p for p,r in census.items() if r['path_category']=='documentation-or-instructions'}==set(FILES)==set(SOURCE_BLOBS)
    assert len(FILES)==len(set(FILES))==87 and FILES==sorted(FILES)
    assert json.loads((HERE/'source-census-snapshot.json').read_text(encoding='utf-8'))['source_pin']==REVISION
    hashed={r['source']:r for r in scope if r['sha256']};assert set(hashed)==set(FILES)
    full={r['source'] for r in scope if r['status']=='complete-nonblank-line-text-export'};assert full==set(FILES)
    expected={};line_counts=Counter();kinds={};audiences=Counter();wide_found={};redacted_source=0;credential_found={}
    for path in FILES:
        source=raw(path);assert hashlib.sha256(source).hexdigest()==hashed[path]['sha256'],path
        assert hashlib.sha1(b'blob '+str(len(source)).encode()+b'\0'+source).hexdigest()==SOURCE_BLOBS[path]==census[path]['git_blob'],path
        metadata=json.loads(hashed[path]['detail']);assert metadata['source_git_blob']==SOURCE_BLOBS[path] and metadata['audience']==AUDIENCES[path]
        ls=source_lines(path);line_counts['all']+=len(ls);kinds[path]=line_kinds(path);audiences[AUDIENCES[path]]+=1
        assert metadata['prior_owner']==('profile-resources.csv' if path in PROFILE_PATHS else 'input-example-text.csv' if path=='docs/user-input-adapters.md' else '')
        assert metadata['source_scripts']==sorted({scripts(line) for number,a,b,line,ending in ls if line.strip()})
        for number,a,b,line,ending in ls:
            if not line.strip():line_counts['blank']+=1;continue
            expected[(path,number)]=(a,b,line,ending);line_counts['nonblank']+=1
            _,privacy=redact(line);redacted_source+=bool(privacy)
            if re.search(WIDE_SCREEN,line):wide_found[(path,number)]=hashlib.sha256(line.encode('utf-8')).hexdigest()
            if re.search(CREDENTIAL_ASSIGNMENT_PATTERN,line):credential_found[(path,number)]=hashlib.sha256(line.encode('utf-8')).hexdigest()
    assert line_counts==Counter({'all':8492,'nonblank':6142,'blank':2350})
    assert audiences==Counter({'developer':19,'versioned-release':24,'license':4,'user':22,'operator':7,'profile-model-resource':11})
    assert len(PROFILE_PATHS)==11 and all(AUDIENCES[p]=='profile-model-resource' for p in PROFILE_PATHS)
    assert {p for p in FILES if AUDIENCES[p]=='profile-model-resource'}==set(PROFILE_PATHS)
    assert wide_found=={(r['path'],r['line']):r['sha256'] for r in WIDE_SCREEN_REVIEWED} and len(wide_found)==3
    assert credential_found=={(r['path'],r['line']):r['sha256'] for r in CREDENTIAL_EXAMPLES_REVIEWED} and len(credential_found)==2
    assert len(set(wide_found)|set(credential_found))==4
    assert redacted_source==0 # Exact pinned source has no targeted sensitive match; not a general security claim.
    seen=set();prior_counts=Counter();script_counts=Counter();kind_counts=Counter();eol_counts=Counter();row_audiences=Counter()
    for index,row in enumerate(rows,1):
        assert row['item_id']==f'DOCUMENTATION-TEXT-{index:05d}'
        assert all(row[k] for k in COLUMNS),row['item_id']
        e=json.loads(row['evidence']);path=e['path'];number=e['line'];key=(path,number)
        assert key in expected and key not in seen;seen.add(key)
        a,b,line,ending=expected[key];assert (e['start'],e['end'])==(a,b) and text(path)[a:b]==line
        assert e['source_line_sha256']==hashlib.sha256(line.encode('utf-8')).hexdigest() and e['line_ending']==ending
        display,privacy=redact(line);assert row['source_text']==display and e['redactions']==privacy
        assert row['source_location']==f'{path}:{number}' and row['audience']==AUDIENCES[path]
        assert row['line_kind']==kinds[path][number] and row['source_scripts']==scripts(line)
        assert row['read_condition']==READ_CONDITIONS[AUDIENCES[path]]
        owner=prior(path,number,a,b);assert e['prior']==owner
        if owner['owner']:
            assert owner['source_location']==row['source_location'] and row['prior_coverage'].startswith(owner['owner']+'; exact source '+row['source_location'])
            prior_counts[owner['owner']]+=1
        else:assert row['prior_coverage']=='No earlier full documentation-line owner crosslinked; extraction only, no new unique-English count.'
        script_counts[row['source_scripts']]+=1;kind_counts[row['line_kind']]+=1;eol_counts[ending]+=1;row_audiences[row['audience']]+=1
    assert seen==set(expected)
    assert prior_counts==Counter({'profile-resources.csv':603,'input-example-text.csv':75}) and sum(prior_counts.values())==678
    assert row_audiences==Counter({'developer':2081,'versioned-release':1105,'license':263,'user':1539,'operator':551,'profile-model-resource':603})
    assert script_counts['Latin']==5653 and script_counts['none']==290 and sum(v for k,v in script_counts.items() if k not in ('Latin','none'))==199
    # Crosslinks validate exact earlier source identities/locations; old trigger prose is not frozen/rewritten.
    with (HERE/'profile-resources-scope.csv').open(encoding='utf-8',newline='') as f:profile_scope={r['source']:r for r in csv.DictReader(f)}
    assert sum(len(source_lines(p)) for p in PROFILE_PATHS)==847
    for path in PROFILE_PATHS:
        assert profile_scope[path]['status']=='fully-read-profile-markdown' and profile_scope[path]['sha256']==hashed[path]['sha256']
        for a,b,item in prior_profile()[path]:assert 0<=a<b<=len(text(path)) and item.startswith('PROFILE-RESOURCE-'),(path,item)
    with (HERE/'input-example-text.csv').open(encoding='utf-8',newline='') as f:input_rows={r['item_id']:r for r in csv.DictReader(f)}
    with (HERE/'input-example-text-scope.csv').open(encoding='utf-8',newline='') as f:input_scope={r['path']:r for r in csv.DictReader(f)}
    path='docs/user-input-adapters.md';assert input_scope[path]['status']=='fully-read-public-guide' and input_scope[path]['sha256']==hashed[path]['sha256']
    assert len(prior_input())==75 and len(source_lines(path))==108
    for number,item in prior_input().items():
        assert input_rows[item]['english']==expected[(path,number)][2] and input_rows[item]['english_location'].startswith(f'{path}:{number}:')
    # Bounded privacy mechanism checked with invented noncredential/nonidentifying fixtures only.
    fixtures=[('home-absolute',chr(67)+':/'+ 'Users/'+'EXAMPLE/'+'file'),('local-host','local'+'host'),('private-ip','192'+'.168'+'.1'+'.1'),('credential-shape','sk-'+'A'*32),('url-userinfo','https://'+'EXAMPLE:EXAMPLE@'+'example.invalid/'),('workspace-absolute',chr(67)+':/'+ 'AI Projects/'+'EXAMPLE'),('credential-assignment','TOKEN='+ 'INVENTED_ONLY')]
    for category,sample in fixtures:
        sanitized,marks=redact(sample);assert marks and any(category in r['kinds'] for r in marks) and sample not in sanitized,category
        assert all(set(r)=={'start','end','kinds','sha256','replacement'} for r in marks)
    assert not any('english' in k.lower() for k in COLUMNS),'This multilingual source export is not an English string count'
    print('PASS documentation-text:87main-pinned paths/8492lines;6142nonblank+2350blank;92scope/87SHA256+Git blobs;678prior-owned overlapping lines;199non-Latin-bearing lines;0redactions/4reviewed source example lines;complete text extraction only, no new runtime/caller/behavior proof')

if __name__=='__main__':main()
