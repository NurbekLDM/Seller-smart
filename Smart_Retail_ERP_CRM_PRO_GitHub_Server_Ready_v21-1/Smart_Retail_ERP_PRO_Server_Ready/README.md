# Smart Retail ERP 21 · CRM PRO

Uzum Analytics 2026 va Smart Retail ERP birgalikda ishlaydigan, mijozlar bazasi,
qarzdorlik, POS savdo, ombor va moliya uchun tayyor loyiha.

## Dastur nimalarni bajaradi

- Mijoz kartochkasi: kontaktlar, Telegram, email, manzil, segment, kredit limiti,
  individual qarz muddati, xarid tarixi va ichki eslatmalar.
- Qarzdorlik reestri: hujjat raqami, qarz sanasi, qaytarish muddati, boshlang‘ich
  to‘lov, joriy qoldiq, kechikish va limit nazorati.
- To‘lovlar: qisman yoki to‘liq yopish, to‘lov usuli, hujjat raqami, xodim va
  vaqt belgisi; administrator tomonidan nazoratli bekor qilish.
- Qarz yoshi: muddatida, 1–7, 8–30, 31–60 va 60 kundan oshgan guruhlar.
- POS integratsiyasi: faol mijoz, umumiy ochiq qarz, kredit limiti va individual
  qaytarish muddati tekshiriladi.
- CSV/Excel import va eksport; mijozning takroriy telefoni bloklanadi.
- Uzum analitika ma’lumotlari va ERP ma’lumotlari bir server snapshotiga saqlanadi.
- SQLite bazasi, normalizatsiya qilingan CRM jadvallari, xavfsiz sessiya, CSRF,
  scrypt parol xeshi, audit, Docker, HTTPS va GitHub Actions.

## Tez ishga tushirish

Node.js **24 yoki yangi** kerak.

```bash
cp .env.example .env
```

`.env` faylida `ADMIN_PASSWORD` ni kamida 16 belgili tasodifiy parolga
almashtiring. Lokal HTTP sinovi uchun `NODE_ENV=development`, `TRUST_PROXY=0`
va `SECURE_COOKIES=0` qiling. So‘ng:

```bash
npm ci
npm run verify
npm start
```

Brauzerda `http://127.0.0.1:8080` manzilini oching. Server logini `.env`
faylidagi `ADMIN_USERNAME` va `ADMIN_PASSWORD` bo‘yicha ishlaydi.

Mustaqil ishlatish uchun `public/index.html` faylini brauzerda ochish mumkin.
Bunda ma’lumotlar foydalanuvchi qurilmasida saqlanadi; server sinxronizatsiyasi
faqat server orqali kirilganda ishlaydi.

Original HTML faylidagi amaldagi administrator ma’lumotlari saqlangan:
`Admin` / `1128772`. Server versiyasi uchun `.env` ichidagi alohida, kuchli
parol ishlatiladi. Production’da ichki standart parolni ham almashtiring.

## Serverga joylash

VPS’da Docker Engine va Docker Compose o‘rnatilgan bo‘lishi kerak. Domenning A
yozuvi VPS IP manziliga qaratiladi, 80 va 443 portlar ochiq bo‘ladi.

```bash
cp .env.example .env
openssl rand -base64 32
```

`.env` ichida haqiqiy `APP_DOMAIN`, `APP_ORIGIN` va kuchli `ADMIN_PASSWORD`
qiymatlarini belgilang:

```dotenv
APP_DOMAIN=erp.example.uz
APP_ORIGIN=https://erp.example.uz
ADMIN_USERNAME=Admin
ADMIN_PASSWORD=BU_YERGA_UZUN_TASODIFIY_PAROL
SECURE_COOKIES=1
TRUST_PROXY=1
```

Ishga tushirish:

```bash
docker compose --profile public up -d --build
docker compose ps
curl --fail http://127.0.0.1:8080/api/health
```

Caddy domen uchun TLS sertifikatini avtomatik oladi. SQLite bazasi
`retail_data` nomli Docker volume ichida qoladi.

Nginx ishlatilsa, `deploy/nginx/smart-retail.conf`; Docker ishlatilmasa,
`deploy/smart-retail.service` namunalaridan foydalaning.

## GitHub’ga ulash

GitHub’da bo‘sh private repository oching va uning URL manzilini kiriting:

```bash
bash scripts/publish-github.sh https://github.com/ACCOUNT/smart-retail-erp.git
```

GitHub autentifikatsiyasi foydalanuvchining SSH kaliti yoki Personal Access Token
orqali bajariladi. `.env`, ma’lumotlar bazasi va backup fayllari `.gitignore`
bilan avtomatik chiqarib tashlanadi.

`main` branchiga push qilinganda `.github/workflows/ci.yml` sintaksis, API
sinovlari va Docker build’ni tekshiradi. Serverga deployment qo‘lda
**Actions → Deploy Smart Retail ERP → Run workflow** orqali boshlanadi.

Production environment uchun GitHub secrets:

| Secret | Qiymat |
| --- | --- |
| `DEPLOY_HOST` | Server IP yoki domen |
| `DEPLOY_USER` | Server SSH foydalanuvchisi |
| `DEPLOY_PATH` | Masalan, `/opt/smart-retail-erp` |
| `DEPLOY_SSH_KEY` | SSH private key |
| `DEPLOY_KNOWN_HOSTS` | `ssh-keyscan -H SERVER_IP` natijasi |

Serverdagi `.env` fayli birinchi deploymentdan oldin qo‘lda yaratiladi va hech
qachon GitHub’ga yuborilmaydi.

## Backup

```bash
bash scripts/backup.sh
```

SQLite `VACUUM INTO` orqali tranzaksion backup olinadi. Backupni alohida server
yoki shifrlangan storage’ga ko‘chiring. Tiklashdan oldin servisni to‘xtatib,
backup faylni asosiy SQLite fayl o‘rniga joylashtiring.

## API

| Amal | Endpoint |
| --- | --- |
| Health check | `GET /api/health` |
| Login | `POST /api/v1/auth/login` |
| Joriy sessiya | `GET /api/v1/auth/me` |
| Server snapshot | `GET /api/v1/state` |
| Snapshot saqlash | `PUT /api/v1/state` |
| Mijozlar | `GET /api/v1/customers`, `POST /api/v1/customers` |
| Mijozni tahrirlash | `PATCH /api/v1/customers/:id` |
| Qarzdorlik | `GET /api/v1/debts`, `POST /api/v1/debts` |
| Qarz shartlari | `PATCH /api/v1/debts/:id` |
| To‘lov qabul qilish | `POST /api/v1/debts/:id/payments` |
| To‘lov tarixi | `GET /api/v1/payments` |
| KPI | `GET /api/v1/dashboard` |
| Audit | `GET /api/v1/audit` |

Yozuvchi API so‘rovlarida server session cookie va `X-CSRF-Token` majburiy.
Snapshot optimistic versioning ishlatadi: boshqa qurilma oldin saqlagan bo‘lsa,
`409 Conflict` qaytadi va ma’lumotlar jimgina ustidan yozilmaydi.

## Cheklovlar

- Bootstrap dialoglari, jadvallar va grafiklar uchun ichki offline fallback bor.
  Haqiqiy Excel `.xlsx`, QR-kod, kamera skaneri va PDF eksport kutubxonalari
  original loyihadagi CDN’dan yuklanadi; internet bo‘lmasa CRM CSV eksporti
  ishlaydi, qolgan ilg‘or eksportlar uchun kutubxonalarni vendor qilish kerak.
- Eski ichki ERP foydalanuvchi boshqaruvi original modul tarkibida qolgan.
  Production serverning haqiqiy tashqi kirish himoyasi `.env` orqali berilgan
  server administrator paroli bilan ta’minlanadi.
- Tayyor loyiha GitHub account, VPS, domen va SSH kalitlarini o‘zi yaratmaydi;
  ular loyiha egasi tomonidan beriladi.
