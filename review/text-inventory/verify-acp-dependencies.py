"""Read-only ACP SDK/Zod diagnostic inventory verification; never imports SDK code."""
import argparse
import base64
import csv
import hashlib
import json
import re
import subprocess
import tarfile
from collections import Counter
from functools import cache
from pathlib import Path

ROOT=Path(__file__).resolve().parents[2]
HERE=Path(__file__).resolve().parent
REVISION="346d1e481757a55eb62fc066e43bbc7999b8e6dd"
SDK="npm:@agentclientprotocol/sdk@2.0.2/"
ZOD="npm:zod@4.6.7/"
SDK_ROOT=ROOT/"node_modules/@agentclientprotocol/sdk"
ZOD_ROOT=ROOT/"test-results/acp-dependency-sources/zod-4.6.7"
COLUMNS=["item_id","message_id","english","english_location","display_location","trigger","consumer_evidence","translation_boundary","evidence"]
SCOPE_COLUMNS=["source","status","coverage","sha256","revision","detail"]
# Canonical UTF-8 text digests protect the reviewed dispositions/conditions too;
# universal newline decoding permits Git's platform line-ending conversion.
DATA_TEXT_SHA256={
    "acp-dependencies.csv":"caf7ef7f13775e4da75137e990ebc350d7b9d26b384d12ca9591bc3a62064ae8",
    "acp-dependencies-scope.csv":"1843b2f11fbcc06729a2846aff8cbbaf723cee9300f295d46034c40b019d7923",
}


def local(path):
    return SDK_ROOT/path[len(SDK):] if path.startswith(SDK) else ZOD_ROOT/path[len(ZOD):] if path.startswith(ZOD) else ROOT/path


@cache
def read(path):return local(path).read_text(encoding="utf-8")


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


@cache
def strings(path):
    source=read(path)
    return [(a,b,kind,raw,source.count("\n",0,a)+1,a-source.rfind("\n",0,a)-1)
            for a,b,kind,raw in lex(source) if kind in ("string","template")]


@cache
def masked(path):
    source=read(path);data=list(source)
    # Outer templates cover nested literals/comments; blanks preserve line/offset.
    for a,b,_,_ in lex(source):
        for n in range(a,b):
            if data[n]!="\n":data[n]=" "
    return "".join(data)


def sdk_js():return sorted(SDK+p.relative_to(SDK_ROOT).as_posix() for p in (SDK_ROOT/"dist").rglob("*.js"))


def schema_definitions(path):
    source=read(path);code=masked(path);starts=list(re.finditer(r"export const (z\w+)\s*=",code));result={}
    for index,match in enumerate(starts):
        end=starts[index+1].start() if index+1<len(starts) else len(source)
        result[match.group(1)]=(match.start(),end,set(re.findall(r"\bz[A-Z]\w*\b",code[match.end():end])))
    return result


ACTIVE_ROOTS={"zInitializeRequest","zNewSessionRequest","zLoadSessionRequest","zListSessionsRequest","zPromptRequest","zSetSessionConfigOptionRequest","zCloseSessionRequest","zCancelNotification"}


def active_schemas():
    definitions=schema_definitions(SDK+"dist/v1/schema/zod.gen.js");seen=set();todo=list(ACTIVE_ROOTS)
    while todo:
        name=todo.pop()
        if name in seen:continue
        assert name in definitions,name
        seen.add(name);todo.extend(definitions[name][2]-seen)
    return seen


def fixed_part(raw):
    previous=None
    while previous!=raw:
        previous=raw;raw=re.sub(r"\$\{[^{}]*\}","",raw)
    return raw


def prose_candidate(token):
    raw=fixed_part(token[3])
    return bool(re.search(r"[A-Za-z]",raw) and re.search(r"\s",raw))


ZOD_PATHS=["v4/index.js","v4/classic/index.js","v4/classic/external.js","v4/classic/schemas.js","v4/classic/parse.js","v4/classic/errors.js","v4/core/index.js","v4/core/core.js","v4/core/parse.js","v4/core/schemas.js","v4/core/checks.js","v4/core/errors.js","v4/core/util.js","v4/core/doc.js","v4/locales/en.js"]
# Bounded inherited error producers. Other Zod builder/format/codec/JSON-schema
# APIs are explicitly excluded in scope; they are not invoked by this SDK path.
ZOD_EXTRA={"v4/core/util.js":{592},"v4/core/core.js":{126,131,132},"v4/core/schemas.js":{1576},"v4/core/errors.js":{29,56,57,65,91,94,97,112,151,155,158,261,263},"v4/classic/errors.js":{29,34,52,53}}


def candidates():
    result=[]
    for path in sdk_js():
        for token in strings(path):
            if prose_candidate(token):result.append((path,*token))
    for suffix in ZOD_PATHS:
        path=ZOD+suffix
        for token in strings(path):
            if token[3] and (suffix=="v4/locales/en.js" and token[4]>1 or token[4] in ZOD_EXTRA.get(suffix,set())):
                result.append((path,*token))
    return result


def csv_rows(filename,columns):
    with (HERE/filename).open(encoding="utf-8",newline="") as handle:
        reader=csv.DictReader(handle);assert reader.fieldnames==columns,(filename,reader.fieldnames)
        return list(reader)


def archive_check(archive,prefix,integrity):
    data=archive.read_bytes()
    assert "sha512-"+base64.b64encode(hashlib.sha512(data).digest()).decode()==integrity,archive
    count=0
    with tarfile.open(archive,"r:gz") as package:
        for member in package.getmembers():
            if not member.isfile():continue
            assert member.name.startswith("package/")
            suffix=member.name[len("package/"):]
            assert ".." not in Path(suffix).parts
            assert package.extractfile(member).read()==local(prefix+suffix).read_bytes(),member.name
            count+=1
    return count


def main():
    global SDK_ROOT,ZOD_ROOT
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--sdk-root",type=Path,default=SDK_ROOT)
    parser.add_argument("--zod-root",type=Path,default=ZOD_ROOT)
    args=parser.parse_args();SDK_ROOT=args.sdk_root;ZOD_ROOT=args.zod_root
    for filename,digest in DATA_TEXT_SHA256.items():
        assert hashlib.sha256((HERE/filename).read_text(encoding="utf-8").encode("utf-8")).hexdigest()==digest,filename
    rows=csv_rows("acp-dependencies.csv",COLUMNS);scope=csv_rows("acp-dependencies-scope.csv",SCOPE_COLUMNS)
    assert len({r["item_id"] for r in rows})==len(rows)
    assert len({r["message_id"] for r in rows})==len(rows)
    hashes=0
    for record in scope:
        assert record["revision"]==REVISION
        if not record["sha256"]:continue
        path=record["source"];actual=hashlib.sha256(local(path).read_bytes()).hexdigest()
        assert actual==record["sha256"],path
        if not path.startswith((SDK,ZOD,"test-results/")):
            committed=subprocess.run(["git","show",REVISION+":"+path],cwd=ROOT,check=True,capture_output=True).stdout
            assert hashlib.sha256(committed).hexdigest()==actual,(path,"repository authority")
        hashes+=1
    represented={}
    for row in rows:
        assert all(row[k] for k in COLUMNS if k not in ("english",)),row["item_id"]
        proof=re.search(r"anchor=(\{[^\n]+\})",row["evidence"])
        assert proof,row["item_id"]
        anchor=json.loads(proof.group(1));path=anchor["path"];text=read(path)
        if row["english"]:
            key=(path,anchor["start"],anchor["end"])
            assert key not in represented,key
            represented[key]=row["english"]
            token=next((t for t in strings(path) if (t[0],t[1])==(anchor["start"],anchor["end"])),None)
            assert token and token[3]==row["english"],row["item_id"]
            assert row["english_location"]==path+":"+str(token[4]),row["item_id"]
        else:
            assert anchor["expression"] in text.splitlines()[anchor["line"]-1],row["item_id"]
            assert row["english_location"]==path+":"+str(anchor["line"])
        for ref in re.finditer(r"((?:npm:@agentclientprotocol/sdk@2\.0\.2/|npm:zod@4\.6\.7/|packages/)[A-Za-z0-9_./@-]+):(\d+)"," ".join(row.values())):
            assert 0<int(ref[2])<=len(read(ref[1]).splitlines()),(row["item_id"],ref[0])
    expected={(p,a,b):raw for p,a,b,kind,raw,line,col in candidates()}
    assert represented==expected,(set(expected)-set(represented),set(represented)-set(expected))
    assert (len(rows),len(represented),len(scope),hashes)==(386,377,165,161)
    boundary_expressions={json.loads(re.search(r"anchor=(\{[^\n]+\})",r["evidence"])[1])["expression"] for r in rows if not r["english"]}
    assert boundary_expressions=={"error.format()","JSON.parse(details)","internalError({ details })","new RequestError(code, message, data)","JSON.parse(trimmedLine)","console.error","controller.error(err)","new F(...Object.keys(this.closed)","config.customError"}
    sdk_scoped={r["source"] for r in scope if r["status"]=="sdk-runtime-literal-and-branch-pass"}
    assert sdk_scoped==set(sdk_js()) and len(sdk_scoped)==43
    metadata=json.loads(read(SDK+"package.json"));assert metadata["exports"]["."]["import"]=="./dist/v1/stable/acp.js"
    assert metadata["exports"]["."]["default"]=="./dist/v1/stable/acp.js"
    root_app=read(SDK+"dist/v1/stable/acp.js")
    assert "const stableConnectionOptions = { allowBatches: false };" in root_app
    assert "const rawConnection = this.builder.connect(stream, stableConnectionOptions);" in root_app
    assert "new TextDecoder()" in read(SDK+"dist/core/stream.js")
    assert 'RequestError.invalidParams(error.format()).toResult()' in read(SDK+"dist/core/jsonrpc.js")
    assert len(active_schemas())==41
    active_path=SDK+"dist/v1/schema/zod.gen.js";defs=schema_definitions(active_path)
    active_text="\n".join(read(active_path)[defs[n][0]:defs[n][1]] for n in active_schemas())
    assert "requiredDefaultOnError(" not in active_text and "excludeKnownTags(" not in active_text
    assert "error:" not in active_text
    lock=json.loads(read("package-lock.json"))["packages"]
    sdk_count=archive_check(ROOT/"test-results/agentclientprotocol-sdk-2.0.2.tgz",SDK,lock["node_modules/@agentclientprotocol/sdk"]["integrity"])
    zod_count=archive_check(ROOT/"test-results/acp-dependency-sources/zod-4.6.7.tgz",ZOD,lock["node_modules/zod"]["integrity"])
    assert sdk_count==137 and zod_count==840
    print(json.dumps({"rows":len(rows),"exact_source_occurrences":len(represented),"dynamic_boundaries":len(rows)-len(represented),"scope_rows":len(scope),"source_hashes":hashes,"sdk_runtime_bodies":43,"active_v1_schemas":41,"sdk_archive_members":sdk_count,"zod_archive_members":zod_count,"product_or_sdk_execution":False,"zod_scope":"bounded English locale and synchronous validation path; unrelated APIs excluded"},sort_keys=True))


if __name__=="__main__":main()
