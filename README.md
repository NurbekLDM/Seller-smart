# SellerSmart

Uzum sotuvchilari uchun SellerSmart mahsulotlari — bitta repoda.

| Papka | Nima | Holati |
| --- | --- | --- |
| `public/`, `src/`, `scripts/`, `api/`, `middleware.js`, `supabase/` | **Smart Retail — Analitika + ERP** (sellersmart.uz). Supabase login, sinxron baza, admin va xodimlar | Serverda ishlayapti |
| `server/` | Node server: `public/`, himoya (middleware) va `/api` ni beradi (Vercel o'rnida) | Serverda ishlayapti |
| `deploy/` | Server o'rnatish (self-hosted Supabase + Caddy), ma'lumot ko'chirish skriptlari. Yo'riqnoma: [deploy/SERVER.md](deploy/SERVER.md) | Ishlatilgan |
| `kartochka-studio/` | **Kartochka Studio v6** — Uzum/boshqa sayt havolasidan UZ/RU kartochka (Python, OpenAI). Serverda `kartochka.<domen>` da, parol bilan | Yangi |
| `releases/smart-retail-v118/` | Ishlab chiquvchidan kelgan **v118**: Analitika va ERP alohida HTML fayllar + tekshiruv skriptlari | Hali saytga ulanmagan |
| `releases/sellersmart-erp-119.3/` | **SellerSmart ERP 119.3** — alohida (offline) ERP HTML. Serverda `erp.<domen>` da, Kartochka bilan bir xil parol | Yangi |
| `releases/android/` | **SellerSmart ERP 119.2** Android APK | Tayyor fayl |
| `releases/diet-seller/` | **DIET SELLER 2.0** — alohida ilova (ovqatlanish kundaligi), HTML va APK | Tayyor fayl |

## Ishlab turgan sayt

`src/app.html` — manba (birlashgan Analitika + ERP). `npm run build` undan `public/index.html`
va `public/erp.html` ni yasaydi va Supabase login/sinxronni qo'shadi. Tekshiruv: `npm run check`.

Serverda yangilash:

```sh
cd /opt/smartseller/app && git pull
sh /opt/smartseller/supabase/run.sh restart app kartochka caddy
```

## v118 haqida

v118 da Analitika va ERP ikki alohida HTML faylga ajratilgan. Ular hali Supabase'ga
ulanmagan (ishlab chiquvchining `BOSHLASH_VA_IT_v118.txt` faylida ham shunday yozilgan).
Saytdagi versiya esa `src/app.html` asosida va unda jamoaning o'z o'zgarishlari bor.
v118 ni saytga o'tkazish — alohida ish: build skriptini ikki faylga moslash va
jamoaning o'zgarishlarini ko'chirish kerak.
