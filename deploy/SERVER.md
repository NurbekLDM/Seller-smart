# SmartSeller: Supabase cloud → o'z serverimiz

Natija: bitta serverda **self-hosted Supabase** (ichida Postgres 17, Auth, PostgREST, Realtime)
va **SmartSeller sayti + /api**, oldida Caddy (HTTPS). Hammasi bitta domenda:
`https://DOMEN` — sayt, `https://DOMEN/auth/v1`, `/rest/v1`, `/realtime/v1` — Supabase API.
Postgres, Studio va gateway internetga ochilmaydi (faqat 127.0.0.1).

| Fayl | Vazifasi |
| --- | --- |
| `server/index.mjs` | Vercel o'rnini bosadi: `public/`, `vercel.json` sarlavhalari, `middleware.js` himoyasi, `/api/staff`, `/api/admin/users` |
| `deploy/install.sh` | Serverga Docker + Supabase o'rnatadi, `.env` ni sozlaydi, stackni ishga tushiradi |
| `deploy/docker-compose.smartseller.yml` | Supabase compose ustiga: `app` (Node) va `caddy` servislari |
| `deploy/Caddyfile` | HTTPS va marshrutlar |
| `deploy/migrate/dump.sh` | Cloud bazadan schema + ma'lumot + foydalanuvchilarni oladi |
| `deploy/migrate/restore.sh` | Yangi serverga bitta tranzaksiyada yuklaydi va qatorlar sonini solishtiradi |

## Talablar

- Ubuntu 22.04/24.04 (yoki Debian), kamida **4 GB RAM** (kam bo'lsa skript swap qo'shadi), 30 GB disk.
- Domen: A yozuvi server IP'siga qaratilgan bo'lsin, 80 va 443 portlar ochiq.

## 1. Serverni tayyorlash

```sh
ssh root@SERVER_IP
apt-get update && apt-get install -y git
git clone <repo-manzili> /opt/smartseller/app
sudo sh /opt/smartseller/app/deploy/install.sh --domain DOMEN --email admin@DOMEN
```

Tekshirish: `sh /opt/smartseller/supabase/run.sh status` — hamma servis `healthy`.
`https://DOMEN` login sahifasiga yo'naltirishi kerak (hali foydalanuvchi yo'q).

## 2. Ko'chirishdan oldin (muhim)

Supabase manzili o'zgarganda brauzer eski keshni, jumladan **yuborilmagan o'zgarishlarni**
o'chiradi. Shuning uchun:

1. Foydalanuvchilarga ~30 daqiqalik tanaffusni oldindan e'lon qiling (kechasi yaxshi).
2. Ko'chirish boshlanganda hamma ishni to'xtatsin, sinxron belgisi "Baza bilan ulangan" bo'lsin.

## 3. Ma'lumotni ko'chirish

Cloud parolini olish: Supabase dashboard → **Connect → Session pooler** connection string.
Serverda (parol buyruq tarixiga tushmasligi uchun faylga yozamiz):

```sh
cd /opt/smartseller/app
printf "SOURCE_DB_URL='%s'\n" 'postgresql://postgres.letiuzajzqejyndopwma:PAROL@HOST:5432/postgres' > deploy/migrate/.env
chmod 600 deploy/migrate/.env
sh deploy/migrate/dump.sh /root/sr-dump
cat /root/sr-dump/info.txt            # ko'rib chiqing
sudo sh deploy/migrate/restore.sh /root/sr-dump
```

`restore.sh` oxirida har bir jadval uchun `ok` chiqishi kerak. Xato bo'lsa hech narsa
yozilmaydi (bitta tranzaksiya) — xatoni ko'rib, qayta ishga tushirish mumkin.

## 4. Tekshirish

- Eski email/parol bilan kirish ishlaydi (parol xeshlari ko'chadi, hamma bir marta qayta kiradi).
- Ma'lumotlar joyida; ikki qurilmada o'zgarish bir-biriga yetib boradi (Realtime).
- `/admin` sahifasi foydalanuvchilar ro'yxatini ko'rsatadi; ERP "Xodimlar" ekranida xodim qo'shish ishlaydi.

## 5. Yakunlash

- Agar eski domen Vercel'da bo'lsa: domenning DNS yozuvini serverga o'tkazing, Vercel loyihasini to'xtating.
- Cloud Supabase loyihasini darhol o'chirmang — 1–2 hafta zaxira sifatida qoldiring.
- Dump papkasini o'chiring: `rm -rf /root/sr-dump deploy/migrate/.env` (ichida parol xeshlari bor).
- Zaxira: `/opt/smartseller/supabase/.env` (sirlar) va har kungi `pg_dump` — keyingi qadam.

## Yangilash

```sh
cd /opt/smartseller/app && git pull
sh /opt/smartseller/supabase/run.sh restart app
```

Studio (baza paneli): `ssh -L 8000:127.0.0.1:8000 root@SERVER_IP`, so'ng `http://localhost:8000`
(login/parol: `sh /opt/smartseller/supabase/run.sh secrets`).

## ERP 119.3 (erp.<domen>) — server bilan sinxron

ERP 119.3 endi o'z ma'lumotini serverda saqlaydi: kirish SellerSmart hisobi bilan
(email yoki xodim logini), har bir o'zgarish serverga yuboriladi, boshqa qurilmada
ochilganda ko'rinadi. Eski ERP (`sellersmart.uz/erp`) ga tegilmaydi: 119.3 alohida
jadvalda (`erp119_kv`), birinchi ochilishda eski ERP ma'lumoti unga bir marta nusxalanadi.

Birinchi marta yoqish (bir marta):

```sh
cd /opt/smartseller/app && git pull
docker exec -i supabase-db psql -X -U supabase_admin -d postgres -v ON_ERROR_STOP=1 \
  < supabase/2026-11-27-erp119-kv.sql
# "start" (docker compose up -d): app konteyneri yangi ERP119_HOST bilan qayta yaratiladi.
# "restart" bu yerda yetmaydi — u konteynerni eski sozlamasi bilan qayta yoqadi.
sh /opt/smartseller/supabase/run.sh start
sh /opt/smartseller/supabase/run.sh restart caddy
```

Qanday ishlaydi (batafsil: `erp119/sync.js`, `server/erp119.mjs`):

- Sahifa ochilishi: hisob tekshiriladi → serverdan ma'lumot yuklanadi → ERP ochiladi.
  Internet bo'lmasa, qurilmadagi oxirgi nusxa bilan ochiladi.
- Yozish: o'zgargan kalit ~1 soniyada serverga ketadi. Internet yo'q bo'lsa navbatda
  turadi (sahifa yopilsa ham), internet qaytganda o'zi yuboriladi.
- Ikki qurilma bir ro'yxatni o'zgartirsa (masalan, ikkalasi mahsulot qo'shsa), yozuvlar
  `id` bo'yicha birlashtiriladi. Bir yozuvni ikkalasi o'zgartirsa, oxirgi yuborgan
  qurilmaniki qoladi; eski qiymat `erp119_kv_history` da saqlanadi (har kalitga 10 ta).
- Pastki chap burchakdagi belgi holatni ko'rsatadi: "Serverda saqlangan",
  "Yuborilmoqda", "Internet yo'q — navbatda: N", yoki "Boshqa qurilmada o'zgarish bor —
  yangilash". Uni bossangiz: hozir yuborish, serverdan qayta yuklash, chiqish.
- Sinxronlanmaydi: asl import fayllari (faqat import qilingan qurilmada). Chat esa
  serverda (pastdagi bo'limga qarang).
- Asl 119.3 fayli (`releases/sellersmart-erp-119.3/`) o'zgartirilmaydi; server uni
  ochishda adapterni ulaydi. Yangi versiya kelsa, faylni almashtirib `npm run check`
  ni ishga tushiring: ulash nuqtalari topilmasa, test xato beradi.

## Servislar, xodimlar, chat va audit (2026-11-28)

Bir marta yoqish:

```sh
cd /opt/smartseller/app && git pull
docker exec -i supabase-db psql -X -U supabase_admin -d postgres -v ON_ERROR_STOP=1   < supabase/2026-11-28-erp119-team.sql
# app konteyneri yangi APP_DOMAIN o'zgaruvchisi bilan qayta yaratiladi:
sh /opt/smartseller/supabase/run.sh start
sh /opt/smartseller/supabase/run.sh restart caddy
```

Migratsiyani qayta ishga tushirsa bo'ladi (ma'lumot o'chmaydi).

**Admin panel (`/admin`)**

- "Servislar" ustuni: har hisob uchun ERP / Analitika / Diet / Kartochka — holat
  (ochiq/bloklangan), boshlanish va tugash sanasi, izoh. Tugmani bosib o'zgartiriladi.
  "Standart qoida": ERP va Analitika — "Mahsulotlar" ustuni bo'yicha; Diet va
  Kartochka — yopiq.
- Xodim hisobi egasining servis muddatidan foydalanadi.
- "Audit jurnali": hisob yaratish/o'zgartirish/o'chirish, parol almashtirish (parolning
  o'zi yozilmaydi), servis ruxsati, xodimlar, ERP zaxiradan tiklash, servisga kirish.

**Foydalanuvchi kabineti (`/app.html`)** — "Mening servislarim": 4 ta servis, holati va
muddati, "Ochish" tugmasi.

**Kartochka Studio** endi parol bilan emas, SellerSmart hisobi bilan ochiladi: avval
`/admin` da hisobga "Kartochka" ni yoqing. Kirish `sr-svc` imzolangan cookie (12 soat)
orqali, ruxsat har daqiqada qayta tekshiriladi — bloklansa yoki muddat tugasa, ko'pi
bilan 1 daqiqada yopiladi. **Diet Seller** — `https://<domen>/diet` (shu qoida bilan).

**ERP 119.3 xodimlari**

- ERP ichida xodim qo'shilganda (egasi hisobidan) unga SellerSmart xodim hisobi
  avtomatik yaratiladi: login = ERP logini, parol = ERP da kiritilgan parol. Bloklansa,
  SellerSmart hisobi ham faolsiz qilinadi.
- Xodim `erp.<domen>` ga o'z logini bilan kiradi va ERP da **o'z roli va ruxsatlari**
  bilan ochiladi (admin bo'lib emas).
- Server himoyasi: xodim xodimlar ro'yxatini va maydon ruxsatlarini o'zgartira olmaydi,
  audit jurnaliga faqat qo'sha oladi (o'chira/qayta yoza olmaydi).

**Online chat** — serverda (`erp119_chat_state`, fayllar `erp119_chat_files`, 10 MB gacha:
PNG/JPG/WEBP/PDF/XLSX/CSV/TXT). Hamma qurilmada bir xil, yangi xabar boshqa qurilmaga
darhol keladi. Brauzerdagi eski chat birinchi ochilishda serverga bir marta ko'chiriladi.

**Zaxiradan tiklash** — ERP dagi "Server tiklash" endi haqiqiy: faqat egasi; eski
ma'lumot `erp119_kv_archive` ga saqlanadi; tiklangandan keyin boshqa qurilmalardagi
eski (yuborilmagan) o'zgarishlar serverga yozilmaydi — sahifa yangilashni so'raydi.

**Cheklov:** ERP ichidagi qator/maydon darajasidagi ruxsatlar (qaysi ombor, qaysi
ustun) brauzerda ERP o'zi tomonidan qo'llanadi. Server faqat yuqoridagi kalit darajasidagi
qoidalarni majburlaydi: texnik bilimli xodim REST orqali workspace ma'lumotini o'qiy oladi.
