"""Read-only operator-script source inventory verifier. Never imports/runs product scripts."""
import csv,hashlib,json,re,subprocess
from collections import Counter
from functools import cache
from pathlib import Path
ROOT=Path(__file__).resolve().parents[2]
HERE=Path(__file__).resolve().parent
REVISION="346d1e481757a55eb62fc066e43bbc7999b8e6dd"
FILES=["scripts/"+n for n in ["affected-tests.mjs","run-tests.mjs","stress-tests.mjs","test-timings.mjs","test-timing-reporter.mjs","ci-changes.mjs","check-dist-fresh.mjs","write-dev-build-info.mjs","dev-smoke.mjs","smoke-phase.mjs","windows-ci-defender.ps1","windows-ci-paths.ps1"]]
COLUMNS=["item_id","message_id","english","english_location","display_location","trigger","consumer_evidence","translation_boundary","evidence"]
SCOPE_COLUMNS=["source","status","coverage","sha256","revision","detail"]
DATA_TEXT_SHA256={
    'operator-scripts.csv':'98d2fe6a0bf02fd30bb73b6dd0f1f0e3c14a37e1103b1d37a428a58fb652f984',
    'operator-scripts-scope.csv':'a8a0d7fbeb35ef7c96e318e28c0f1940dbf8cb08505051b853227f76825a0c08',
}
@cache
def read(path):return (ROOT/path).read_text(encoding="utf-8")

@cache
def lex(source):
    """Lex JS strings/templates with nested ${...} intact, comments and regexes.

    Templates are recorded as the entire raw source payload. Nested literal
    tokens are also distinct source occurrences; no JavaScript is evaluated.
    """
    out=[];length=len(source)
    def string(i):
        opening=i;quote=source[i];i+=1
        while i<length:
            if source[i]=="\\":i+=2
            elif quote=="`" and source.startswith("${",i):i=code(i+2,True)
            elif source[i]==quote:
                out.append((opening,i+1,"template" if quote=="`" else "string",source[opening+1:i]));return i+1
            else:i+=1
        raise AssertionError((opening,"unterminated JS string/template"))
    def regex(i):
        opening=i;i+=1;inside=False
        while i<length:
            if source[i]=="\\":i+=2;continue
            if source[i]=="[":inside=True
            elif source[i]=="]":inside=False
            elif source[i]=="/" and not inside:
                i+=1
                while i<length and source[i].isalpha():i+=1
                out.append((opening,i,"regex",source[opening:i]));return i
            elif source[i]=="\n":return opening+1
            i+=1
        return opening+1
    def code(i,expression=False):
        depth=1 if expression else 0;previous=""
        while i<length:
            char=source[i]
            if char.isspace():i+=1;continue
            if source.startswith("//",i):
                end=source.find("\n",i);end=length if end<0 else end;out.append((i,end,"comment",source[i:end]));i=end;continue
            if source.startswith("/*",i):
                end=source.find("*/",i+2);assert end>=0;end+=2;out.append((i,end,"comment",source[i:end]));i=end;continue
            if char in "\"'`":i=string(i);previous="literal";continue
            if char=="/" and (previous in ("","(","=",":","[",",","!","?","{",";","|","&",">","return","throw","case","=>")):
                end=regex(i)
                if end>i+1:i=end;previous="literal";continue
            if char.isalpha() or char in "_$":
                end=i+1
                while end<length and (source[end].isalnum() or source[end] in "_$"):end+=1
                previous=source[i:end];i=end;continue
            if expression:
                if char=="{":depth+=1
                elif char=="}":
                    depth-=1
                    if depth==0:return i+1
            previous=char;i+=1
        assert not expression,"Unterminated template expression"
        return i
    code(0)
    return sorted(out)




def ps_lex(source):
    result=[];i=0
    while i<len(source):
        if source[i]=="#":
            end=source.find("\n",i);i=len(source) if end<0 else end;continue
        if source[i] not in "\"'":i+=1;continue
        start=i;quote=source[i];i+=1
        while i<len(source):
            if quote=='"' and source[i]=='`':i+=2;continue
            if source[i]==quote:
                if i+1<len(source) and source[i+1]==quote:i+=2;continue
                result.append((start,i+1,"powershell-expandable" if quote=='"' else "powershell-literal",source[start+1:i]));i+=1;break
            i+=1
        else:raise AssertionError((start,"unterminated PowerShell string"))
    return result

@cache
def tokens(path):
    source=read(path)
    found=ps_lex(source) if path.endswith('.ps1') else lex(source)
    return [(a,b,k,t,source.count("\n",0,a)+1,a-source.rfind("\n",0,a)-1) for a,b,k,t in found if k not in ('comment','regex') and t]

def candidate_paths():
    names=subprocess.run(['git','ls-tree','-r','--name-only',REVISION],cwd=ROOT,check=True,capture_output=True,text=True).stdout.splitlines()
    return sorted(p for p in names if (p.startswith('scripts/') and p.count('/')==1 or '/' not in p) and Path(p).suffix in {'.mjs','.ps1','.sh'} and '.test.' not in p)

def table(name,columns):
    with (HERE/name).open(encoding='utf-8',newline='') as f:
        reader=csv.DictReader(f);assert reader.fieldnames==columns;return list(reader)

def main():
    # Universal-newline text hashes also protect reviewed classifications and
    # conditions without depending on Git's platform line-ending conversion.
    for name,digest in DATA_TEXT_SHA256.items():
        assert hashlib.sha256((HERE/name).read_text(encoding='utf-8').encode()).hexdigest()==digest,name
    rows=table('operator-scripts.csv',COLUMNS);scope=table('operator-scripts-scope.csv',SCOPE_COLUMNS)
    assert len({r['item_id'] for r in rows})==len(rows)
    assert len({r['message_id'] for r in rows})==len(rows)
    hashes=0
    for r in scope:
        assert r['revision']==REVISION
        if not r['sha256']:continue
        data=(ROOT/r['source']).read_bytes();assert hashlib.sha256(data).hexdigest()==r['sha256'],r['source']
        committed=subprocess.run(['git','show',REVISION+':'+r['source']],cwd=ROOT,check=True,capture_output=True).stdout
        assert committed==data,r['source'];hashes+=1
    expected={(p,a,b):t for p in FILES for a,b,k,t,line,col in tokens(p)}
    found={};boundaries=0
    for r in rows:
        assert all(r[k] for k in COLUMNS if k!='english'),r['item_id']
        a=json.loads(re.search(r'anchor=(\{[^\n]+\})',r['evidence'])[1]);p=a['path'];source=read(p)
        if r['english']:
            key=(p,a['start'],a['end']);assert key not in found;found[key]=r['english']
            token=next((t for t in tokens(p) if t[:2]==(a['start'],a['end'])),None)
            assert token and token[3]==r['english'],r['item_id']
            assert r['english_location']==p+':'+str(token[4])
        else:
            boundaries+=1;assert a['expression'] in source.splitlines()[a['line']-1],r['item_id']
            assert r['english_location']==p+':'+str(a['line'])
        for ref in re.finditer(r'((?:scripts/|packages/|\.github/)[A-Za-z0-9_./-]+|package\.json|dev-build\.sh):(\d+)'," ".join(r.values())):
            assert 0<int(ref[2])<=len(read(ref[1]).splitlines()),(r['item_id'],ref[0])
    assert found==expected,(set(expected)-set(found),set(found)-set(expected))
    assert (len(rows),len(found),boundaries,len(scope),hashes)==(500,467,33,127,125)
    assert len({r['source'] for r in scope})==len(scope)
    categories=Counter(r['message_id'].rsplit('.',1)[0] for r in rows)
    assert categories=={'operator.script.operator-fixed-text':98,'operator.script.operator-output-format':8,'operator.script.protected-or-excluded-literal':361,'operator.script.dynamic-boundary':33}
    assert {r['source'] for r in scope if r['status']=='fully-read-operator-unit'}==set(FILES)
    assert sum(len(read(p).splitlines()) for p in FILES)==1284
    candidates=candidate_paths();assert len(candidates)==81
    assert {r['source'] for r in scope if r['status'] in {'fully-read-operator-unit','pending-root-operator-script','already-covered-elsewhere'}}==set(candidates)
    assert len([r for r in scope if r['status']=='pending-root-operator-script'])==68
    assert len([r for r in scope if r['status']=='already-covered-elsewhere'])==1
    assert len([r for r in scope if r['status']=='excluded-test-body'])==38
    assert 'error.message' in read('scripts/run-tests.mjs').splitlines()[251]
    assert 'result.stderr.trim() ||' in read('scripts/affected-tests.mjs').splitlines()[124]
    assert 'result.error || result.status !== 0' in read('scripts/dev-smoke.mjs').splitlines()[40]
    assert 'throw new Error("dev-build: Jouzu RPC smoke returned invalid output")' in read('scripts/dev-smoke.mjs').splitlines()[48]
    assert 'throw new Error("dev-build: Jouzu RPC smoke returned invalid output")' in read('scripts/dev-smoke.mjs').splitlines()[57]
    assert '>> "$GITHUB_OUTPUT"' in read('.github/workflows/ci.yml').splitlines()[69]
    assert '"scanned" -or -not $defender.RealTimeProtectionEnabled' in read('scripts/windows-ci-defender.ps1').splitlines()[80]
    assert '$record.added).Count -eq 0' in read('scripts/windows-ci-defender.ps1').splitlines()[51]
    assert 'report("FAIL");' in read('scripts/smoke-phase.mjs').splitlines()[12]
    assert 'throw error;' in read('scripts/smoke-phase.mjs').splitlines()[13]
    print(json.dumps({'rows':len(rows),'exact_source_occurrences':len(found),'dynamic_boundaries':boundaries,'scope_rows':len(scope),'source_hashes':hashes,'fully_read_files':12,'fully_read_lines':1284,'pending_candidates':68,'already_covered':1,'source_execution':False},sort_keys=True))

if __name__=='__main__':main()
