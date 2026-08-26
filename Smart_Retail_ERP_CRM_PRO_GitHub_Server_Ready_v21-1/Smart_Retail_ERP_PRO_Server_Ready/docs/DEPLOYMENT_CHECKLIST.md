# Production checklist

- [ ] Private GitHub repository created and owner access verified.
- [ ] Node.js 24 or Docker Engine with Docker Compose is available.
- [ ] Domain A record points to the target VPS.
- [ ] TCP ports 80 and 443 are open; SQLite is not exposed publicly.
- [ ] `.env` exists only on the server and is readable only by the service user.
- [ ] `ADMIN_PASSWORD` is long, random and different from legacy ERP passwords.
- [ ] `APP_ORIGIN` exactly matches the final HTTPS origin.
- [ ] `SECURE_COOKIES=1` and `TRUST_PROXY=1` are set behind HTTPS proxy.
- [ ] SSH host key is verified before GitHub Actions secrets are configured.
- [ ] `npm run verify` or GitHub Actions CI completes successfully.
- [ ] `/api/health` responds with `{ "ok": true }`.
- [ ] Unauthenticated `/api/v1/state` returns HTTP 401.
- [ ] Login succeeds and an administrator can create a customer and debt.
- [ ] Partial payment reduces the balance and creates an audit entry.
- [ ] Re-opening the browser restores the server-backed data.
- [ ] SQLite backup is created and a restore procedure has been tested.
- [ ] Legacy default internal ERP password is changed after first login.
