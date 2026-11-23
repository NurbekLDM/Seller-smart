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
