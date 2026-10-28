"""Read-only qualification/smoke/update script wording verification; no producer execution."""
import csv,hashlib,json,re
from collections import Counter
from functools import cache
from pathlib import Path
ROOT=Path(__file__).resolve().parents[2]
HERE=Path(__file__).resolve().parent
REVISION="346d1e481757a55eb62fc066e43bbc7999b8e6dd"
COLUMNS=["item_id","message_id","english","english_location","display_location","trigger","consumer_evidence","translation_boundary","evidence"]
SCOPE_COLUMNS=["source","status","coverage","sha256","revision","detail"]
@cache
def read(path):return (ROOT/path).read_text(encoding="utf-8")
FILES=['scripts/live-flow-smoke.mjs', 'scripts/live-ja-smoke.mjs', 'scripts/live-locale-smoke.mjs', 'scripts/live-model-catalog.mjs', 'scripts/pi-upstream.mjs', 'scripts/test-auto-update.mjs', 'scripts/test-camoufox-client-import.mjs', 'scripts/test-packed-camoufox.mjs', 'scripts/test-packed-cli.mjs', 'scripts/test-task-continuation-integration.mjs']

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
            if i==0 and source.startswith('#!',i):
                end=source.find('\n',i);end=length if end<0 else end
                out.append((i,end,'hashbang',source[i:end]));i=end;continue
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
    return [(a,b,k,t,source.count('\n',0,a)+1) for a,b,k,t in lex(source) if k in ('string','template','regex','hashbang') and t]


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
    return not text.startswith('## ') and bool((re.search(r'["\'`]',text) and re.search(r'[();={}:,]',text)) or re.search(r'\.match(?:All)?\s*\(',text))


def project(path,start,raw):
    if re.search(r'String\.raw\s*$',read(path)[:start]):
        return raw,[(start+1+i,start+2+i) for i in range(len(raw))]
    return decode_static(raw,start+1)


@cache
def generated_tokens(path):
    source=read(path);result=[];failures=[]
    for pa,pb,pk,raw,line in top_tokens(path):
        if not projection_site(path,line):continue
        if pk in ('regex','hashbang'):continue
        projection,mapping=project(path,pa,raw)
        if not is_code_fragment(projection):continue
        live=[(a,b) for a,b,k,t in lex(source) if k=='interpolation' and pa<a<b<pb]
        try:found=lex(projection)
        except AssertionError as error:
            failures.append((line,str(error)));continue
        for ga,gb,gk,text in found:
            if gk not in ('string','template','regex','hashbang') or not text:continue
            if gk in ('regex','hashbang'):a=mapping[ga][0];b=mapping[gb-1][1]
            else:a=mapping[ga][1];b=mapping[gb-1][0]
            if any(x<=a<y for x,y in live):continue
            assert a<=b
            result.append((a,b,gk,source[a:b],source.count('\n',0,a)+1,pa,pb,ga,gb,text))
    return result,failures


@cache
def source_calls(source):
    masked=list(source)
    for a,b,k,text in lex(source):
        for i in range(a,b):
            if masked[i]!='\n':masked[i]=' '
    code=''.join(masked);result=[]
    for match in re.finditer(r'(new\s+Error|assert\.\w+|console\.(?:log|warn|error)|process\.(?:stdout|stderr)\.write|(?<![\w.])fail|(?<![\w.])grade|(?<![\w.])smokePhase|session\.until|defects\.push)\s*\(',code):
        if re.search(r'\bfunction\s*$',code[:match.start()]):continue
        opening=match.end()-1;stack=['('];start=opening+1;args=[];i=start
        while i<len(code):
            char=code[i]
            if char in '([{':stack.append(char)
            elif char in ')]}':
                assert stack and '([{'.index(stack[-1])==')]}'.index(char),('producer',i,stack)
                stack.pop()
                if not stack:
                    args.append((start,i));result.append((match[1],match.start(),i+1,args));break
            elif char==',' and len(stack)==1:args.append((start,i));start=i+1
            i+=1
        else:raise AssertionError(('producer',match.start(),'unterminated producer call'))
    return result


@cache
def calls(path):return source_calls(read(path))

def message_call(path,a,b):
    result=[]
    for name,start,end,args in calls(path):
        argument=next((i for i,(x,y) in enumerate(args) if x<=a<b<=y),None)
        if argument is None:continue
        expected=0 if name in ('new Error','fail','smokePhase','defects.push') or name.startswith(('console.','process.')) else 1 if name in ('assert.ok','session.until') else 2
        if argument==expected:result.append((end-start,name,start,end,args,argument))
    return min(result) if result else None


@cache
def code_mask(path):
    source=read(path);result=list(source)
    for a,b,k,t in lex(source):
        for i in range(a,b):
            if result[i]!='\n':result[i]=' '
    return ''.join(result)


def matching(code,start):
    stack=[]
    for i in range(start,len(code)):
        c=code[i]
        if c in '([{':stack.append(c)
        elif c in ')]}':
            assert stack and '([{'.index(stack[-1])==')]}'.index(c)
            stack.pop()
            if not stack:return i
    raise AssertionError(('unclosed',start))


@cache
def regions(path):
    source=read(path);code=code_mask(path);out=[]
    for match in re.finditer(r'\b(if|for|catch)\s*\(',code):
        opening=match.end()-1;close=matching(code,opening);body=close+1
        while body<len(code) and code[body].isspace():body+=1
        if code[body:body+1]=='{':end=matching(code,body)+1
        else:
            # Single statement, with all nested delimiters skipped.
            end=body
            while end<len(code) and code[end]!=';':
                if code[end] in '([{':end=matching(code,end)
                end+=1
            end+=1
        out.append((body,end,match[1],opening+1,close,match.start()))
    for match in re.finditer(r'\bfunction\s+(\w+)\s*\(',code):
        close=matching(code,match.end()-1);body=code.find('{',close)
        assert body>=0
        out.append((body,matching(code,body)+1,'function',match.start(),close+1,match.start()))
    return out


def guard_evidence(path,a,b):
    return [{'kind':k,'start':x,'end':y,'line':read(path).count('\n',0,x)+1,'raw':read(path)[x:y]}
            for start,end,k,x,y,z in regions(path) if start<=a<b<=end]




def projection_site(path,line):
    return path=="scripts/test-auto-update.mjs" and line in (151,284,285,287,296,318) or path=="scripts/test-packed-cli.mjs" and line in (86,311,425,458,476,550,565,571)


TABLE_HASHES={'qualification-scripts.csv': '028014611fc5c84613196288c1b1180db687cde6161816c59e41b3f0a4d1501c', 'qualification-scripts-scope.csv': 'd27944342dcf4900b4b6477ce460f48027c64134a6fe77b562f339e1e7ec995a'}
SOURCE_BLOBS={'dev-build.sh': '753d08e21b60dcfc30bf35751ed812d53f860bbc', 'scripts/affected-tests.mjs': 'e35645fa9766b14e3099248d03d6df652b489e44', 'scripts/apply-background-flow.mjs': '66e208332a09325693d85196234686d34142e16b', 'scripts/apply-code-previews.mjs': '5c63b302622583cde7d4388714ba6b5982245209', 'scripts/apply-multiloop-wait-skill.mjs': '8654d411d56eedaef8658d138708bf0ce68f6e34', 'scripts/apply-pi-content-policy.mjs': '6f83cc040e2c272a4ab44aa12bb2513783b6eec7', 'scripts/apply-pi-flow-control.mjs': '97298d0c397341af10b3a3b7d01baafcd8fa32ab', 'scripts/apply-pi-path-utils.mjs': 'b0ed2028e4bf8a8140d6593ea29627f4ebfc2a0f', 'scripts/apply-pi-provider-receipts.mjs': 'a68cd4c0830d0c8e9bd737723cd6975c8017377f', 'scripts/apply-pi-terminal-clipboard.mjs': '5d43eeab7df69789f603775c12331dfb53947c2e', 'scripts/apply-task-flow.mjs': '6032feb92cd450428d4d319286edc47df2a3c5f9', 'scripts/apply-vcc-goals.mjs': 'a1a949eb91e3b07069b327ac7ab34a77997f67b6', 'scripts/apply-webaio-defuddle-quiet.mjs': '480ddd49c7db55eae4d742765fda5040319adf99', 'scripts/audit-ja-startup.mjs': '62eaa03ee54ec7bb1c8cb8255aaa56e242a699c7', 'scripts/background-flow-transform.mjs': '3a3342cac064bac029346b6f78161b77b8c5cba7', 'scripts/background-resource-transform.mjs': 'f4586e78b45c010ebe96977eec20b1e9af971603', 'scripts/background-widget-transform.mjs': '1146fba546d0b62b1f12ea506b55137245dbaf7a', 'scripts/build-textguard.mjs': '1919cabf42d91b0d6eab028deaf734c3bc608475', 'scripts/canvas-package-boundary.mjs': '7c077b84dff539d2d577bb6c7a4e11574abee990', 'scripts/catalog-digest.mjs': '7140a852a5fa93d13c2d5600dcca1b55b826ef40', 'scripts/catalog-lock.mjs': '99b35759530b162f70f3e4ccfaa15f141b149c62', 'scripts/check-direct-strings.mjs': '98de12e8d0605dbb6037d788d63d7cb54b16d2a8', 'scripts/check-dist-fresh.mjs': '2941886717ab8ce7e7d745cb3f015e95b3629eb8', 'scripts/check-locales.mjs': '218d7b17b97d6c222fce2acf6191a06267092d5c', 'scripts/check-pi-contract.mjs': '9c38f26c85cb0e172e67f53267506b9268288dca', 'scripts/check-release-metadata.mjs': '7d26a067bbc477c0966ac67c1454fb73e0f52b26', 'scripts/ci-changes.mjs': '9bf55cf2cdb86afb2d1e5edc3f476cd91114848a', 'scripts/cjk-catalog-render.mjs': 'ee2dc60dcb35a984de92f89e8455bf4729ed3176', 'scripts/code-previews-transform.mjs': '752aecea2a30ab1778c233aa24ca0e62fffb3d23', 'scripts/configure-release-packlists.mjs': 'bcbb9f725dcda52275e25cc735148af7e065cc34', 'scripts/copy-catalog.mjs': '67380aa1edc4e913047607bcc26183704d0d88a1', 'scripts/copy-locales.mjs': '46c5849d81a4928541884ec1d59cc16b8bb8065a', 'scripts/copy-pi-lock.mjs': 'b86f2537d792c4c66ba0924f675f34b063fb87b4', 'scripts/copy-profiles.mjs': '2d4ce2236339d673104069bc7d1bfb717e8240bc', 'scripts/copy-release-extensions.mjs': 'e27e79dcc7d17a1b7134b86f9c3137f31315921a', 'scripts/copy-session-ui.mjs': 'e15e85785fd8027f9f76123ffa3ea4096f55006c', 'scripts/dev-smoke.mjs': 'ec7eb158b7bb5d0ecb266c5e34c78e2073d2a3fa', 'scripts/install-release-extensions.mjs': '0695080e0e45a1b9dc2427fc04ca36d9a2c8b4f4', 'scripts/install-source-dependencies.mjs': '4619c416ec605916ede36489000eea0cacfab2d2', 'scripts/ja-review-run.mjs': '0384c7a9f7cffe060ca23b58b4273773019f7eec', 'scripts/live-flow-smoke.mjs': '72760fe53441d4f975583cc7a4817db8a1ff17d7', 'scripts/live-ja-smoke.mjs': '206eab29fadae31986f3cfa274244d503461a061', 'scripts/live-locale-smoke.mjs': '5ef3c5eae3e6624afb3b903507212ee13d5c556f', 'scripts/live-model-catalog.mjs': '81388ccfe472f56373c4831d7170f56f576768b8', 'scripts/multiloop-flow-transform.mjs': 'aeb67130a0288ddb0b313faf5d597cda942c5838', 'scripts/pack-check.mjs': 'cc1b119905ad786895fa07efcd2dec4c3d9457e7', 'scripts/pack-output.mjs': '5c5bbe5f5c03d2ab2649186866b8743cb22ecc25', 'scripts/patch-inputs.mjs': '489165750be330ecb82dd95bcbeca50b9f98e4d4', 'scripts/pi-content-policy-transform.mjs': '44187b87ebc320f826d92658f9e40319b8bd968a', 'scripts/pi-flow-control-transform.mjs': 'e15b04cbe2c7ff352d80c8af1ebaf9494c72044a', 'scripts/pi-oauth-branding-transform.mjs': '3e43635735e279c2a024fff83d6241a24917923f', 'scripts/pi-path-utils-transform.mjs': '5692d620899ac60d955288423a11cb69df261a17', 'scripts/pi-provider-receipts-transform.mjs': '364069bfc9e4df262475dcaaa0611da0e112ae16', 'scripts/pi-upstream.mjs': '9ab032ee651a50de9204127d1df8012a90141f17', 'scripts/prepare-ci-artifacts.mjs': '54b413a9c726352d8a5499fa799995d61c40dfa1', 'scripts/prepare-cli.mjs': 'a5d9932e76d2d644860b6e5e1b5cd6904bb121a6', 'scripts/publish-npm.mjs': '7887086581c54c959c7f54ffb6233a6a34f86a18', 'scripts/published-upgrade.mjs': '65280d08a1b276948a99f2e34035abd5e6a06fc8', 'scripts/release-artifact.mjs': '876ac6ea15d3b85993a451ca0f1edbe06bb01076', 'scripts/release-bundle-receipt.mjs': '2df26accebfdd8d63f7e5d48c1d87b59d202ef60', 'scripts/release-publication-source.mjs': '2e7bc1458e7d8860b115eed95b1fb9c29f0043b2', 'scripts/run-tests.mjs': '5f243ae6ca0e503b2ef7984cff17e9dccecacde3', 'scripts/smoke-phase.mjs': 'e20351d75be38f04e803e265a4d52f7785c92ad8', 'scripts/stress-tests.mjs': '7ef7a4fe10f12365489142f3def386f05f23a05b', 'scripts/task-flow-transform.mjs': '1a9887f30344955285a1fd7fe7850cd0ef6651a3', 'scripts/test-auto-update.mjs': 'bd8c9f0692efd2754a042637f9e752f228ac8f01', 'scripts/test-camoufox-client-import.mjs': '20f6acd46a8e3a99a6a681058ab7b40c4733d56b', 'scripts/test-packed-camoufox.mjs': '8beadd3e0d94b706965e1cb98782552af182cb8c', 'scripts/test-packed-cli.mjs': 'eba454c28bcb11acaf7cb7a787d5a915e1e13fa3', 'scripts/test-task-continuation-integration.mjs': 'de58ff913d4a6707513593eabdca8112981ead22', 'scripts/test-timing-reporter.mjs': '87dfdc4b201558eae908a013b042c8038bf36967', 'scripts/test-timings.mjs': 'ee4d5324dfd73f1b852a2c785f64edbe49aa45e4', 'scripts/vcc-goals-transform.mjs': 'b2d7596d5fa3e2dd7ece582b926be57ede6e5290', 'scripts/verify-published-release.mjs': '5141f9fa63f5584d988468a2520aa9f15b0fb4b9', 'scripts/voice-package-boundary.mjs': 'fdcadbf1e9dac3e661f4a6e83a88d612aa034b9f', 'scripts/webaio-defuddle-transform.mjs': 'de59a1aabbcb17ad6c2f00557d9e776c3c923b2c', 'scripts/webaio-package-boundary.mjs': '8c6e239b96e0f2110fe8be88d61a035410bb470e', 'scripts/webaio-redirect-transform.mjs': 'f8747ccf9d2045408386a2c6fec992deee9d7e72', 'scripts/windows-ci-defender.ps1': 'c47b3ba0ba352d5cfd7b703b49df8a6eb1d3ff22', 'scripts/windows-ci-paths.ps1': '478c2d3db691fdaaec8b2ea04289fc30613d1568', 'scripts/write-dev-build-info.mjs': 'bbb3134e5abbd5ea30053c455261055c20234aba', 'package.json': 'fd9d38ea561c0aa8202eb236b8a5807b4e90c339', 'packages/cli/package.json': 'c11f4b56d2a09d45c47d22d87d8c45641865d9bc', 'packages/session-ui/package.json': 'b54dc2ff1f10b29c5058b1e115608c76bbb7f72b', 'package-lock.json': 'b71bc0c61af4a1f4fe2b6abb986f1b9313ea46d4', 'upstream/pi.lock.json': '8fb30b6e5192d43ffcded8569a696565fb898788', 'upstream/pi-content-policy/patch.lock.json': 'ceca3fea924013c9219687e2583706d03a04a1a0', 'packages/cli/release-extensions.json': 'd13b52557fd1095f878f1a729314e91e48ede531', '.github/workflows/ci.yml': 'd71eb3f9005d0eb16d7a392d843b22a524ef5b25', '.github/workflows/pi-latest.yml': '0b385b47c8cb9253560b97c5335fc776ae641879', 'packages/cli/src/camoufox-adapter.ts': '5fc2c720e584d9e6014f0394a1b780581608d86f', 'packages/cli/src/updater.ts': '2408a7434538c5e4e0451d3f1e918ec1920b2c3d', 'packages/cli/src/textguard-native.ts': 'd0b1eaa68a385c28eee47f497296cafdb257ea88', 'scripts/affected-tests.test.mjs': '43fb0da2418107a20258a00ec21d3798d0061570', 'scripts/apply-webaio-defuddle-quiet.test.mjs': '2190df6632266b1839ab77a6397c593f0792a014', 'scripts/canvas-package-boundary.test.mjs': '5aa97df57ea71de9146ab9d96125d3a21d72e81d', 'scripts/check-release-metadata.test.mjs': 'db7f3334f864c8f2db1d4370a094095fe4d5145f', 'scripts/ci-changes.test.mjs': '693a3d826a426ac153cf8b966de79af1d4a87377', 'scripts/code-previews.test.mjs': '34081335c39da6a7905c13cfe75c457b2f370512', 'scripts/dev-smoke.test.mjs': 'b17fe4b8569762364bc3d928b6671ff161a901cf', 'scripts/gate-commands.test.mjs': '6a126b10de889dcfb2a453c99144fbcde65a3818', 'scripts/live-flow-smoke.test.mjs': '14cb334acd18fd813cc27bea6769eaee7ce86704', 'scripts/live-locale-smoke.test.mjs': 'bc928c0916eabb90e19b408e5df1245770597d28', 'scripts/pack-check.test.mjs': '7a4b6f4964ce38f1bdec2dc7db3aedf89b9cf913', 'scripts/pack-output.test.mjs': '06e45bda98e13eb69a4bf2a21eddf6a71cfe1ba6', 'scripts/pi-bug-report.test.mjs': '38ba3aca8a9fa2e77d6d562ebb1435d4e1cb073c', 'scripts/pi-content-policy.test.mjs': 'dce2271220d366fd734ae06055c824e999a59ad7', 'scripts/pi-flow-control.test.mjs': '42002110ee7a84feb4e4a6aaa9d35587e1db666e', 'scripts/pi-flow-ingress-dispositions.test.mjs': '3dff2f1be2ee5620c0338ac04adf96241348c91a', 'scripts/pi-flow-ingress.test.mjs': 'c926589460ea2e1e03d1f8d16a5db11e4e2c7d94', 'scripts/pi-flow-rpc.test.mjs': '234cccc68b7140859a304af48e7fa4b61c2f7f17', 'scripts/pi-ime-slash.test.mjs': 'f30b6e1ec770312db46b6ce2f8b0795792c20687', 'scripts/pi-login-default.test.mjs': '0b53dd0b1e5666fbe7adee28127cc6987dcf8113', 'scripts/pi-oauth-branding.test.mjs': '6c588b7897d531512fc7c8a0b9da7d3accf5ad19', 'scripts/pi-path-utils.test.mjs': '9131bcc9d90fc4181385054c2ff2039f8931d02f', 'scripts/pi-provider-receipts.test.mjs': '5d8c0b3d2cbb37643056611992534458945e48ca', 'scripts/pi-summary-preparation.test.mjs': 'ea4521afca272378e5f771fe0c8dac2311a6a9d3', 'scripts/pi-upstream.test.mjs': '550fd3fc1a7c62a51b6e281cd1cbf9f710004cc8', 'scripts/pi-user-input-binding.test.mjs': '7562683bcd5bdc6479413e998f328dc251b25ca8', 'scripts/release-artifact.test.mjs': '32fac00d41afe1d966dfe7a03baceef0f898cfc7', 'scripts/release-bundle-receipt.test.mjs': 'e1d684649b12a9e5e9d68cbb5986e4a542840522', 'scripts/release-publication-source.test.mjs': 'd4ad959323f810ec8b487812675e4e4eb1363cf7', 'scripts/run-tests.test.mjs': '75a634a0946add3710a6be23ef4db7abb8503f16', 'scripts/smoke-phase.test.mjs': '729956b8bece8fc98e9cfb478b4db5a3bb1bbaca', 'scripts/stress-tests.test.mjs': '91ed80d59e6fb56de6b004eb5c79d69e39f8af41', 'scripts/test-timings.test.mjs': '8147df4308f1207974fd11ef819de9d36567233f', 'scripts/textguard-artifact.test.mjs': '2749adf2e80448ec4f0e4e519ab56bee47043781', 'scripts/vcc-goals.test.mjs': '78b777de96b7be72503a61c705c40435fe9c6dfb', 'scripts/webaio-defuddle-transform.test.mjs': 'bbf6745ad9f78be788372ee710facbeee535c455', 'scripts/windows-ci-defender.test.ps1': '78520a55cd0dcd0c6f181044b39b8bea1f4a9afe', 'scripts/windows-ci-paths.test.ps1': 'feefe67d6af8c333feada4b9795053ad450a124a'}
BASE_SCOPE_SHA='b20b35b944eab2d6547f2009ccb2b13b77cc546f35f89ddd4203489ccc9890c8'


def table(name,columns):
    with (HERE/name).open(encoding='utf-8',newline='') as handle:
        reader=csv.DictReader(handle);assert reader.fieldnames==columns,name
        rows=list(reader)
    assert all(set(row)==set(columns) and None not in row.values() for row in rows),name
    return rows


def main():
    assert len(FILES)==len(set(FILES))==10 and len(TABLE_HASHES)==2
    for name,digest in TABLE_HASHES.items():
        assert hashlib.sha256((HERE/name).read_text(encoding='utf-8').encode()).hexdigest()==digest,name
    rows=table('qualification-scripts.csv',COLUMNS);scope=table('qualification-scripts-scope.csv',SCOPE_COLUMNS)
    assert (len(rows),len(scope))==(1679,134)
    assert [r['item_id'] for r in rows]==[f'QUALIFY-{n:04d}' for n in range(1,len(rows)+1)]
    assert all(not r['message_id'] for r in rows),'No catalog definitions introduced'
    assert len({r['source'] for r in scope})==len(scope)
    sources={r['source'] for r in scope if r['sha256']};assert sources==set(SOURCE_BLOBS) and len(sources)==131
    for record in scope:
        assert record['revision']==REVISION
        if not record['sha256']:assert record['source'] in ('scope-postconditions','projection-method','authority-provenance');continue
        path=record['source'];data=(ROOT/path).read_bytes()
        assert hashlib.sha256(data).hexdigest()==record['sha256'],path
        # Main Git-object identity is checked as bytes without launching Git.
        # Expected objects were frozen from the parent-verified main census.
        actual=hashlib.sha1(b'blob '+str(len(data)).encode()+b'\0'+data).hexdigest()
        assert actual==SOURCE_BLOBS[path],(path,'main blob identity')
    base_text=(HERE/'validation-scripts-scope.csv').read_text(encoding='utf-8')
    assert hashlib.sha256(base_text.encode()).hexdigest()==BASE_SCOPE_SHA
    base=table('validation-scripts-scope.csv',SCOPE_COLUMNS)
    candidates={r['source'] for r in base if r['status'] in ('fully-read-validation-unit','already-covered-elsewhere','pending-root-script')}
    assert len(candidates)==81
    for p in candidates:
        assert (p.startswith('scripts/') and p.count('/')==1 or '/' not in p) and Path(p).suffix in {'.mjs','.ps1','.sh'} and '.test.' not in p
    evidence=[json.loads(r['evidence']) for r in rows]
    assert Counter(e['kind'] for e in evidence)=={'primary':1534,'nested':34,'assertion-boundary':66,'generated-assertion-boundary':8,'embedded-output':1,'delivery-boundary':28,'native-file-boundary':8}
    primary={};nested={};assertions={};generated_assertions={};native={};locations={}
    for row,e in zip(rows,evidence):
        p=e['path'];assert p in FILES
        source=read(p);a,b=e['start'],e['end'];assert 0<=a<b<=len(source)
        assert row['english_location']==f'{p}:{source.count(chr(10),0,a)+1}'
        assert all(row[k] for k in ('display_location','trigger','consumer_evidence','translation_boundary'))
        assert row['translation_boundary'].startswith(e['role']+'.')
        locations.setdefault(row['english_location'],[]).append((row,e))
        if e['kind']=='primary':
            key=(a,b,e['token_kind']);assert key not in primary.setdefault(p,{})
            primary[p][key]=row['english'];assert e['guards']==guard_evidence(p,a,b)
            assert e['projection_site']==bool(projection_site(p,source.count('\n',0,a)+1))
            call=message_call(p,a,b)
            expected={'name':call[1],'start':call[2],'end':call[3],'argument':call[5]} if call else None
            assert e.get('producer')==expected
        elif e['kind']=='nested':
            key=(a,b,e['token_kind'],e['parent_start'],e['parent_end'],e['generated_start'],e['generated_end'],e['projected_payload'])
            assert key not in nested.setdefault(p,{})
            nested[p][key]=row['english'];assert source[a:b]==row['english']
            assert e['guards']==guard_evidence(p,e['parent_start'],e['parent_end'])
        elif e['kind']=='embedded-output':
            assert row['english']==source[a:b]==e['raw']=='swept'
            assert p=='scripts/live-flow-smoke.mjs' and e['guards']==guard_evidence(p,e['parent_start'],e['parent_end'])
            parent=next(t for t in top_tokens(p) if t[0]==e['parent_start'] and t[1]==e['parent_end'])
            assert parent[4]==412 and 'echo swept' in parent[3]
        else:
            assert not row['english'],'Unknown native/remote text remains blank'
            assert source[a:b]==e['raw']
            if e['kind']=='generated-assertion-boundary':
                assert e['guards']==guard_evidence(p,e['parent_start'],e['parent_end'])
                key=(e['parent_start'],e['parent_end'],e['generated_start'],e['generated_end'])
                assert key not in generated_assertions.setdefault(p,{})
                generated_assertions[p][key]=e
            else:
                assert e['guards']==guard_evidence(p,a,b)
                if e['kind']=='assertion-boundary':assert (a,b) not in assertions.setdefault(p,{});assertions[p][a,b]=e
                elif e['kind']=='native-file-boundary':assert p not in native;native[p]=(a,b)
        for field in ('trigger','consumer_evidence'):
            for match in re.finditer(r'((?:scripts|packages|upstream|\.github)/[\w./-]+|package\.json):(\d+)',row[field]):
                cited,line=match[1],int(match[2]);assert cited in sources,(row['item_id'],cited)
                assert 1<=line<=len(read(cited).splitlines()),(row['item_id'],match[0])
    for p in FILES:
        assert primary.get(p,{})=={(a,b,k):t for a,b,k,t,line in top_tokens(p)},(p,'primary census')
        children,failures=generated_tokens(p);assert not failures,(p,failures)
        expected={(a,b,k,pa,pb,ga,gb,payload):t for a,b,k,t,line,pa,pb,ga,gb,payload in children}
        assert nested.get(p,{})==expected,(p,'nested fixture census')
        expected_asserts={}
        for name,a,b,args in calls(p):
            if not name.startswith('assert.'):continue
            if any(message_call(p,x,y) and message_call(p,x,y)[2]==a for x,y,k,t,l in top_tokens(p)):continue
            ix=1 if name=='assert.ok' else 2
            expected_asserts[a,b]=(read(p)[args[ix][0]:args[ix][1]].strip() or None) if len(args)>ix else None
        assert set(assertions.get(p,{}))==set(expected_asserts),(p,'main default/dynamic assertions')
        for key,custom in expected_asserts.items():assert assertions[p][key]['custom_message_expression']==custom
        expected_generated={}
        for pa,pb,pk,raw,line in top_tokens(p):
            if not projection_site(p,line) or pk not in ('string','template'):continue
            projection,mapping=project(p,pa,raw)
            for name,ga,gb,args in source_calls(projection):
                if not name.startswith('assert.'):continue
                ix=1 if name=='assert.ok' else 2
                custom=(projection[args[ix][0]:args[ix][1]].strip() or None) if len(args)>ix else None
                expected_generated[pa,pb,ga,gb]=(mapping[ga][0],mapping[gb-1][1],name,custom)
        assert set(generated_assertions.get(p,{}))==set(expected_generated),(p,'generated assertions')
        for key,(a,b,name,custom) in expected_generated.items():
            e=generated_assertions[p][key];assert (e['start'],e['end'],e['producer'],e['custom_message_expression'])==(a,b,name,custom)
        first=re.search(r'\b(?:readFileSync|writeFileSync|appendFileSync|readdirSync|mkdtempSync|rmSync|mkdirSync|cpSync|createHash|JSON\.parse|fetch|createServer)\s*\(',code_mask(p))
        assert native.get(p)==(first.span() if first else None)
    headers=[(r,e) for r,e in zip(rows,evidence) if e.get('token_kind')=='hashbang']
    assert len(headers)==9
    assert sum(e['kind']=='primary' for r,e in headers)==8 and sum(e['kind']=='nested' for r,e in headers)==1
    for row,e in headers:
        assert row['english']=='#!/usr/bin/env node' and 'hashbang' in e['role']
        if e['kind']=='primary':assert e['start']==0
    full={r['source'] for r in scope if r['status']=='fully-read-qualification-unit'}
    prior={r['source'] for r in scope if r['status']=='already-covered-elsewhere'}
    pending={r['source'] for r in scope if r['status']=='pending-root-bash'}
    assert (len(full),len(prior),len(pending))==(10,70,1)
    assert full==set(FILES) and full|prior|pending==candidates and not(full&prior or full&pending or prior&pending)
    assert pending=={'dev-build.sh'} and len(read('dev-build.sh').splitlines())==656
    assert sum(len(read(p).splitlines()) for p in FILES)==3068
    assert {r['source'] for r in scope if r['status']=='excluded-test-body'}=={r['source'] for r in base if r['status']=='excluded-test-body'}
    assert len([r for r in scope if r['status']=='excluded-test-body'])==38
    assert len([r for r in scope if r['status']=='bounded-metadata-caller-support'])==12
    def at(path,line,kind='primary'):return [(r,e) for r,e in locations[f'{path}:{line}'] if e['kind']==kind]
    # Reviewed semantic postconditions, in addition to lexical/hash coverage.
    for line in (142,148,150,152):assert sum(e['role']=='fixed-accountant-error' for r,e in at('scripts/live-flow-smoke.mjs',line))==1
    for line in (486,499):assert all(e['role']=='fixed-json-report-prose' for r,e in at('scripts/live-flow-smoke.mjs',line))
    assert any(e['role']=='protected-model-shell-command' for r,e in at('scripts/live-flow-smoke.mjs',412))
    assert any('not merely empty' in r['trigger'] for r,e in at('scripts/live-ja-smoke.mjs',117))
    assert any('not merely' not in r['trigger'] and 'nullish' in r['trigger'] for r,e in at('scripts/live-locale-smoke.mjs',330))
    assert any('original exception reason' in r['trigger'] for r,e in at('scripts/pi-upstream.mjs',179))
    assert any(e['role']=='protected-output-match' for r,e in at('scripts/test-auto-update.mjs',468))
    assert any('existing smokeError' in r['trigger'] for r,e in at('scripts/test-auto-update.mjs',515))
    assert any('not handled by benign' in r['trigger'] for r,e in at('scripts/test-auto-update.mjs',517))
    assert sum(e['role']=='generated-extension-fixture-prose' for r,e in zip(rows,evidence))==3
    assert any(r['english']=='intentional updater smoke failure' and e['role']=='generated-fixture-error' for r,e in at('scripts/test-auto-update.mjs',151,'nested'))
    assert any(e['role']=='generated-model-response-fixture' for r,e in at('scripts/test-packed-cli.mjs',300))
    assert all('Model-facing probe input' in r['translation_boundary'] for r,e in zip(rows,evidence) if e['role']=='model-probe-prompt')
    for name in ('qualification-scripts.csv','qualification-scripts-scope.csv','verify-qualification-scripts.py'):
        text=(HERE/name).read_text(encoding='utf-8')
        assert not text.endswith('\n\n') and not any(line.endswith((' ','\t')) for line in text.splitlines()),name
    print(json.dumps({'rows':len(rows),'primary_occurrences':1534,'primary_literals_regex':1526,'primary_hashbangs':8,'nested_occurrences':34,'main_assertion_boundaries':66,'generated_assertion_boundaries':8,'embedded_echo_fragments':1,'other_boundaries':36,'scope_rows':len(scope),'source_hashes':len(sources),'main_blob_identities':len(SOURCE_BLOBS),'full_bodies':10,'full_body_lines':3068,'prior_root_bodies':70,'remaining_root_bodies':1,'remaining_root_lines':656,'producer_execution':False,'git_process_execution':False,'network_execution':False},sort_keys=True))


if __name__=='__main__':main()
