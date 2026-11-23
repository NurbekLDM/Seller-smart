"""Prepare the preserved FIX117 combined document for a reproducible split."""
from pathlib import Path
import sys,re,hashlib,gzip,base64

source=Path(sys.argv[1]).read_bytes()
expected='03fbbc387dde05db311dc8d7cdcf034612a95b5e9485a4d9df0c5aadc70ba842'
if hashlib.sha256(source).hexdigest()!=expected:
    raise SystemExit('Source differs from the reviewed FIX117 document; do not overwrite a newer version.')
outer=source.decode()
package=re.search(r'<script id="sr108ErpPackage"[^>]*>(.*?)</script>',outer,re.S)[1]
inner=gzip.decompress(base64.b64decode(package)).decode()
dest=Path(__file__).resolve().parent/'original';dest.mkdir(exist_ok=True)
for realm,html in [('outer',outer),('inner',inner)]:
    (dest/(realm+'.html')).write_text(html)
    for i,m in enumerate(re.finditer(r'<script\b([^>]*)>(.*?)</script\s*>',html,re.I|re.S)):
        if m[2].strip() and 'application/octet-stream' not in m[1]:
            (dest/(f'{realm}_{i:03d}.js')).write_text(m[2])
print('FIX117 source prepared; run build.py, validate.py, then test118.cjs.')
