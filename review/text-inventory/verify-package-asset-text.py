"""Read-only package metadata and launcher asset source export; --write generates.

No manifest command, build backend, CSS, SVG, URL, native window or product runs.
"""
import argparse
import csv
import hashlib
import io
import json
from pathlib import Path
import subprocess
import tomllib

HERE = Path(__file__).resolve().parent
ROOT = HERE.parents[1]
PIN = '346d1e481757a55eb62fc066e43bbc7999b8e6dd'
FILES = {'package.json': 69, 'packages/cli/package.json': 110,
         'packages/session-ui/package.json': 38,
         'packages/cli/camoufox-runtime/package.json': 26,
         'apps/launcher/package.json': 40, 'apps/launcher/src-tauri/Cargo.toml': 33,
         'apps/launcher/src-tauri/tauri.conf.json': 57,
         'python/jouzu/pyproject.toml': 41,
         'apps/launcher/src/assets/jouzu.svg': 27,
         'apps/launcher/src/styles.css': 50,
         'packages/cli/release-extensions.json': 153}
SUPPORT = {'apps/launcher/src/App.tsx': [(16, 16), (242, 242)],
           'apps/launcher/src-tauri/src/main.rs': [(405, 419)]}
FIELDS = ['item_id', 'english', 'english_location', 'disposition',
          'display_location', 'trigger', 'translation_boundary']
LIMIT = ('Preserve package, classifier, brand, author, license, path, version and '
         'protocol identities. Source annotations and external metadata displays '
         'do not establish a first-party translated product message. Native '
         'packager/browser/OS/tool diagnostics remain separate producers.')


def git(*args):
    return subprocess.check_output(['git', *args], cwd=ROOT)


def csv_text(rows, fields):
    output = io.StringIO(newline='')
    writer = csv.DictWriter(output, fieldnames=fields, lineterminator='\n')
    writer.writeheader()
    writer.writerows(rows)
    return output.getvalue()


def generate():
    texts, scopes, lines = {}, [], []
    for path in [*FILES, *SUPPORT]:
        body = git('show', PIN + ':' + path)
        assert (ROOT / path).read_bytes() == body, path + ' differs from source pin'
        text = body.decode('utf8')
        texts[path] = text
        physical = text.splitlines()
        full = path in FILES
        if full:
            assert len(physical) == FILES[path], path
            lines.extend(dict(source_location=path + ':' + str(n), source_text=line,
                              interpretation='Exact source line, including blank/control/data/comment lines; runtime prose is separately qualified.')
                         for n, line in enumerate(physical, 1))
        scopes.append(dict(path=path, revision=PIN,
                           git_blob=git('rev-parse', PIN + ':' + path).decode().strip(),
                           sha256=hashlib.sha256(body).hexdigest(), lines=len(physical),
                           status='full-source-export' if full else 'bounded-consumer-anchor',
                           coverage='Complete package/config/asset source read; no imported tool/runtime closure.' if full else
                           json.dumps(SUPPORT[path]) + '; exact source anchors only, prior body ownership retained.'))
    assert len(lines) == 644
    cli = json.loads(texts['packages/cli/package.json'])
    ui = json.loads(texts['packages/session-ui/package.json'])
    browser = json.loads(texts['packages/cli/camoufox-runtime/package.json'])
    python = tomllib.loads(texts['python/jouzu/pyproject.toml'])['project']
    tauri_path = 'apps/launcher/src-tauri/tauri.conf.json'
    tauri = json.loads(texts[tauri_path])
    rows = []

    def add(path, line, value, disposition, sink, trigger):
        assert value in texts[path].splitlines()[line - 1], (path, line, value)
        rows.append(dict(zip(FIELDS, [f'PACKAGE-ASSET-{len(rows)+1:03}', value,
                                     path + ':' + str(line), disposition, sink, trigger, LIMIT])))

    metadata_sink = 'Source/package manifest inspection or an external package-metadata display'
    metadata_trigger = ('Reader opens the checked-in manifest, installed package metadata or an external tool explicitly renders its field. '
                        'No first-party runtime sentence renderer is established for this annotation; commands/backends/registry operations were not run.')
    for path, line, value in [
        ('packages/cli/package.json', 4, cli['description']),
        ('packages/session-ui/package.json', 5, ui['description']),
        ('packages/cli/camoufox-runtime/package.json', 5, browser['description']),
        ('python/jouzu/pyproject.toml', 4, python['description'])]:
        add(path, line, value, 'package-description-annotation', metadata_sink, metadata_trigger)
    for line, value in enumerate(python['classifiers'], 13):
        add('python/jouzu/pyproject.toml', line, value, 'protected-package-classifier', metadata_sink, metadata_trigger)
    add('packages/cli/package.json', 34, cli['author'], 'protected-author-identity', metadata_sink, metadata_trigger)
    add('python/jouzu/pyproject.toml', 9, python['authors'][0]['name'], 'protected-author-identity', metadata_sink, metadata_trigger)
    for line, value in [(3, tauri['productName']), (34, tauri['bundle']['publisher']),
                        (35, tauri['bundle']['copyright'])]:
        add(tauri_path, line, value, 'protected-product-or-publisher-metadata',
            'Config inspection or explicit external Tauri/packager metadata consumption',
            'Source contains this field; bundle.active is false in the checked-in config. No default generated installer or OS metadata display is inferred. Build/release overrides and external packaging are separate conditions.')
    add(tauri_path, 18, tauri['app']['windows'][0]['title'], 'configured-native-window-title',
        'Native window builder title input; source inspection',
        'main.rs405-417 reads the first configured window and calls WebviewWindowBuilder::from_config then build. Config create=false does not prevent this explicit build; decorations=false. Actual OS/window accessibility/title presentation is not executed or qualified here.')
    svg = 'apps/launcher/src/assets/jouzu.svg'
    assert 'aria-label="Jouzu"' in texts[svg].splitlines()[0]
    assert '<img src={jouzuIcon} alt=""' in texts['apps/launcher/src/App.tsx'].splitlines()[241]
    assert 'from "./assets/jouzu.svg"' in texts['apps/launcher/src/App.tsx'].splitlines()[15]
    add(svg, 1, 'Jouzu', 'protected-SVG-accessibility-annotation',
        'SVG source/standalone SVG accessibility metadata; imported image bytes',
        'SVG root has role=img and aria-label=Jouzu. App imports it as an image URL and renders an outer img with empty alt; this does not establish propagation of the internal SVG label into the page accessibility name. No text nodes or other caption attributes occur in this SVG.')
    assert len(rows) == 16
    outputs = {
        'package-asset-text.csv': csv_text(rows, FIELDS),
        'package-asset-lines.csv': csv_text(lines, ['source_location', 'source_text', 'interpretation']),
        'package-asset-text-scope.csv': csv_text(scopes, list(scopes[0])),
    }
    snapshot = dict(source_revision=PIN, full_sources=11, full_source_lines=644,
                    bounded_consumer_sources=2, annotation_rows=16,
                    package_descriptions=4, protected_classifiers=5,
                    protected_authors=2, configured_title=1,
                    protected_product_publisher_fields=3, SVG_annotation=1,
                    source_only_notes=[
                        'CSS has imports, source selectors, theme/style rules and comments, with no authored generated-content caption.',
                        'Release extension manifest values are exact package/version/provenance/tool/entry identifiers; no new prose sentence field.',
                        'Commands and build settings are source data; npm/Cargo/Hatch/Tauri/compiler/browser/native diagnostics remain external.',
                        'Complete local source export does not promote a package annotation or protected value to default UI prose.'],
                    artifact_sha256_utf8_lf={name: hashlib.sha256(value.encode('utf8')).hexdigest()
                                            for name, value in outputs.items()})
    outputs['package-asset-text-snapshot.json'] = json.dumps(snapshot, indent=2) + '\n'
    return outputs, snapshot


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--write', action='store_true')
    args = parser.parse_args()
    outputs, snapshot = generate()
    for name, expected in outputs.items():
        if args.write:
            (HERE / name).write_text(expected, encoding='utf8', newline='\n')
        else:
            assert (HERE / name).read_text(encoding='utf8') == expected, name + ' is stale'
    print(json.dumps({key: value for key, value in snapshot.items()
                      if key not in ('artifact_sha256_utf8_lf', 'source_only_notes')}, indent=2))


if __name__ == '__main__':
    main()
