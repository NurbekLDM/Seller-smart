"""Run with Python 3.9+. Serves the app only on the local computer."""
import argparse
import os
import json
import base64
import re
from pathlib import Path
import secrets
import sys
import threading
import time
import webbrowser
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import parse_qs, urlsplit
import engine
import external_source

ROOT = Path(__file__).resolve().parent
UI = ROOT / "ui"
SOURCE_CACHE = {}
EXPORT_CACHE = {}
MAX_EXPORT = 48 * 1024 * 1024
CACHE_LOCK = threading.Lock()
MAX_JOBS = threading.BoundedSemaphore(3)
TTL_SECONDS = 30 * 60


def cache_source(source):
    now = time.monotonic()
    with CACHE_LOCK:
        for ticket in list(SOURCE_CACHE):
            if now-SOURCE_CACHE[ticket][0] > TTL_SECONDS:
                del SOURCE_CACHE[ticket]
        if len(SOURCE_CACHE) >= 16:
            del SOURCE_CACHE[min(SOURCE_CACHE, key=lambda k: SOURCE_CACHE[k][0])]
        ticket = secrets.token_urlsafe(28)
        SOURCE_CACHE[ticket] = (now, source)
    return ticket


def source_for_ticket(ticket):
    if not isinstance(ticket,str): ticket=""
    with CACHE_LOCK: entry=SOURCE_CACHE.get(ticket)
    if not entry or time.monotonic()-entry[0] > TTL_SECONDS:
        raise engine.Problem("source_expired","Manba seansi tugagan. Havolani qayta o‘qing.",409)
    return entry[1]


def cache_export(document, product_id):
    if not isinstance(document, str) or not document.startswith("<!doctype html>") or 'id="saved-card"' not in document:
        raise engine.Problem("export", "HTML kartochkasi to‘liq emas.")
    if not re.fullmatch(r"[0-9]{1,12}", str(product_id)):
        raise engine.Problem("export", "Mahsulot ID raqami noto‘g‘ri.")
    raw = document.encode("utf-8")
    if len(raw) > MAX_EXPORT:
        raise engine.Problem("export", "HTML hajmi katta. Kichikroq mahsulot suratini tanlang.")
    now = time.monotonic()
    ticket = secrets.token_urlsafe(28)
    with CACHE_LOCK:
        for prior in list(EXPORT_CACHE):
            if now-EXPORT_CACHE[prior][0] > 300:
                del EXPORT_CACHE[prior]
        if len(EXPORT_CACHE) >= 3:
            del EXPORT_CACHE[min(EXPORT_CACHE, key=lambda k: EXPORT_CACHE[k][0])]
        EXPORT_CACHE[ticket] = (now, raw, "Uzum_"+str(product_id)+"_variantlar.html")
    return "/download/"+ticket+".html"


# Host names a reverse proxy may forward (comma separated), e.g.
# "kartochka.sellersmart.uz". Empty = local-only, as before.
PUBLIC_HOSTS={h.strip().lower() for h in os.environ.get("KARTOCHKA_PUBLIC_HOSTS","").split(",") if h.strip()}


class Server(ThreadingHTTPServer):
    daemon_threads = True
    allow_reuse_address = False


class Handler(BaseHTTPRequestHandler):
    server_version = "SellerSmart"
    sys_version = ""

    def log_message(self, *args):
        # Headers, URLs, API keys and user content are never logged.
        pass

    def send_data(self, code, data, mime, filename=None):
        self.send_response(code)
        self.send_header("Content-Type",mime)
        self.send_header("Content-Length",str(len(data)))
        if filename:
            self.send_header("Content-Disposition", 'attachment; filename="'+filename+'"')
        self.send_header("Cache-Control","no-store")
        self.send_header("Referrer-Policy","no-referrer")
        self.send_header("X-Content-Type-Options","nosniff")
        self.send_header("X-Frame-Options","DENY")
        self.send_header("Content-Security-Policy","default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; connect-src 'self'; frame-ancestors 'none'; object-src 'none'; base-uri 'none'; form-action 'none'")
        self.end_headers()
        try:self.wfile.write(data)
        except (BrokenPipeError,ConnectionResetError):pass

    def reply(self, result, status=200):
        self.send_data(status,json.dumps(result,ensure_ascii=False).encode(),"application/json; charset=utf-8")

    def allowed_host(self):
        port=self.server.server_address[1]
        host=self.headers.get("Host","")
        # Server mode: the public host names Caddy forwards (KARTOCHKA_PUBLIC_HOSTS).
        return host in {f"127.0.0.1:{port}",f"localhost:{port}"} or host in PUBLIC_HOSTS

    def allowed_origin(self):
        host=self.headers.get("Host","")
        origin=self.headers.get("Origin")
        if host in PUBLIC_HOSTS:
            return origin=="https://"+host
        return origin=="http://"+host

    def do_GET(self):
        if not self.allowed_host():
            self.reply({"error":"Mahalliy manzil kerak."},403);return
        u=urlsplit(self.path)
        if u.path in ("/","/index.html","/other"):
            page=(UI/"index.html").read_text("utf-8")
            page=page.replace("<!-- CARD_STYLE -->",(UI/"card.css").read_text("utf-8"))
            page=page.replace("/* CARD_RUNTIME */",(UI/"image-tools.js").read_text("utf-8")+"\n"+(UI/"variants.js").read_text("utf-8")+"\n"+(UI/"card.js").read_text("utf-8"))
            page=page.replace("/* BRAND_DATA */",json.dumps("data:image/png;base64,"+base64.b64encode((UI/"assets"/"brand-logo.png").read_bytes()).decode("ascii")))
            page=page.replace("/* STUDIO_CONFIG */",json.dumps({"presets":engine.PRESETS,"model":engine.APP_MODEL,"models":engine.MODEL_CHOICES,"levels":engine.DETAIL_LEVELS,"source_mode":"external" if u.path=="/other" else "uzum"},ensure_ascii=False).replace("<","\\u003c"))
            self.send_data(200,page.encode(),"text/html; charset=utf-8")
        elif u.path in ("/app.js","/studio.css"):
            mime="text/javascript" if u.path=="/app.js" else "text/css"
            self.send_data(200,(UI/u.path[1:]).read_bytes(),mime+"; charset=utf-8")
        elif u.path in ("/assets/brand-logo.png","/assets/brand-logo.mp4"):
            mime="image/png" if u.path.endswith(".png") else "video/mp4"
            self.send_data(200,(UI/u.path.lstrip("/")).read_bytes(),mime)
        elif u.path=="/demo.html" and (ROOT/"Demo_Namuna.html").is_file():
            self.send_data(200,(ROOT/"Demo_Namuna.html").read_bytes(),"text/html; charset=utf-8")
        elif u.path.startswith("/download/") and u.path.endswith(".html"):
            ticket = u.path[len("/download/"):-len(".html")]
            with CACHE_LOCK:
                item = EXPORT_CACHE.get(ticket)
            if item and time.monotonic()-item[0] < 300:
                self.send_data(200,item[1],"text/html; charset=utf-8",item[2])
            else:
                self.reply({"error":"Yuklash muddati tugagan. HTMLni qayta saqlang."},404)
        elif u.path=="/api/image":
            try:
                ticket=parse_qs(u.query).get("ticket",[""])[0]
                index=int(parse_qs(u.query).get("index",["-1"])[0])
                src=source_for_ticket(ticket)
                if not 0<=index<len(src["photos"]):raise engine.Problem("image_index","Rasm topilmadi.",404)
                data,mime=engine.source_image_bytes(src,src["photos"][index])
                self.send_data(200,data,mime)
            except (ValueError,engine.Problem) as error:
                self.reply({"error":str(error)},422)
        else:self.reply({"error":"Sahifa topilmadi."},404)

    def do_POST(self):
        if not self.allowed_host() or not self.allowed_origin() or self.headers.get("X-Kartochka-Studio")!="1":
            self.reply({"code":"origin","error":"Generatorni ishga tushiruvchi fayl orqali oching."},403);return
        if self.headers.get_content_type()!="application/json":
            self.reply({"error":"JSON so‘rovi kerak."},415);return
        if not MAX_JOBS.acquire(blocking=False):
            self.reply({"error":"Boshqa so‘rov yakunlanishini kuting."},429);return
        try:
            size=int(self.headers.get("Content-Length","0"))
            limit = MAX_EXPORT+150000 if urlsplit(self.path).path=="/api/export" else 64000
            if size<=0 or size>limit:raise engine.Problem("request_size","So‘rov hajmini tekshiring.")
            body=json.loads(self.rfile.read(size))
            if not isinstance(body,dict):raise engine.Problem("input","So‘rov noto‘g‘ri.")
            self.process(body)
        except engine.Problem as error:
            self.reply({"code":error.code,"error":error.message},error.status)
        except (ValueError,TypeError,UnicodeError):
            self.reply({"code":"input","error":"Kiritilgan qiymatlarni tekshiring."},400)
        except Exception:
            self.reply({"code":"server","error":"So‘rov bajarilmadi. Kiritilgan ma’lumotlarni tekshirib qayta boshlang."},500)
        finally:
            MAX_JOBS.release()

    def process(self,b):
        route=urlsplit(self.path).path
        if route=="/api/models":
            self.reply({"models":engine.available_models(b.get("key",""))})
        elif route=="/api/export":
            path=cache_export(b.get("html"),b.get("product_id"))
            self.reply({"download":path})
        elif route in ("/api/source","/api/web-source","/api/manual"):
            mode=b.get("source_mode","uzum")
            if mode not in ("uzum","external"):
                raise engine.Problem("source_mode","Manba oynasini tekshiring.")
            importer=external_source if mode=="external" else engine
            link=external_source.parse_link(b.get("url","")) if mode=="external" else engine.parse_product_link(b.get("url",""))
            if route=="/api/manual":
                source=importer.manual_source(link,b.get("title",""),b.get("description",""))
            elif route=="/api/web-source":
                source=importer.web_source(link,b.get("key",""),engine.selected_model(b.get("model")))
            else: source=importer.direct_source(link)
            if not source:
                raise engine.Problem("source_missing","Ushbu havoladan mahsulotga tegishli yetarli matn olinmadi.",422)
            ticket=cache_source(source)
            self.reply({"ticket":ticket,"source":source})
        elif route in ("/api/generate","/api/product-photo"):
            source=source_for_ticket(b.get("ticket",""))
            mode=b.get("source_mode","uzum")
            if mode!=source.get("mode","uzum"):
                raise engine.Problem("source_mismatch","Manba oynasi o‘zgardi. Yangi havolani o‘qing.",409)
            expected=external_source.parse_link(b.get("url","")) if mode=="external" else engine.parse_product_link(b.get("url",""))
            if (expected["url"]!=source["url"] if mode=="external" else (expected["id"],expected["sku"])!=(source["id"],source["sku"])):
                raise engine.Problem("source_mismatch","Havola o‘zgardi. Yangi manbani o‘qing.",409)
            model=engine.selected_model(b.get("model"))
            if route=="/api/product-photo":
                if b.get("images_enabled") is False:
                    raise engine.Problem("images_disabled","Rasm tayyorlash o‘chirilgan. Surat uchun API so‘rovi bajarilmadi.",409)
                self.reply(engine.product_photo(source,b.get("key",""),model))
            else:
                result=engine.generate(source,b.get("key",""),b.get("preset",""),b.get("extra",""),b.get("seo") is True,model,b.get("options"),b.get("variants"),b.get("image_settings"))
                self.reply({"card":result})
        else:self.reply({"error":"Yo‘nalish topilmadi."},404)


def main():
    parser=argparse.ArgumentParser(description="SellerSmart kartochka generatori")
    parser.add_argument("--no-browser",action="store_true")
    parser.add_argument("--port",type=int,default=8765)
    parser.add_argument("--host",default="127.0.0.1",help="listen address (0.0.0.0 inside a container)")
    args=parser.parse_args()
    if args.host!="127.0.0.1":
        args.no_browser=True
        try:server=Server((args.host,args.port),Handler)
        except OSError as error:sys.exit(f"Port {args.port}: {error}")
    else:
        try:server=Server(("127.0.0.1",args.port),Handler)
        except OSError:server=Server(("127.0.0.1",0),Handler)
    url=f"http://127.0.0.1:{server.server_address[1]}/"
    print("SellerSmart: "+url,flush=True)
    print("To'xtatish uchun oynani yoping yoki Ctrl+C bosing.",flush=True)
    if not args.no_browser:
        threading.Timer(.35,lambda:webbrowser.open(url)).start()
    try:server.serve_forever()
    except KeyboardInterrupt:pass
    finally:server.server_close()


if __name__=="__main__":
    main()

