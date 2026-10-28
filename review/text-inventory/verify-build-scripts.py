"""Read-only exact-source build/patch inventory verification; no product imports or transforms."""
import csv,hashlib,json,re,subprocess
from collections import Counter
from functools import cache
from pathlib import Path
ROOT=Path(__file__).resolve().parents[2]
HERE=Path(__file__).resolve().parent
REVISION="346d1e481757a55eb62fc066e43bbc7999b8e6dd"
COLUMNS=["item_id","message_id","english","english_location","display_location","trigger","consumer_evidence","translation_boundary","evidence"]
SCOPE_COLUMNS=["source","status","coverage","sha256","revision","detail"]
DATA_TEXT_SHA256={
    'build-scripts.csv':'68befe3a4f96d55edc573b5ad3098e94b9ff33a4c4fe0f852d884ee948773e85',
    'build-scripts-scope.csv':'5ad0d49a28d7f9a6df95c8405cb4327e21cdb09f4bfc4f558b7e000eceef2a19',
}
@cache
def read(path):return (ROOT/path).read_text(encoding="utf-8")
FILES=['scripts/apply-background-flow.mjs', 'scripts/background-flow-transform.mjs', 'scripts/background-resource-transform.mjs', 'scripts/background-widget-transform.mjs', 'scripts/apply-code-previews.mjs', 'scripts/code-previews-transform.mjs', 'scripts/apply-multiloop-wait-skill.mjs', 'scripts/multiloop-flow-transform.mjs', 'scripts/apply-vcc-goals.mjs', 'scripts/vcc-goals-transform.mjs', 'scripts/apply-task-flow.mjs', 'scripts/task-flow-transform.mjs', 'scripts/apply-pi-flow-control.mjs', 'scripts/pi-flow-control-transform.mjs', 'scripts/apply-pi-provider-receipts.mjs', 'scripts/pi-provider-receipts-transform.mjs', 'scripts/apply-pi-path-utils.mjs', 'scripts/pi-path-utils-transform.mjs']

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
            elif quote=="`" and source.startswith("${",i):
                start=i;i=code(i+2,True);out.append((start,i,"interpolation",source[start:i]))
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


@cache
def top_tokens(path):
    source=read(path)
    return [(a,b,k,t,source.count('\n',0,a)+1) for a,b,k,t in lex(source) if k in ('string','template') and t]


def decode_static(raw,source_start):
    """Decode fixed JS escapes with an exact character map; never evaluate ${}.

    A generated-source projection is only used to recognize nested literal
    boundaries. CSV English always retains the original raw source substring.
    Live interpolation stays unresolved, including its original source syntax.
    """
    chars=[];mapping=[];i=0
    simple={'n':'\n','r':'\r','t':'\t','b':'\b','f':'\f','v':'\v','0':'\0'}
    while i<len(raw):
        start=i
        if raw[i]!='\\':
            value=raw[i];i+=1
        else:
            i+=1;assert i<len(raw)
            c=raw[i];i+=1
            if c=='\n':continue
            if c=='\r':
                if i<len(raw) and raw[i]=='\n':i+=1
                continue
            if c=='u':
                if raw[i:i+1]=='{':
                    end=raw.index('}',i+1);value=chr(int(raw[i+1:end],16));i=end+1
                else:value=chr(int(raw[i:i+4],16));i+=4
            elif c=='x':value=chr(int(raw[i:i+2],16));i+=2
            else:value=simple.get(c,c)
        chars.append(value);mapping.append((source_start+start,source_start+i))
    return ''.join(chars),mapping


def is_code_fragment(text):
    # Includes expressions and partial source anchors. Plain prompts/Markdown,
    # errors, paths and imports without nested quotes need no second-level pass.
    return not text.startswith('## ') and bool(re.search(r'["\'`]',text) and re.search(r'[();={}:,]',text))


@cache
def generated_tokens(path):
    source=read(path);result=[];failures=[]
    for pa,pb,pk,raw,line in top_tokens(path):
        projection,mapping=decode_static(raw,pa+1)
        if not is_code_fragment(projection):continue
        live=[(a,b) for a,b,k,t in lex(source) if k=='interpolation' and pa<a<b<pb]
        try:found=lex(projection)
        except AssertionError as error:
            failures.append((line,str(error)));continue
        for ga,gb,gk,text in found:
            if gk not in ('string','template') or not text:continue
            a=mapping[ga][1];b=mapping[gb-1][0]
            if any(x<=a<y for x,y in live):continue
            assert a<=b
            result.append((a,b,gk,source[a:b],source.count('\n',0,a)+1,pa,pb,ga,gb,text))
    return result,failures


def csv_table(name,columns):
    with (HERE/name).open(encoding='utf-8',newline='') as stream:
        reader=csv.DictReader(stream);assert reader.fieldnames==columns;return list(reader)


def main():
    # Pin reviewed dispositions/conditions as canonical text, tolerating Git's
    # platform line-ending conversion while retaining exact source payloads.
    for name,digest in DATA_TEXT_SHA256.items():
        assert hashlib.sha256((HERE/name).read_text(encoding='utf-8').encode()).hexdigest()==digest,name
    rows=csv_table('build-scripts.csv',COLUMNS);scope=csv_table('build-scripts-scope.csv',SCOPE_COLUMNS)
    assert len({r['item_id'] for r in rows})==len(rows)
    assert len({r['message_id'] for r in rows})==len(rows)
    assert len({r['source'] for r in scope})==len(scope)
    hashes=0
    for row in scope:
        assert row['revision']==REVISION
        if not row['sha256']:continue
        path=row['source'];data=(ROOT/path).read_bytes()
        assert hashlib.sha256(data).hexdigest()==row['sha256'],path
        committed=subprocess.run(['git','show',REVISION+':'+path],cwd=ROOT,check=True,capture_output=True).stdout
        assert data==committed,path;hashes+=1
    expected={};top_count=nested_count=0
    for path in FILES:
        for a,b,k,text,line in top_tokens(path):
            expected[('top',path,a,b)]=(text,line);top_count+=1
        nested,failures=generated_tokens(path);assert not failures,(path,failures)
        for a,b,k,text,line,pa,pb,ga,gb,projection in nested:
            key=('generated',path,a,b,pa,pb,ga,gb)
            assert key not in expected,key
            expected[key]=(text,line);nested_count+=1
    actual={};boundaries=[]
    for row in rows:
        assert all(row[k] for k in COLUMNS if k!='english'),row['item_id']
        anchor=json.loads(re.search(r'anchor=(\{[^\n]+\})',row['evidence'])[1]);path=anchor['path'];level=anchor['level']
        if level=='dynamic':
            boundaries.append(anchor)
            assert not row['english'] and anchor['expression'] in read(path).splitlines()[anchor['line']-1],row['item_id']
            assert row['english_location']==path+':'+str(anchor['line'])
        else:
            key=(level,path,anchor['start'],anchor['end'])
            if level=='generated':key+=(anchor['parent_start'],anchor['parent_end'],anchor['generated_start'],anchor['generated_end'])
            assert key not in actual,key
            actual[key]=(row['english'],int(row['english_location'].rsplit(':',1)[1]))
            assert row['english_location'].startswith(path+':')
        for ref in re.finditer(r'((?:scripts/|packages/|upstream/)[A-Za-z0-9_./-]+|package\.json):(\d+)'," ".join(row.values())):
            assert 0<int(ref[2])<=len(read(ref[1]).splitlines()),(row['item_id'],ref[0])
    assert expected==actual,(set(expected)-set(actual),set(actual)-set(expected))
    assert (len(rows),top_count,nested_count,len(boundaries),len(scope),hashes)==(1136,844,268,24,149,147)
    assert {r['source'] for r in scope if r['status']=='fully-read-build-unit'}==set(FILES)
    assert len(FILES)==18 and sum(len(read(p).splitlines()) for p in FILES)==2189
    names=subprocess.run(['git','ls-tree','-r','--name-only',REVISION],cwd=ROOT,check=True,capture_output=True,text=True).stdout.splitlines()
    candidates={p for p in names if (p.startswith('scripts/') and p.count('/')==1 or '/' not in p) and Path(p).suffix in {'.mjs','.ps1','.sh'} and '.test.' not in p}
    full={r['source'] for r in scope if r['status']=='fully-read-build-unit'}
    prior={r['source'] for r in scope if r['status']=='already-covered-elsewhere'}
    pending={r['source'] for r in scope if r['status']=='pending-root-build-operator-script'}
    assert (len(candidates),len(full),len(prior),len(pending))==(81,18,13,50)
    assert full|prior|pending==candidates and not(full&prior or full&pending or prior&pending)
    assert len([r for r in scope if r['status']=='excluded-test-body'])==38
    assert len([r for r in scope if r['status']=='copied-or-delegated-producer-pending'])==13
    assert 'throw new Error("Pi flow manifest does not match the pinned deviation")' in read('scripts/apply-pi-flow-control.mjs')
    assert 'if (digest === hashes.after) continue;' in read('scripts/apply-background-flow.mjs')
    assert 'if (checkOnly || (digest !== hashes.before && !upgradeWidget && !upgradeResources))' in read('scripts/apply-background-flow.mjs')
    assert 'sha(changed) !== hashes.after' in read('scripts/apply-background-flow.mjs')
    assert 'stopped.stderr || "Windows process-tree termination failed."' in read('scripts/background-flow-transform.mjs')
    assert 'reportProblem: (where, message)' in read('scripts/background-flow-transform.mjs')
    families=['background-flow','code-previews','multiloop-wait-skill','vcc-goals','task-flow','pi-flow-control','pi-provider-receipts','pi-path-utils']
    pin=json.loads(read('upstream/pi.lock.json'));npm=json.loads(read('package-lock.json'))['packages'];locks={}
    for family in families:
        path='upstream/'+family+'/patch.lock.json';lock=json.loads(read(path));locks[family]=lock
        records=[r for r in pin['deviations'] if r['path']==path]
        assert len(records)==1 and records[0]['sha256']==hashlib.sha256((ROOT/path).read_bytes()).hexdigest(),path
        assert lock['version'] in {e.get('version') for p,e in npm.items() if p.endswith('node_modules/'+lock['package'])},path
    copied=[]
    bg=locks['background-flow']
    for suffix,key in [('runtime.ts','runtime'),('store.ts','store'),('resource-edits.json','resourceEdits')]:
        copied.append(('upstream/background-flow/'+suffix,bg[key]))
    copied.extend(('upstream/background-flow/resources/'+name,digest) for name,digest in bg['helpers'].items())
    for family in ['multiloop-wait-skill','vcc-goals','task-flow']:
        copied.append(('upstream/'+family+'/runtime.ts',locks[family]['runtime']))
    copied.append(('upstream/pi-flow-control/types.d.ts',locks['pi-flow-control']['types']))
    assert len(copied)==13
    for path,digest in copied:assert hashlib.sha256((ROOT/path).read_bytes()).hexdigest()==digest,path
    print(json.dumps({'rows':len(rows),'top_level_literals':top_count,'nested_generated_literals':nested_count,'dynamic_boundaries':len(boundaries),'scope_rows':len(scope),'source_hashes':hashes,'full_bodies':18,'full_body_lines':2189,'prior_bodies':13,'remaining_candidates':50,'pinned_manifests':8,'copied_source_hash_checks':13,'source_execution':False,'transform_execution':False},sort_keys=True))


if __name__=='__main__':main()
