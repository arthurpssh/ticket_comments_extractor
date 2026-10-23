(function () {
  const $ = (id) => document.getElementById(id);
  const state = { users: [], config: {}, rank: [], sortKey: 'tickets', sortDir: -1, chart: null, analyticsLoaded: false, ledgerLoaded: false };
  const fmt = (n) => Number(n).toLocaleString('pt-BR');

  /** Cria elementos sem innerHTML (os dados são sempre inseridos como texto). */
  function h(tag, attrs, ...children) {
    const el = document.createElement(tag);
    Object.entries(attrs || {}).forEach(([key, value]) => {
      if (value === undefined || value === null || value === false) return;
      if (key === 'class') el.className = value;
      else if (key === 'dataset') Object.assign(el.dataset, value);
      else if (key === 'value') el.value = value;
      else el.setAttribute(key, value === true ? '' : value);
    });
    children.flat().forEach((child) => el.append(child instanceof Node ? child : document.createTextNode(String(child))));
    return el;
  }

  async function api(path, { method = 'GET', body } = {}) {
    const response = await fetch(path, {
      method,
      headers: body === undefined ? undefined : { 'Content-Type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    let data = null;
    try {
      data = await response.json();
    } catch {
      data = null;
    }
    if (!response.ok) throw new Error((data && data.message) || `Erro ${response.status} ao comunicar com o servidor.`);
    return data;
  }

  let toastTimer;
  function toast(msg, isErr) {
    const t = $('toast');
    t.textContent = msg;
    t.className = `toast${isErr ? ' err' : ''}`;
    t.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => {
      t.hidden = true;
    }, isErr ? 6000 : 2500);
  }

  // ---------- Config ----------
  function renderConfig() {
    document.querySelectorAll('[data-config]').forEach((box) => {
      box.querySelector('.config-value').textContent = fmt(state.config[box.dataset.config]);
    });
    $('globalUsed').textContent = `Usado hoje: ${fmt(state.config.global_used_today)} de ${fmt(state.config.global_daily_tickets)}`;
  }

  document.querySelectorAll('[data-config]').forEach((box) => {
    const key = box.dataset.config;
    const view = box.querySelector('.config-value');
    const editBtn = box.querySelector('[data-act="edit"]');
    const editor = box.querySelector('.editor');
    const input = editor.querySelector('input');

    const setEditing = (on) => {
      view.hidden = on;
      editBtn.hidden = on;
      editor.hidden = !on;
      if (on) {
        input.value = state.config[key];
        input.focus();
        input.select();
      }
    };

    editBtn.addEventListener('click', () => setEditing(true));
    editor.querySelector('[data-act="cancel"]').addEventListener('click', () => setEditing(false));
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') editor.querySelector('[data-act="confirm"]').click();
      if (e.key === 'Escape') editor.querySelector('[data-act="cancel"]').click();
    });
    editor.querySelector('[data-act="confirm"]').addEventListener('click', async (e) => {
      const btn = e.currentTarget;
      btn.disabled = true;
      try {
        state.config = await api('/api/admin/config', { method: 'PUT', body: { [key]: input.value } });
        renderConfig();
        setEditing(false);
        toast('Configuração atualizada.');
      } catch (err) {
        toast(err.message, true);
      } finally {
        btn.disabled = false;
      }
    });
  });

  // ---------- Abas ----------
  document.querySelectorAll('.tab').forEach((b) => {
    b.addEventListener('click', () => {
      document.querySelectorAll('.tab').forEach((x) => x.classList.toggle('active', x === b));
      ['users', 'analytics', 'ledger'].forEach((t) => {
        $(`tab-${t}`).hidden = t !== b.dataset.tab;
      });
      if (b.dataset.tab === 'analytics' && !state.analyticsLoaded) loadAnalytics();
      if (b.dataset.tab === 'ledger' && !state.ledgerLoaded) loadLedger();
    });
  });

  // ---------- Usuários ----------
  function userRow(u) {
    const stepper = h(
      'span',
      { class: 'stepper' },
      h('button', { class: 'icon-btn', dataset: { act: 'dec' }, 'aria-label': 'Diminuir 100', title: '−100' }, '−'),
      h('input', { type: 'number', min: '0', step: '1', class: 'num', dataset: { act: 'tickets' }, value: u.tickets_left }),
      h('button', { class: 'icon-btn', dataset: { act: 'inc' }, 'aria-label': 'Aumentar 100', title: '+100' }, '+')
    );
    const quota = h('input', {
      type: 'number', min: '0', step: '1', class: 'quota-input', dataset: { act: 'quota' }, placeholder: 'padrão',
      value: u.daily_quota === null ? '' : u.daily_quota,
    });
    const role = h(
      'select',
      { dataset: { act: 'role' } },
      h('option', { value: 'user', selected: u.role === 'user' }, 'user'),
      h('option', { value: 'admin', selected: u.role === 'admin' }, 'admin')
    );
    return h(
      'tr',
      { dataset: { user: u.user } },
      h('td', {}, u.user),
      h('td', { class: 'center' }, stepper),
      h('td', { class: 'center' }, quota),
      h('td', {}, role),
      h('td', { class: 'trash-col' }, h('button', { class: 'trash', dataset: { act: 'del' }, title: 'Excluir usuário', 'aria-label': 'Excluir usuário' }, '🗑'))
    );
  }

  function renderUsers() {
    const tbody = $('usersTable').querySelector('tbody');
    tbody.replaceChildren();
    if (state.users.length === 0) {
      tbody.append(h('tr', {}, h('td', { colspan: '5', class: 'muted' }, 'Nenhum usuário.')));
      return;
    }
    state.users.forEach((u) => tbody.append(userRow(u)));
  }

  async function saveUser(user, patch, tr) {
    tr.classList.add('saving');
    try {
      await api('/api/admin/users', { method: 'PATCH', body: { user, ...patch } });
      const u = state.users.find((x) => x.user === user);
      if (u) {
        if ('tickets_left' in patch) u.tickets_left = Number(patch.tickets_left);
        if ('daily_quota' in patch) u.daily_quota = patch.daily_quota === '' ? null : Number(patch.daily_quota);
        if ('role' in patch) u.role = patch.role;
      }
    } catch (e) {
      toast(e.message, true);
      renderUsers();
    } finally {
      tr.classList.remove('saving');
    }
  }

  const saveTimers = {};
  function scheduleSave(tr, user, patch, timerKey) {
    clearTimeout(saveTimers[timerKey]);
    saveTimers[timerKey] = setTimeout(() => saveUser(user, patch, tr), 600);
  }

  const usersBody = $('usersTable').querySelector('tbody');
  usersBody.addEventListener('click', async (e) => {
    const btn = e.target.closest('button[data-act]');
    if (!btn) return;
    const tr = btn.closest('tr');
    const { user } = tr.dataset;

    if (btn.dataset.act === 'inc' || btn.dataset.act === 'dec') {
      const input = tr.querySelector('input[data-act="tickets"]');
      const v = Math.max(0, (parseInt(input.value, 10) || 0) + (btn.dataset.act === 'inc' ? 100 : -100));
      input.value = v;
      scheduleSave(tr, user, { tickets_left: v }, `${user}:tickets`);
    } else if (btn.dataset.act === 'del') {
      if (!confirm(`Excluir o usuário ${user}?`)) return;
      tr.classList.add('saving');
      try {
        await api(`/api/admin/users?user=${encodeURIComponent(user)}`, { method: 'DELETE' });
        state.users = state.users.filter((u) => u.user !== user);
        renderUsers();
        toast('Usuário excluído.');
      } catch (err) {
        tr.classList.remove('saving');
        toast(err.message, true);
      }
    }
  });

  usersBody.addEventListener('change', (e) => {
    const tr = e.target.closest('tr');
    if (!tr) return;
    const { user } = tr.dataset;

    if (e.target.dataset.act === 'tickets') {
      const v = parseInt(e.target.value, 10);
      if (Number.isNaN(v) || v < 0) {
        toast('Informe um inteiro maior ou igual a 0.', true);
        renderUsers();
        return;
      }
      e.target.value = v;
      scheduleSave(tr, user, { tickets_left: v }, `${user}:tickets`);
    } else if (e.target.dataset.act === 'quota') {
      const raw = e.target.value.trim();
      const v = parseInt(raw, 10);
      if (raw !== '' && (Number.isNaN(v) || v < 0)) {
        toast('Informe um inteiro maior ou igual a 0 (ou deixe vazio para o padrão).', true);
        renderUsers();
        return;
      }
      scheduleSave(tr, user, { daily_quota: raw === '' ? '' : v }, `${user}:quota`);
    } else if (e.target.dataset.act === 'role') {
      saveUser(user, { role: e.target.value }, tr);
    }
  });

  $('addBtn').addEventListener('click', async () => {
    const btn = $('addBtn');
    const msg = $('addMsg');
    btn.disabled = true;
    msg.className = 'msg';
    msg.textContent = 'Adicionando…';
    try {
      const r = await api('/api/admin/users', { method: 'POST', body: { raw: $('addInput').value } });
      state.users = r.users;
      renderUsers();
      const parts = [`${r.added.length} adicionado(s)`];
      if (r.duplicated.length) parts.push(`${r.duplicated.length} já existente(s)`);
      if (r.invalid.length) parts.push(`inválido(s): ${r.invalid.join(', ')}`);
      msg.className = `msg${r.invalid.length ? ' err' : ''}`;
      msg.textContent = parts.join(' · ');
      $('addInput').value = r.invalid.join(', ');
    } catch (e) {
      msg.className = 'msg err';
      msg.textContent = e.message;
    } finally {
      btn.disabled = false;
    }
  });

  // ---------- Analytics ----------
  const ymd = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  $('fStart').value = ymd(new Date(Date.now() - 6 * 86400000));
  $('fEnd').value = ymd(new Date());

  function fillUserSelect(select, users) {
    const current = select.value;
    select.replaceChildren(h('option', { value: '' }, 'Todos'));
    users.forEach((u) => select.append(h('option', { value: u }, u)));
    select.value = current;
  }

  async function loadAnalytics() {
    const btn = $('fApply');
    btn.disabled = true;
    try {
      const params = new URLSearchParams({ start: $('fStart').value, end: $('fEnd').value, user: $('fUser').value, status: $('fStatus').value });
      const r = await api(`/api/admin/analytics?${params}`);
      state.analyticsLoaded = true;
      fillUserSelect($('fUser'), r.users);
      fillUserSelect($('lUser'), r.users);
      $('kCalls').textContent = fmt(r.totals.calls);
      $('kTickets').textContent = fmt(r.totals.tickets);
      $('kApi').textContent = fmt(r.totals.api_calls);
      $('kGran').textContent = `Granularidade: ${{ hour: 'hora', '6h': '6 horas', day: 'dia' }[r.granularity]}`;
      renderChart(r);
      state.rank = r.ranking;
      renderRank();
    } catch (e) {
      toast(e.message, true);
    } finally {
      btn.disabled = false;
    }
  }
  $('fApply').addEventListener('click', loadAnalytics);

  function renderChart(r) {
    const bar = (label, key, color) => ({ type: 'bar', label, data: r.buckets.map((b) => b[key]), backgroundColor: color, stack: 'calls', yAxisID: 'y', order: 2 });
    const cfg = {
      data: {
        labels: r.buckets.map((b) => b.label),
        datasets: [
          bar('Sucesso', 'success', '#2f9e5b'),
          bar('Parcial', 'partial', '#f08c00'),
          bar('Falha', 'failed', '#d64545'),
          bar('Processando', 'processing', '#e8b400'),
          { type: 'line', label: 'Tickets', data: r.buckets.map((b) => b.tickets), borderColor: '#2563eb', backgroundColor: '#2563eb', yAxisID: 'y1', tension: 0.25, pointRadius: 3, order: 1 },
        ],
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        interaction: { mode: 'index', intersect: false },
        scales: {
          x: { position: 'top', stacked: true, grid: { color: 'rgba(0,0,0,.04)' }, ticks: { color: '#9aa5b1', maxRotation: 60, autoSkip: true } },
          y: { stacked: true, beginAtZero: true, position: 'left', title: { display: true, text: 'Extrações' }, ticks: { precision: 0 } },
          y1: { beginAtZero: true, position: 'right', title: { display: true, text: 'Tickets' }, grid: { drawOnChartArea: false }, ticks: { precision: 0 } },
        },
        plugins: { legend: { position: 'bottom' } },
      },
    };
    if (state.chart) state.chart.destroy();
    state.chart = new Chart($('chart'), cfg); // eslint-disable-line no-undef
  }

  function renderRank() {
    const { sortKey, sortDir } = state;
    const rows = state.rank.slice().sort((a, b) => (a[sortKey] - b[sortKey]) * sortDir || a.user.localeCompare(b.user));
    const tbody = $('rankTable').querySelector('tbody');
    tbody.replaceChildren();
    if (rows.length === 0) {
      tbody.append(h('tr', {}, h('td', { colspan: '4', class: 'muted' }, 'Sem dados para o filtro.')));
    } else {
      rows.forEach((r) => tbody.append(h('tr', {}, h('td', {}, r.user), h('td', { class: 'center' }, fmt(r.calls)), h('td', { class: 'center' }, fmt(r.tickets)), h('td', { class: 'center' }, fmt(r.api_calls)))));
    }
    document.querySelectorAll('#rankTable th.sortable').forEach((th) => {
      th.querySelector('i').textContent = th.dataset.sort === sortKey ? (sortDir === 1 ? '▲' : '▼') : '';
    });
  }
  document.querySelectorAll('#rankTable th.sortable').forEach((th) => {
    th.addEventListener('click', () => {
      state.sortDir = state.sortKey === th.dataset.sort ? -state.sortDir : -1;
      state.sortKey = th.dataset.sort;
      renderRank();
    });
  });

  // ---------- Movimentações (ledger) ----------
  const TYPE_LABELS = { consume: 'Consumo', refund: 'Devolução', transfer_out: 'Doação enviada', transfer_in: 'Doação recebida', admin_adjust: 'Ajuste de admin', reset: 'Reset diário' };

  async function loadLedger() {
    const btn = $('lApply');
    btn.disabled = true;
    try {
      const params = new URLSearchParams({ user: $('lUser').value, type: $('lType').value });
      const rows = await api(`/api/admin/ledger?${params}`);
      state.ledgerLoaded = true;
      const tbody = $('ledgerTable').querySelector('tbody');
      tbody.replaceChildren();
      if (rows.length === 0) {
        tbody.append(h('tr', {}, h('td', { colspan: '5', class: 'muted' }, 'Nenhuma movimentação.')));
      }
      rows.forEach((r) => {
        const delta = Number(r.delta) || 0;
        const when = new Date(r.date);
        tbody.append(
          h(
            'tr',
            {},
            h('td', {}, Number.isNaN(when.getTime()) ? String(r.date) : when.toLocaleString('pt-BR')),
            h('td', {}, r.user),
            h('td', {}, TYPE_LABELS[r.type] || r.type),
            h('td', { class: `center ${delta < 0 ? 'neg' : 'pos'}` }, `${delta > 0 ? '+' : ''}${fmt(delta)}`),
            h('td', { class: 'muted' }, r.note || '')
          )
        );
      });
    } catch (e) {
      toast(e.message, true);
    } finally {
      btn.disabled = false;
    }
  }
  $('lApply').addEventListener('click', loadLedger);

  // ---------- Init ----------
  api('/api/admin/bootstrap')
    .then((r) => {
      $('userChip').textContent = r.email;
      state.users = r.users;
      state.config = r.config;
      renderConfig();
      renderUsers();
      fillUserSelect($('lUser'), r.users.map((u) => u.user).sort());
    })
    .catch((e) => toast(e.message, true));
})();
