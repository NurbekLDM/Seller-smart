from pathlib import Path
from html.parser import HTMLParser
import re,json,base64,hashlib
ROOT=Path(__file__).resolve().parent
OUT=ROOT.parent/'outputs/split118'
EX=ROOT/'extracted';EX.mkdir(exist_ok=True)
rows=[];report={'files':{},'preserved':{}}
def scripts(s):return list(re.finditer(r'<script\b([^>]*)>(.*?)</script\s*>',s,re.I|re.S))
def sid(m):
    v=re.search(r'\bid="([^"]+)"',m[1]);return v[1] if v else ''
def collect(name,s):
    for i,m in enumerate(scripts(s)):
        attrs,body=m.groups()
        if not body.strip() or re.search('application/(?:octet-stream|json)',attrs):continue
        p=EX/(name+'_'+str(i)+'.js');p.write_text(body)
        rows.append({'realm':name,'i':i,'id':sid(m),'file':str(p.resolve())})
class Structure(HTMLParser):
    def __init__(self,s):
        super().__init__();self.ids=set();self.targets=set();self.src=[];self.feed(s)
    def handle_starttag(self,tag,attrs):
        a=dict(attrs)
        if a.get('id'):self.ids.add(a['id'])
        if a.get('data-view'):self.targets.add(a['data-view'])
        if tag in {'script','link'} and a.get('src'):self.src.append(a['src'])
for mode,realm in [('Analitika','outer'),('ERP','inner')]:
    name='Smart_Retail_'+mode+'_v118.html';s=(OUT/name).read_text();original_path=ROOT/'original'/f'{realm}.html'
    original=original_path.read_text() if original_path.exists() else None
    collect(mode,s);ss=scripts(s);doc=Structure(s)
    assert not doc.src,doc.src
    assert ('authLoginForm' if mode=='ERP' else 'mergeLoginForm') in doc.ids
    if mode=='Analitika':
        assert not {'smartRetailErpFrame','view-retailerp','view-erpguide','sr108ErpPackage'}&doc.ids
        assert not re.search(r'\binitSmartRetailERP\b',s)
        pro=re.search(r'const MERGED_PRO_HTML_B64\s*=\s*"([^"]+)"',s)[1]
        if original:
            pro0=re.search(r'const MERGED_PRO_HTML_B64\s*=\s*"([^"]+)"',original)[1]
            assert pro==pro0
        collect('PRO_AI',base64.b64decode(pro).decode())
    else:
        assets={sid(m):m[2] for m in ss if sid(m).startswith('sr108Asset-')}
        assert len(assets)==5
        original_outer=ROOT/'original/outer.html'
        if original_outer.exists():
            for m in scripts(original_outer.read_text()):
                if sid(m).startswith('sr108Asset-'):assert assets[sid(m)]==m[2]
        assert base64.b64decode(assets['sr108Asset-uzum']).decode().startswith('<!DOCTYPE html>')
        for n in ['scanner','canvas','pdf']:collect('ERP_asset_'+n,'<script>'+base64.b64decode(assets['sr108Asset-'+n]).decode()+'</script>')
        waybill=json.loads(assets['sr108Asset-waybill']);assert waybill and isinstance(waybill,dict)
    old={sid(m):m[2] for m in scripts(original or '') if sid(m)};new={sid(m):m[2] for m in ss if sid(m)}
    unchanged=[k for k in old if k in new and old[k]==new[k]]
    changed=[k for k in old if k in new and old[k]!=new[k]]
    if mode=='ERP' and original:
        for k in ['pos72Core','returns101Core','employees70Core','transaction115Core','srTheme116Controller','stock102Core','transferCodec113','transferEngine113']:
            assert k in unchanged,k
    report['preserved'][mode]={'unchanged_named_scripts':len(unchanged),'changed_named_scripts':changed,'optional_remote_scripts':len(doc.src)}
    report['files'][name]={'bytes':len(s.encode()),'sha256':hashlib.sha256(s.encode()).hexdigest(),'javascript_blocks':sum(r['realm']==mode for r in rows)}
(ROOT/'extracted.json').write_text(json.dumps(rows,indent=2))
(ROOT/'integrity118.json').write_text(json.dumps(report,indent=2))
print(json.dumps(report,indent=2))
