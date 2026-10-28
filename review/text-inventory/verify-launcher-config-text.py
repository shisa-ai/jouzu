"""Read-only launcher build/test configuration token and output-boundary check.

No configuration, compiler, browser, Rust build script or package code executes.
--write writes only this unit's CSV artifacts. Source authority stays BASE346.
"""
import argparse
import csv
import hashlib
import io
from pathlib import Path
import subprocess

HERE=Path(__file__).resolve().parent
ROOT=HERE.parents[1]
PIN='346d1e481757a55eb62fc066e43bbc7999b8e6dd'
A='apps/launcher/'
SPECS={
 A+'playwright.config.ts':(7,[(1,"'@playwright/test'",'Module specifier'),(5,"'./e2e'",'Test-directory path')]),
 A+'vite.config.ts':(11,[(1,'"vite"','Module specifier'),(2,'"@vitejs/plugin-react"','Module specifier'),
     (3,'"@tailwindcss/vite"','Module specifier'),(5,'"@"','Resolution alias key'),(5,'"./src"','URL path'),
     (5,r'/^\/([A-Za-z]:)/','Path-normalization regular expression'),(5,'"$1"','Capture replacement'),(9,"'::'",'Network bind address')]),
 A+'vitest.config.ts':(6,[(1,"'vitest/config'",'Module specifier'),(2,"'@vitejs/plugin-react'",'Module specifier'),
     (5,"'src/**/*.test.ts'",'Test-discovery glob'),(5,"'src/**/*.test.tsx'",'Test-discovery glob')]),
 A+'src-tauri/build.rs':(4,[(2,'"cargo:rerun-if-changed=../../../packaging/launcher/control.mjs"','Cargo build-script protocol directive')]),
 A+'src/vite-env.d.ts':(1,[(1,'"vite/client"','Type-reference directive')])}
FIELDS=['item_id','source_text','source_location','disposition','trigger','boundary']
SF=['path','revision','git_blob','sha256','lines','status','coverage']


def csv_text(fields,rows):
    f=io.StringIO(newline='');w=csv.DictWriter(f,fieldnames=fields,lineterminator='\n');w.writeheader();w.writerows(rows);return f.getvalue()


def generate():
    rows=[];scope=[]
    for p,(count,specs) in SPECS.items():
        raw=subprocess.check_output(['git','show',PIN+':'+p],cwd=ROOT)
        assert (ROOT/p).read_bytes()==raw,p+' differs from immutable source'
        lines=raw.decode('utf8').splitlines();assert len(lines)==count
        blob=subprocess.check_output(['git','rev-parse',PIN+':'+p],cwd=ROOT).decode().strip()
        scope.append(dict(zip(SF,[p,PIN,blob,hashlib.sha256(raw).hexdigest(),count,'full-source',
            'Entire configuration/build-script/declaration source; all lexical text tokens below. No authored natural-language runtime message. Imported dependencies and compiler diagnostics not closed.'])))
        for n,value,kind in specs:
            assert value in lines[n-1],(p,n,value)
            trigger=('Cargo runs this crate build script: println emits directive to build-script stdout, Cargo consumes it as rebuild-dependency instruction. Build-script logs or verbose compiler output may expose exact technical line.'
                     if p.endswith('.rs') else
                     'Build/type/test tool reads this configuration or declaration. Value controls module/path/alias/bind/test selection; may be echoed in native diagnostics or source inspection, with no independent natural-language display claim.')
            rows.append(dict(zip(FIELDS,[f'LAUNCHER-CONFIG-{len(rows)+1:03}',value,p+':'+str(n),kind+'; protected technical token',trigger,
                'Keep module names, paths, regex syntax/captures, globs, bind address and Cargo/type protocol exact. Comments are source-only explanation, not runtime copy. No audited configuration or compiler executes.'])))
    rows.append(dict(zip(FIELDS,['LAUNCHER-CONFIG-017','',A+'vite.config.ts:4','External tool diagnostics boundary',
        'Module/plugin resolution, test selection/execution, configuration validation, port binding, tauri_build::build or native compiler can emit errors/progress; exact words depend on installed toolchain and environment.',
        'Vite/React/Tailwind/Vitest/Playwright/TypeScript/Tauri/Cargo/Rust/native OS diagnostics are separate external producers. These five small source bodies do not establish dependency/native output closure.'])))
    assert len(rows)==17 and sum(v[0] for v in SPECS.values())==29
    return {'launcher-config-text.csv':csv_text(FIELDS,rows),'launcher-config-text-scope.csv':csv_text(SF,scope)}


def main():
    parser=argparse.ArgumentParser(description=__doc__);parser.add_argument('--write',action='store_true');options=parser.parse_args()
    expected=generate()
    if options.write:
        for p,v in expected.items():(HERE/p).write_text(v,encoding='utf8',newline='\n')
    for p,v in expected.items():assert (HERE/p).read_text(encoding='utf8')==v,p+' changed or stale'
    print('PASS launcher-config-text: five full sources/29 lines; sixteen protected technical tokens/one external boundary; no product/compiler execution')


if __name__=='__main__':main()
