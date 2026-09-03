/* Shared employee-management bridge for the ERP's native "Employees"
   screen. The same ERP HTML runs in THREE contexts:
     1. the standalone /erp.html page        (erp-page.js calls install)
     2. the iframe inside the platform page  (auth-guard.js injects this)
     3. the "open in new window" blob popup  (auth-guard.js injects this)
   In every context the vendor's own save path only writes to browser
   storage — accounts "created" there never exist in Supabase and can
   never log in. This bridge overrides the vendor's save/delete handlers
   to call /api/staff instead, and reconciles the local users list from
   the real accounts.

   window.smartRetailInstallStaffBridge(resolveHost) installs the
   overrides in the CURRENT window and returns reconcile(). resolveHost
   is a function returning { client, origin, syncReady } — the Supabase
   client and site origin of whichever window owns the session (self for
   erp.html, parent for the iframe, opener for the popup), plus whether
   that window's workspace restore has landed — or null if the window is
   unreachable, in which case saves fail with a clear message instead of
   silently writing browser-only accounts. */
(function smartRetailStaffBridge() {
  'use strict';

  /* Every ERP 26 screen registers itself in AUTH_V12_VIEWS — the list the
     Employees screen builds its permission checkboxes from — except
     "Sotuvlar tarixi" (sales history), which only pushes itself into the
     built-in POS role. Our staff accounts are always role CUSTOM with an
     explicit permission array, so without a checkbox the owner has no way
     to grant it and the screen is invisible to every employee. Register
     it the same way the vendor's other modules do; switchView/authCanView
     then honour it with no further changes. */
  function registerSalesHistoryPermission() {
    try {
      if (typeof AUTH_V12_VIEWS === 'undefined' || !Array.isArray(AUTH_V12_VIEWS)) return false;
      // Only offer it once the module that owns the screen has installed.
      if (!document.getElementById('view-saleshistory')) return false;
      if (AUTH_V12_VIEWS.some(function (view) { return view && view.id === 'saleshistory'; })) return true;
      var after = AUTH_V12_VIEWS.findIndex(function (view) { return view && view.id === 'pos'; });
      AUTH_V12_VIEWS.splice(after < 0 ? AUTH_V12_VIEWS.length : after + 1, 0, {
        id: 'saleshistory',
        label: 'Sotuvlar tarixi',
        desc: 'Buyurtma, to‘lov va qaytarishlar tarixi'
      });
      return true;
    } catch (_) { return false; }
  }

  // The sales-history module installs at its own DOMContentLoaded, which
  // may land after this file's; poll briefly rather than racing it.
  function armSalesHistoryPermission() {
    var attempts = 0;
    (function attempt() {
      if (registerSalesHistoryPermission()) return;
      attempts += 1;
      if (attempts < 40) window.setTimeout(attempt, 250);
    })();
  }

  window.smartRetailInstallStaffBridge = function (resolveHost) {
    if (window.__srEmployeeHookInstalled) {
      /* Installed already - but the ERP's own scripts may have run SINCE.
         On /erp.html they are inert until the workspace is fetched
         (erp-page.js executes them well after DOMContentLoaded), and each
         declares authSaveUser / authDeleteUser / authOpenUserModal as a
         global function, which replaces the overrides below. Put them
         back. Found 2026-09-03: a new owner's "create employee" went to
         the vendor's browser-only save, and the next reconcile erased it,
         so nothing was ever created. */
      if (typeof window.__srStaffBridgeApply === 'function') window.__srStaffBridgeApply();
      return window.__srStaffBridgeReconcile || null;
    }
    window.__srEmployeeHookInstalled = true;

    try {
      var style = document.createElement('style');
      style.textContent = '#authUsersTable tbody tr{cursor:pointer}#authUsersTable tbody tr:hover{background:rgba(255,255,255,.04)}';
      document.head.appendChild(style);
    } catch (_) { /* cosmetic only */ }

    function host() {
      var resolved = null;
      try { resolved = resolveHost(); } catch (_) { /* host window gone */ }
      if (!resolved || !resolved.client) {
        throw new Error('Sessiya topilmadi — ERP’ni asosiy oynadan qayta oching.');
      }
      return resolved;
    }

    function apiRequest(method, body) {
      var target;
      try { target = host(); } catch (error) { return Promise.reject(error); }
      return target.client.auth.getSession().then(function (result) {
        var current = result.data && result.data.session;
        if (!current) throw new Error('Sessiya tugagan — qayta kiring.');
        return fetch(target.origin + '/api/staff', {
          method: method,
          headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + current.access_token },
          body: body ? JSON.stringify(body) : undefined
        }).then(function (response) {
          return response.json().catch(function () { return {}; }).then(function (payload) {
            if (!response.ok) throw new Error(payload.error || ('HTTP ' + response.status));
            return payload;
          });
        });
      });
    }

    function toLocalRecord(member) {
      var perms = Array.isArray(member.erp_modules) && member.erp_modules.length ? member.erp_modules : ['pos'];
      return {
        id: member.id,
        username: member.login,
        password: '',
        fullName: member.name || member.login,
        role: 'CUSTOM',
        permissions: perms,
        landing: perms[0],
        active: member.active,
        protected: false,
        createdAt: member.created_at || new Date().toISOString(),
        lastSignInAt: member.last_sign_in_at || ''
      };
    }

    function esc(value) {
      return String(value == null ? '' : value).replace(/[&<>"']/g, function (c) {
        return ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c];
      });
    }
    function moduleLabel(id) {
      try { if (typeof authV12ViewLabel === 'function') return authV12ViewLabel(id); } catch (_) { /* ignore */ }
      return id;
    }

    // Read-only details view for one row — the vendor's own "edit" modal
    // is for changing login/permissions, not for glancing at status/last
    // sign-in, so this is a separate, lighter overlay.
    function closeEmployeeDetails() {
      var existing = document.getElementById('srEmployeeDetails');
      if (existing) existing.remove();
    }
    function showEmployeeDetails(user) {
      closeEmployeeDetails();
      var isAdmin = user.role === 'ADMIN' || user.protected;
      var modules = Array.isArray(user.permissions) ? user.permissions : [];
      var chips = isAdmin
        ? '<span style="color:#5fd98c;font-weight:700">Barcha bo‘limlar</span>'
        : (modules.length
          ? modules.map(function (id) {
              return '<span style="display:inline-flex;padding:3px 9px;margin:2px 4px 0 0;border-radius:999px;background:rgba(105,97,250,.15);color:#9b93ff;font-size:11px;font-weight:700">' + esc(moduleLabel(id)) + '</span>';
            }).join('')
          : '<span style="color:#ff8c8c">Ruxsat yo‘q</span>');
      var overlay = document.createElement('div');
      overlay.id = 'srEmployeeDetails';
      overlay.style.cssText = 'position:fixed;inset:0;z-index:100000;display:flex;align-items:center;justify-content:center;background:rgba(5,9,18,.6)';
      overlay.innerHTML =
        '<div style="width:min(420px,92vw);padding:20px;border-radius:16px;border:1px solid rgba(255,255,255,.14);background:#0d1628;color:#e8eef9;font:13px -apple-system,\'Segoe UI\',sans-serif;box-shadow:0 24px 70px rgba(0,0,0,.5)">' +
          '<div style="display:flex;justify-content:space-between;align-items:flex-start;margin-bottom:14px">' +
            '<div><div style="font-size:16px;font-weight:800">' + esc(user.fullName || user.username) + '</div>' +
            '<div style="color:#8ea0bd;font-size:12px;margin-top:2px">Login: <span style="font-family:monospace">' + esc(user.username) + '</span></div></div>' +
            '<button id="srEmployeeDetailsX" style="border:0;background:none;color:#8ea0bd;font-size:18px;cursor:pointer;line-height:1">✕</button>' +
          '</div>' +
          '<div style="display:grid;gap:12px">' +
            '<div><div style="color:#8ea0bd;font-size:11px;margin-bottom:4px">Holat</div>' +
              (user.active ? '<span style="color:#5fd98c;font-weight:700">Faol</span>' : '<span style="color:#ff8c8c;font-weight:700">Bloklangan</span>') + '</div>' +
            '<div><div style="color:#8ea0bd;font-size:11px;margin-bottom:4px">Ruxsat berilgan bo‘limlar</div><div>' + chips + '</div></div>' +
            '<div><div style="color:#8ea0bd;font-size:11px;margin-bottom:4px">Oxirgi kirish</div>' + (user.lastSignInAt ? esc(new Date(user.lastSignInAt).toLocaleString()) : 'Hali kirmagan') + '</div>' +
            '<div><div style="color:#8ea0bd;font-size:11px;margin-bottom:4px">Yaratilgan</div>' + (user.createdAt ? esc(new Date(user.createdAt).toLocaleString()) : '—') + '</div>' +
          '</div>' +
          '<div style="display:flex;gap:8px;margin-top:18px">' +
            (isAdmin ? '' : '<button id="srEmployeeDetailsEdit" style="flex:1;height:36px;border:0;border-radius:9px;background:linear-gradient(105deg,#6961fa,#3686ef);color:#fff;font-weight:700;cursor:pointer">Tahrirlash</button>') +
            '<button id="srEmployeeDetailsClose" style="flex:1;height:36px;border:1px solid rgba(255,255,255,.18);border-radius:9px;background:transparent;color:#c8d5ea;font-weight:700;cursor:pointer">Yopish</button>' +
          '</div>' +
        '</div>';
      document.body.appendChild(overlay);
      overlay.addEventListener('click', function (event) { if (event.target === overlay) closeEmployeeDetails(); });
      var closeX = document.getElementById('srEmployeeDetailsX');
      var closeButton = document.getElementById('srEmployeeDetailsClose');
      if (closeX) closeX.onclick = closeEmployeeDetails;
      if (closeButton) closeButton.onclick = closeEmployeeDetails;
      var editButton = document.getElementById('srEmployeeDetailsEdit');
      if (editButton) editButton.onclick = function () {
        closeEmployeeDetails();
        if (typeof authOpenUserModal === 'function') authOpenUserModal(user.id);
      };
    }

    // The vendor's sales-tracking "Xodimlar" table (DB_KEYS.employees) has
    // no delete button of its own — it is only ever a mirror, kept by
    // authUserId, of the login accounts that exist. Drop rows whose login
    // no longer exists (deleted staff, or old local-only test accounts
    // created before this bridge existed and never had a real backend).
    function pruneOperationalEmployees(validIds) {
      try {
        if (typeof db_get !== 'function' || typeof db_set !== 'function' || typeof DB_KEYS === 'undefined' || !DB_KEYS.employees) return;
        var rows = db_get(DB_KEYS.employees);
        if (!Array.isArray(rows)) return;
        var pruned = rows.filter(function (row) { return !row.authUserId || validIds.has(row.authUserId); });
        if (pruned.length !== rows.length) {
          db_set(DB_KEYS.employees, pruned);
          try { if (typeof renderEmployees === 'function') renderEmployees(); } catch (_) { /* ignore */ }
        }
      } catch (_) { /* best-effort cleanup */ }
    }

    function syncReady() {
      try {
        var target = resolveHost();
        return !!(target && target.syncReady);
      } catch (_) { return false; }
    }

    function reconcile() {
      return apiRequest('GET').then(function (data) {
        var staff = data.staff || [];
        var kept = (typeof authGetUsers === 'function' ? authGetUsers() : [])
          .filter(function (u) { return u.protected || u.role === 'ADMIN'; });
        staff.forEach(function (member) { kept.push(toLocalRecord(member)); });
        if (typeof authSetUsers === 'function') authSetUsers(kept);
        try { authRenderUserTable(); } catch (_) { /* not rendered yet */ }
        try { if (typeof renderEmployees === 'function') renderEmployees(); } catch (_) { /* ignore */ }
        // Prune only once the host's workspace restore has landed. The
        // rebuilt users list above is never synced, but the pruned table
        // is — pruning first would let the restore write the stale
        // snapshot back over it (a reconcile can be triggered by an
        // Employees click well before the initial restore finishes).
        if (syncReady()) pruneOperationalEmployees(new Set(kept.map(function (u) { return u.id; })));
      }).catch(function (error) { console.warn('Staff list unavailable:', error.message); });
    }

    /* The three overrides, re-applicable: every call puts the bridge's
       handlers back on top of whatever the vendor's scripts declared. */
    function applyOverrides() {
    if (window.authSaveUser && window.authSaveUser.srBridge) return;

    window.authSaveUser = function () {
      var id = document.getElementById('authUserId').value;
      var fullName = document.getElementById('authUserFullName').value.trim();
      var login = document.getElementById('authUserUsername').value.trim().toLowerCase();
      var password = document.getElementById('authUserPassword').value;
      var active = document.getElementById('authUserActive').checked;
      var permissions = (typeof authV12SelectedPermissions === 'function') ? authV12SelectedPermissions() : [];
      if (!fullName || !login) { showToast('Xodim ismi va loginni kiriting', 'bi-x-circle text-danger'); return; }
      if (!permissions.length) { showToast('Kamida bitta bo‘limga ruxsat bering', 'bi-x-circle text-danger'); return; }
      if (!id && !password) { showToast('Yangi xodim uchun parol kiriting', 'bi-x-circle text-danger'); return; }
      if (password && password.length < 8) { showToast('Parol kamida 8 belgidan iborat bo‘lishi kerak', 'bi-x-circle text-danger'); return; }
      var body = id
        ? { action: 'update', id: id, name: fullName, active: active, modules: permissions }
        : { action: 'create', login: login, name: fullName, password: password, modules: permissions };
      if (id && password) body.password = password;
      apiRequest('POST', body).then(function () {
        try { bootstrap.Modal.getInstance(document.getElementById('modalAuthUser'))?.hide(); } catch (_) { /* ignore */ }
        showToast(id ? 'Xodim yangilandi' : 'Yangi xodim yaratildi');
        return reconcile();
      }).catch(function (error) {
        showToast(error.message || 'Xatolik yuz berdi', 'bi-x-circle text-danger');
      });
    };
    window.authSaveUser.srBridge = true;

    window.authDeleteUser = function (id) {
      var users = typeof authGetUsers === 'function' ? authGetUsers() : [];
      var user = users.find(function (u) { return u.id === id; });
      if (!user || user.protected) { showToast('Asosiy administratorni o‘chirib bo‘lmaydi', 'bi-shield-lock text-danger'); return; }
      function performDelete() {
        if (!window.confirm((user.fullName || user.username) + ' loginini o‘chirasizmi?')) return;
        apiRequest('POST', { action: 'delete', id: id }).then(function () {
          showToast('Xodim o‘chirildi', 'bi-trash text-danger');
          return reconcile();
        }).catch(function (error) {
          showToast(error.message || 'Xatolik yuz berdi', 'bi-x-circle text-danger');
        });
      }
      // Keep the vendor's optional admin-PIN gate for this action. It wraps
      // the original authDeleteUser at parse time, so replacing the function
      // outright would silently void a protection the Settings card still
      // advertises — and here the delete is a real, irreversible one.
      if (typeof v14RequirePin === 'function') {
        v14RequirePin('deleteUser', performDelete, user.fullName ? (user.fullName + ' (' + user.username + ')') : id);
      } else {
        performDelete();
      }
    };
    window.authDeleteUser.srBridge = true;

    // The login (== the account's real email prefix) cannot be renamed
    // from here — only the display name and permissions can.
    var baseOpenModal = window.authOpenUserModal;
    if (typeof baseOpenModal === 'function' && !baseOpenModal.srBridge) {
      var openModal = function (id) {
        baseOpenModal(id || '');
        if (id) {
          var usernameEl = document.getElementById('authUserUsername');
          if (usernameEl) usernameEl.disabled = true;
        }
      };
      openModal.srBridge = true;
      window.authOpenUserModal = openModal;
    }
    }
    applyOverrides();
    window.__srStaffBridgeApply = applyOverrides;

    document.addEventListener('click', function (event) {
      var target = event.target;
      if (!target || !target.closest) return;
      if (target.closest('[data-view="employees"], [data-view-link="employees"], [data-bn="employees"]')) {
        // Belt and braces: the screen is about to be used, so make sure
        // the vendor's handlers have not crept back in the meantime.
        window.setTimeout(function () { applyOverrides(); reconcile(); }, 30);
      }
    }, true);

    // Clicking a row (not its action buttons) opens a read-only details
    // view. Row order in the table always matches authGetUsers() order,
    // since authRenderUserTable() builds it straight from that array.
    document.addEventListener('click', function (event) {
      var target = event.target;
      if (!target || !target.closest) return;
      if (target.closest('button, a')) return;
      var row = target.closest('#authUsersTable tbody tr');
      if (!row || !row.parentNode) return;
      var rows = Array.prototype.slice.call(row.parentNode.children);
      var users = typeof authGetUsers === 'function' ? authGetUsers() : [];
      var user = users[rows.indexOf(row)];
      if (user) showEmployeeDetails(user);
    });

    window.__srStaffBridgeReconcile = reconcile;
    return reconcile;
  };

  /* Embedded-context bootstrap: when this window is the platform's ERP
     iframe or the "open in new window" popup, the session lives in the
     PARENT/OPENER window. Install the overrides at DOMContentLoaded (so
     the vendor save can never run first), then run the first reconcile
     only after the host's workspace sync is active — reconciling during
     the initial server restore would let the restore overwrite it.
     The standalone /erp.html page manages install/reconcile timing
     itself in erp-page.js, which sets __srEmployeeHookInstalled first —
     and its own window has smartRetailSupabase, so hostWindow() is null
     there anyway. */
  function hostWindow() {
    try {
      if (!window.smartRetailSupabase && window.parent && window.parent !== window && window.parent.smartRetailSupabase) return window.parent;
    } catch (_) { /* cross-origin parent */ }
    try {
      if (!window.smartRetailSupabase && window.opener && window.opener.smartRetailSupabase) return window.opener;
    } catch (_) { /* opener gone or cross-origin */ }
    return null;
  }

  function hostSyncActive(current) {
    try {
      var sync = current && current.smartRetailAnalyticsServerSync;
      return !!(sync && sync.status && sync.status().active);
    } catch (_) { return false; }
  }

  function embeddedBootstrap() {
    if (window.__srEmployeeHookInstalled) return;
    var initialHost = hostWindow();
    if (!initialHost) return; // standalone page: erp-page.js drives install
    var reconcile = window.smartRetailInstallStaffBridge(function () {
      var current = hostWindow();
      if (!current) return null;
      try {
        return {
          client: current.smartRetailSupabase,
          origin: current.location.origin,
          syncReady: hostSyncActive(current)
        };
      } catch (_) { return null; }
    });
    if (!reconcile) return;
    // First reconcile only after the host's sync engine is active (its
    // initial restore has landed); poll briefly, give up quietly if the
    // host never syncs (reconcile still runs on Employees-screen clicks).
    var waited = 0;
    (function armReconcile() {
      if (hostSyncActive(hostWindow())) { reconcile(); return; }
      waited += 1;
      if (waited < 240) window.setTimeout(armReconcile, 500);
    })();
  }

  function bootstrap() {
    // Runs in every context and for every role: the picker list is shared
    // state, and an employee's own window needs the id registered too so
    // authV12AvailableViews() can resolve its label.
    armSalesHistoryPermission();
    embeddedBootstrap();
  }

  if (document.readyState !== 'loading') bootstrap();
  else document.addEventListener('DOMContentLoaded', bootstrap, { once: true });
})();
