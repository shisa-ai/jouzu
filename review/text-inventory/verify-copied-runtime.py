"""Read-only copied-runtime wording inventory; never imports/runs producer code."""
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
    'copied-runtime.csv':'2787f1dfc42c4543a4709d8df807e78a70ad60d938adf2f76989e85ed5c0b6df',
    'copied-runtime-scope.csv':'b85c992efdfc737d2d4a62ce691ddceb59f282bc41a90b34c9b75005147e7004',
}
@cache
def read(path):return (ROOT/path).read_text(encoding="utf-8")
FILES=['upstream/background-flow/runtime.ts', 'upstream/background-flow/store.ts', 'upstream/background-flow/resource-edits.json', 'upstream/multiloop-wait-skill/runtime.ts', 'upstream/task-flow/runtime.ts', 'upstream/vcc-goals/runtime.ts', 'upstream/pi-flow-control/types.d.ts', 'upstream/background-flow/resources/coalesce.ts', 'upstream/background-flow/resources/jouzu-resources.ts', 'upstream/background-flow/resources/log-tail.ts', 'upstream/background-flow/resources/log-writer.ts', 'upstream/background-flow/resources/output-matcher.ts', 'upstream/background-flow/resources/probes.ts']
RESOURCE="upstream/background-flow/resource-edits.json"
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


@cache
def tokens(path):
    source=read(path)
    return [(a,b,k,text,source.count('\n',0,a)+1) for a,b,k,text in lex(source) if k in ('string','template','regex') and text]


@cache
def json_roles():
    data=json.loads(read(RESOURCE));expected=[]
    for target,edits in data.items():
        expected.append((target,'target',target,-1))
        for index,edit in enumerate(edits):
            assert list(edit)==['before','after']
            for role,value in edit.items():
                expected.extend([(role,'field-key',target,index),(value,role,target,index)])
    found=tokens(RESOURCE);assert len(found)==len(expected)
    result={}
    for token,entry in zip(found,expected):
        a,b,k,raw,line=token;decoded,mapping=decode_static(raw,a+1)
        assert decoded==entry[0],(line,entry)
        result[(a,b)]=(entry[1],entry[2],entry[3])
    return result


@cache
def generated_tokens():
    source=read(RESOURCE);result=[];excluded=[]
    for pa,pb,pk,raw,parent_line in tokens(RESOURCE):
        role,target,index=json_roles()[(pa,pb)]
        if role not in ('before','after'):continue
        # Both completion-message edits are an intentionally partial tail of a
        # template literal. They contain only punctuation and dynamic values;
        # retain the exact before/after recipes as parent rows, not invented JS.
        if parent_line in (184,185):
            excluded.append((parent_line,role,target,index));continue
        projection,mapping=decode_static(raw,pa+1)
        for ga,gb,gk,text in lex(projection):
            if gk not in ('string','template','regex') or not text:continue
            if gk=='regex':a=mapping[ga][0];b=mapping[gb-1][1]
            else:a=mapping[ga][1];b=mapping[gb-1][0]
            result.append((a,b,gk,source[a:b],source.count('\n',0,a)+1,pa,pb,ga,gb,text,role,target,index))
    return result,excluded


def table(name,columns):
    with (HERE/name).open(encoding='utf-8',newline='') as stream:
        reader=csv.DictReader(stream);assert reader.fieldnames==columns;return list(reader)


def main():
    # Canonical text digests protect reviewed dispositions and delivery guards
    # while tolerating Git's platform newline conversion of the CSV artifacts.
    for name,digest in DATA_TEXT_SHA256.items():
        assert hashlib.sha256((HERE/name).read_text(encoding='utf-8').encode()).hexdigest()==digest,name
    rows=table('copied-runtime.csv',COLUMNS);scope=table('copied-runtime-scope.csv',SCOPE_COLUMNS)
    assert len({r['item_id'] for r in rows})==len(rows)
    assert len({r['message_id'] for r in rows})==len(rows)
    assert len({r['source'] for r in scope})==len(scope)
    hashes=0
    for row in scope:
        assert row['revision']==REVISION
        if not row['sha256']:continue
        p=row['source'];data=(ROOT/p).read_bytes()
        assert hashlib.sha256(data).hexdigest()==row['sha256'],p
        original=subprocess.run(['git','show',REVISION+':'+p],cwd=ROOT,check=True,capture_output=True).stdout
        assert data==original,p;hashes+=1
    expected={};primary=nested=0
    for p in FILES:
        for a,b,k,text,line in tokens(p):expected[('primary',p,a,b)]=(text,line);primary+=1
    generated,excluded=generated_tokens()
    for a,b,k,text,line,pa,pb,ga,gb,projection,role,target,index in generated:
        key=('generated',RESOURCE,a,b,pa,pb,ga,gb);assert key not in expected
        expected[key]=(text,line);nested+=1
    assert [(a,b) for a,b,c,d in excluded]==[(184,'before'),(185,'after')]
    for line,role,target,index in excluded:
        token=next(t for t in tokens(RESOURCE) if t[4]==line and json_roles()[(t[0],t[1])][0]==role)
        decoded,_=decode_static(token[3],token[0]+1);old=None
        while old!=decoded:old=decoded;decoded=re.sub(r'\$\{[^{}]*\}','',decoded)
        assert not re.search('[A-Za-z]',decoded),(line,decoded)
    actual={};boundaries=0
    for row in rows:
        assert all(row[k] for k in COLUMNS if k!='english'),row['item_id']
        a=json.loads(re.search(r'anchor=(\{[^\n]+\})',row['evidence'])[1]);p=a['path'];level=a['level']
        if level=='dynamic':
            assert not row['english'] and a['expression'] in read(p).splitlines()[a['line']-1],row['item_id']
            assert row['english_location']==p+':'+str(a['line']);boundaries+=1
        else:
            key=(level,p,a['start'],a['end'])
            if level=='generated':key+=(a['parent_start'],a['parent_end'],a['generated_start'],a['generated_end'])
            assert key not in actual,key
            actual[key]=(row['english'],int(row['english_location'].rsplit(':',1)[1]));assert row['english_location'].startswith(p+':')
        for ref in re.finditer(r'((?:scripts/|packages/|upstream/)[A-Za-z0-9_./-]+|package\.json):(\d+)'," ".join(row.values())):
            assert 0<int(ref[2])<=len(read(ref[1]).splitlines()),(row['item_id'],ref[0])
    assert actual==expected,(set(expected)-set(actual),set(actual)-set(expected))
    assert (len(rows),primary,nested,boundaries,len(scope),hashes)==(686,507,157,22,101,97)
    roles=Counter(role for role,target,index in json_roles().values())
    assert roles=={'target':9,'field-key':84,'before':42,'after':42}
    full={r['source'] for r in scope if r['status'] in {'full-copied-producer','full-declaration-only','full-no-fixed-wording'}}
    assert full==set(FILES) and len(FILES)==13
    assert sum(len(read(p).splitlines()) for p in FILES)==2208
    assert not tokens('upstream/background-flow/resources/coalesce.ts')
    assert next(r for r in scope if r['source']=='upstream/pi-flow-control/types.d.ts')['status']=='full-declaration-only'
    assert len([r for r in scope if r['status']=='pending-root-script'])==50
    pin=json.loads(read('upstream/pi.lock.json'));npm=json.loads(read('package-lock.json'))['packages']
    families=['background-flow','multiloop-wait-skill','task-flow','vcc-goals','pi-flow-control'];locks={}
    for family in families:
        p='upstream/'+family+'/patch.lock.json';lock=json.loads(read(p));locks[family]=lock
        records=[r for r in pin['deviations'] if r['path']==p]
        assert len(records)==1 and records[0]['sha256']==hashlib.sha256((ROOT/p).read_bytes()).hexdigest(),p
        assert lock['version'] in {entry.get('version') for path,entry in npm.items() if path.endswith('node_modules/'+lock['package'])}
    copies=[];bg=locks['background-flow']
    for suffix,key in [('runtime.ts','runtime'),('store.ts','store'),('resource-edits.json','resourceEdits')]:copies.append(('upstream/background-flow/'+suffix,bg[key]))
    copies.extend(('upstream/background-flow/resources/'+name,digest) for name,digest in bg['helpers'].items())
    for family in ['multiloop-wait-skill','task-flow','vcc-goals']:copies.append(('upstream/'+family+'/runtime.ts',locks[family]['runtime']))
    copies.append(('upstream/pi-flow-control/types.d.ts',locks['pi-flow-control']['types']))
    assert {p for p,digest in copies}==set(FILES)
    for p,digest in copies:assert hashlib.sha256((ROOT/p).read_bytes()).hexdigest()==digest,p
    assert 'strict && tail.error' in read('upstream/background-flow/resources/log-tail.ts')
    assert 'activeCtx?.ui.notify?.(error.message' in json.loads(read(RESOURCE))['extensions/background-tasks.ts'][4]['after']
    assert 'if (lastProblem === key) return;' in read('upstream/background-flow/store.ts')
    assert 'task.reason ??' in read('packages/cli/src/flow-control/flow-status-report.ts')
    print(json.dumps({'rows':len(rows),'primary_literals_and_regexes':primary,'nested_json_code_literals':nested,'dynamic_boundaries':boundaries,'scope_rows':len(scope),'source_hashes':hashes,'full_bodies':13,'full_body_lines':2208,'root_scripts_pending':50,'manifest_pins':5,'copied_source_pins':13,'partial_template_tails':2,'producer_or_state_execution':False},sort_keys=True))


if __name__=='__main__':main()
