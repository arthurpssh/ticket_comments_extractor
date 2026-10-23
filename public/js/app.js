(function () {
  const POLL_INTERVAL_MS = 1500;
  const BTN_LABEL = 'Extrair e baixar planilha';

  let maxTickets = 1000;
  let ticketsLeft = 0;
  let running = false;
  let loadedUsage = false;

  const $ = (id) => document.getElementById(id);
  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

  /** fetch + JSON; erros viram Error(message) com a mensagem devolvida pelo servidor */
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

    if (!response.ok) {
      const error = new Error((data && data.message) || `Erro ${response.status} ao comunicar com o servidor.`);
      error.status = response.status;
      throw error;
    }
    return data;
  }

  const fmt = (n) => Number(n).toLocaleString('pt-BR');

  function parseTickets() {
    return [...new Set($('ticketInput').value.split(/[\r\n,]+/).map((item) => item.trim()).filter((item) => item !== ''))];
  }

  // Quantos tickets cabem numa extração agora: o menor entre o limite por extração e o saldo
  const allowedNow = () => Math.min(maxTickets, ticketsLeft);

  function updateCounter() {
    const n = parseTickets().length;
    $('ticketCount').textContent = n;
    $('counter').classList.toggle('over', loadedUsage && n > allowedNow());
  }

  function renderUsage(n) {
    ticketsLeft = n;
    const box = $('usage');
    box.classList.remove('loading', 'low', 'empty');
    $('usageNumber').textContent = fmt(n);
    if (n <= 0) box.classList.add('empty');
    else if (n <= 100) box.classList.add('low');
  }

  function setBanner(message, withRetry) {
    const banner = $('banner');
    banner.replaceChildren();
    banner.classList.toggle('show', Boolean(message));
    if (!message) return;

    const text = document.createElement('div');
    text.textContent = message;
    banner.append(text);

    if (withRetry) {
      const retry = document.createElement('button');
      retry.type = 'button';
      retry.textContent = 'Tentar novamente';
      retry.addEventListener('click', loadUsage);
      banner.append(retry);
    }
  }

  function setReady(ready, label) {
    $('ticketInput').disabled = !ready;
    $('btnExtract').disabled = !ready;
    $('btnDonate').disabled = !(ready && ticketsLeft > 0);
    $('btnExtract').textContent = label || BTN_LABEL;
  }

  function setStatus(message, type) {
    $('status').textContent = message;
    $('status').className = type || '';
  }

  function setProgress(done, total) {
    const pct = total ? Math.round((done / total) * 100) : 0;
    $('progressBar').style.width = `${pct}%`;
    $('progressText').textContent = `${fmt(done)} / ${fmt(total)} tickets (${pct}%)`;
  }

  async function loadUsage() {
    setBanner('');
    $('usage').className = 'usage loading';
    $('usageNumber').textContent = '–';
    $('btnExtract').textContent = 'Verificando cota...';
    try {
      const info = await api('/api/usage');
      maxTickets = info.max_tickets || maxTickets;
      $('maxTickets').textContent = fmt(maxTickets);
      $('adminLink').hidden = !info.is_admin;
      renderUsage(info.tickets_left);
      loadedUsage = true;
      updateCounter();

      if (!info.registered) {
        setBanner(`Seu usuário (${info.user}) não está cadastrado no controle de uso. Solicite acesso para utilizar a ferramenta.`);
        setReady(false, 'Sem acesso');
      } else if (info.tickets_left <= 0) {
        setBanner('Sem tickets restantes hoje. A cota é renovada diariamente. Se precisar de mais, peça a um colega para doar tickets.');
        setReady(false, 'Sem tickets restantes');
      } else if (info.global_remaining <= 0) {
        setBanner('O limite diário de tickets de toda a equipe foi atingido. Tente novamente amanhã.');
        setReady(false, 'Limite diário da equipe atingido');
      } else {
        setReady(true);
      }
    } catch (error) {
      $('usage').classList.remove('loading');
      $('usageNumber').textContent = '?';
      setBanner(`Não foi possível verificar sua cota: ${error.message}`, true);
      setReady(false, 'Indisponível');
    }
  }

  function download(jobId) {
    const link = document.createElement('a');
    link.href = `/api/extractions/${encodeURIComponent(jobId)}/download`;
    link.download = '';
    document.body.append(link);
    link.click();
    link.remove();
  }

  function showFailed(ids, refunded) {
    const box = $('failedBox');
    box.hidden = ids.length === 0;
    if (ids.length === 0) return;

    $('failedTitle').textContent =
      `${ids.length} ticket(s) falharam no Zendesk e foram pulados` +
      (refunded ? ' (já devolvidos à sua cota)' : '') +
      '. No arquivo, eles aparecem marcados com [ERRO ...]. Tente novamente com os IDs abaixo:';
    $('failedIds').value = ids.join('\n');
  }

  /** Acompanha uma extração até terminar (sucesso, sucesso parcial ou falha). */
  async function follow(job) {
    running = true;
    showFailed([], 0);
    setReady(false, 'Extraindo... Aguarde.');
    $('progressWrap').hidden = false;
    setProgress(job.processed, job.total);
    setStatus('Extraindo comentários...', 'loading-text');

    try {
      let current = job;
      let failures = 0;
      while (current.status === 'starting' || current.status === 'running') {
        await sleep(POLL_INTERVAL_MS);
        try {
          current = await api(`/api/extractions/${encodeURIComponent(job.job_id)}`);
          failures = 0;
        } catch (error) {
          if (error.status === 404) throw new Error('A extração foi perdida (o servidor pode ter sido reiniciado). Tente novamente.');
          if (++failures >= 5) throw error; // tolera falhas de rede passageiras
          continue;
        }
        setProgress(current.processed, current.total);
      }

      if (current.status === 'failed') throw new Error(current.error || 'A extração falhou.');

      setProgress(current.total, current.total);
      download(current.job_id);

      const missing = current.not_found ? ` (${current.not_found} ticket(s) não encontrado(s))` : '';
      if (current.partial) {
        setStatus(`⚠️ Extração concluída com falhas. O download do arquivo foi iniciado${missing}.`, 'warn-text');
        showFailed(current.failed_tickets, current.refunded);
      } else {
        setStatus(`✅ Extração concluída! O download do arquivo foi iniciado${missing}.`, 'success');
      }
      $('ticketInput').value = '';
      updateCounter();
    } catch (error) {
      setStatus(`❌ ${error.message}`, 'error');
      $('progressWrap').hidden = true;
    } finally {
      running = false;
      // Re-sincroniza o saldo real (inclui devoluções por falha e doações recebidas)
      await loadUsage();
    }
  }

  async function startExtraction() {
    const tickets = parseTickets();

    if (tickets.length === 0) return setStatus('⚠️ Por favor, insira pelo menos um ID de ticket válido.', 'error');
    if (tickets.length > maxTickets) {
      return setStatus(`⚠️ Limite de ${fmt(maxTickets)} tickets por extração (você inseriu ${fmt(tickets.length)}).`, 'error');
    }
    if (tickets.length > ticketsLeft) {
      return setStatus(`⚠️ Você tem ${fmt(ticketsLeft)} ticket(s) restante(s) hoje e inseriu ${fmt(tickets.length)}.`, 'error');
    }

    setReady(false, 'Iniciando...');
    setStatus('Validando sua cota...', 'loading-text');
    try {
      const job = await api('/api/extractions', { method: 'POST', body: { tickets } });
      renderUsage(job.tickets_left);
      await follow(job);
    } catch (error) {
      setStatus(`❌ ${error.message}`, 'error');
      await loadUsage();
    }
  }

  async function donate() {
    const to = $('donateTo').value.trim();
    const amount = Number($('donateAmount').value);
    const msg = $('donateMsg');

    if (!to) return setDonateMsg('Informe o e-mail do colega.', true);
    if (!Number.isInteger(amount) || amount < 1) return setDonateMsg('Informe uma quantidade inteira maior que zero.', true);
    if (amount > ticketsLeft) return setDonateMsg(`Você só tem ${fmt(ticketsLeft)} ticket(s) disponível(is).`, true);
    if (!confirm(`Doar ${fmt(amount)} ticket(s) para ${to}? Esta ação não pode ser desfeita.`)) return undefined;

    $('btnDonate').disabled = true;
    msg.className = 'donate-msg';
    msg.textContent = 'Doando...';
    try {
      const result = await api('/api/transfers', { method: 'POST', body: { to, amount } });
      renderUsage(result.tickets_left);
      setDonateMsg(`${fmt(amount)} ticket(s) doado(s) para ${result.recipient}.`, false);
      $('donateAmount').value = '';
      updateCounter();
    } catch (error) {
      setDonateMsg(error.message, true);
    } finally {
      $('btnDonate').disabled = ticketsLeft <= 0;
    }
    return undefined;
  }

  function setDonateMsg(message, isError) {
    $('donateMsg').textContent = message;
    $('donateMsg').className = `donate-msg ${isError ? 'error' : 'success'}`;
  }

  async function loadDonationUsers() {
    try {
      const emails = await api('/api/users');
      const list = $('donateUsers');
      list.replaceChildren();
      emails.forEach((email) => {
        const option = document.createElement('option');
        option.value = email;
        list.append(option);
      });
    } catch {
      // a doação continua possível digitando o e-mail
    }
  }

  async function init() {
    $('ticketInput').addEventListener('input', updateCounter);
    $('btnExtract').addEventListener('click', startExtraction);
    $('btnDonate').addEventListener('click', donate);
    $('btnCopyFailed').addEventListener('click', async () => {
      try {
        await navigator.clipboard.writeText($('failedIds').value);
        $('btnCopyFailed').textContent = 'Copiado!';
      } catch {
        $('failedIds').select();
      }
      setTimeout(() => {
        $('btnCopyFailed').textContent = 'Copiar IDs que falharam';
      }, 2000);
    });
    window.addEventListener('beforeunload', (event) => {
      if (running) {
        event.preventDefault();
        event.returnValue = '';
      }
    });

    await loadUsage();
    loadDonationUsers();

    // Retoma o acompanhamento se havia uma extração em andamento (ex.: a página foi recarregada)
    try {
      const current = await api('/api/extractions/current');
      if (current && (current.status === 'starting' || current.status === 'running')) await follow(current);
    } catch {
      // sem extração para retomar
    }
  }

  init();
})();
