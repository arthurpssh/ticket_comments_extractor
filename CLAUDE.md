# Guia para Assistente de Programação

Este projeto chama-se `zd-comments-extractor`: a versão Node.js + Express da ferramenta de extração de comentários de tickets do Zendesk (migrada de um web app Google Apps Script). O usuário informa até 1000 IDs de ticket, a aplicação busca os comentários no Zendesk, gera um `.xlsx` (colunas `ticket_id` e `comments_concat`) e o navegador baixa o arquivo. Cota, log e configuração ficam em uma planilha Google (Sheets via Service Account).

## Stack Tecnológica

| Camada | Tecnologia | Versão |
|--------|-----------|--------|
| Runtime | Node.js | 24 |
| Framework | Express | 5 |
| Google API | googleapis (somente Sheets) | 181+ |
| XLSX | exceljs | 4 |
| Gráficos (admin) | chart.js (servido de `/vendor/chartjs`) | 4 |
| Front-end | HTML/CSS/JS puro | — |
| Container | Docker (Alpine) | — |
| CI/CD | GitHub Actions | — |

## Estrutura do Projeto

```
├── src/
│   ├── app.js                       # Express app (health, auth, estáticos, rotas)
│   ├── server.js                    # Entry point (escuta na porta PORT)
│   ├── config/
│   │   ├── extraction.js            # Planilha de controle, Zendesk, limites (lê as env vars)
│   │   └── googleClient.js          # Autenticação Google Sheets (Service Account)
│   ├── middlewares/
│   │   ├── auth.js                  # requireUser (X-Auth-Request-Email) e requireAdmin (role na planilha)
│   │   └── errorHandler.js          # Erros -> JSON { message }
│   ├── routes/
│   │   ├── apiRoutes.js             # /api/* (usuário comum)
│   │   └── adminRoutes.js           # /api/admin/* (só admin)
│   ├── services/
│   │   ├── usageService.js          # Saldo de tickets: consumo, devolução, doação
│   │   ├── configService.js         # Aba "Config" (cota padrão, teto global)
│   │   ├── ledgerService.js         # Aba "Quota Ledger" (auditoria)
│   │   ├── logService.js            # Aba "Log": processing -> success | partial | failed
│   │   ├── extractionService.js     # Extrações em segundo plano (estado em memória)
│   │   ├── adminService.js          # Usuários, config, analytics e ledger do admin
│   │   └── xlsxBuilder.js           # Gera o .xlsx
│   ├── utils/
│   │   ├── SheetsDB.js              # Acesso ao Sheets (RAW + UNFORMATTED_VALUE; leituras por coluna)
│   │   ├── zendeskClient.js         # API do Zendesk (OAuth/Basic, retry, limitador, contagem de chamadas)
│   │   ├── rateLimiter.js           # Limitador global de pedidos/min ao Zendesk
│   │   ├── commentsFormatter.js     # Comentários -> texto
│   │   ├── mutex.js, dates.js, sheetsError.js, errors.js
│   └── views/                       # admin.html (fora de public/ de propósito) e 403.html
├── public/                          # index.html, css/, js/app.js e admin/ (css + js)
├── .github/workflows/deploy.yaml
├── Dockerfile, package.json, values.yml
```

## Arquitetura

- Todas as rotas, exceto `GET /api/health`, exigem usuário autenticado: o ingress (`auth-url` do `values.yml`) injeta o e-mail em `X-Auth-Request-Email`. Sem e-mail, 403.
- **Cota por tickets por dia**: cada ticket consome 1 da cota (`tickets_left` na aba "Use Controller"); o padrão vem de `daily_tickets` (Config) ou da coluna `daily_quota` do usuário. Existe um **teto global diário** (`global_daily_tickets`) contado em `global_used_today` (Config). Um Apps Script (aplicação de controle) zera tudo de madrugada (`updateUses`). `tickets_left` em branco = cota cheia do dia.
- **Fluxo de extração** (`POST /api/extractions`): valida os IDs (numéricos, únicos, máx. 1000) -> consome a cota (e o teto global) -> grava linha em "Log" com `log_id` (UUID) e status `processing` -> responde 202 e extrai em segundo plano (3 tickets em paralelo) -> gera o xlsx em memória. O front acompanha por polling (`GET /api/extractions/:id`) e baixa em `GET /api/extractions/:id/download`.
- **Falhas**: ticket que falha em todas as tentativas (1 + 3 retries) é **pulado**: a linha do xlsx vira `[ERRO ao buscar este ticket: ...]`, o ID vai para `failed_tickets` no Log, o status final é `partial` e os tickets pulados são **devolvidos** à cota (só no mesmo dia). 404 (ticket inexistente) não é falha técnica: não devolve. Erros fatais (401/403 do Zendesk, OAuth inválido), 10 falhas seguidas ou nenhum ticket extraído abortam a extração (`failed`) e devolvem tudo.
- **Rate limit do Zendesk (plano: 700/min)**: `rateLimiter.js` limita **todas** as extrações a `ZENDESK_MAX_RPM` pedidos/min (padrão 150), pausa em 429 (`Retry-After`) e pausa também quando `X-Rate-Limit-Remaining` cai abaixo de 50% do limite (outros consumidores usando muito). `api_calls` no Log guarda as chamadas HTTP reais da extração.
- **Doação** (`POST /api/transfers`): o usuário doa parte do saldo do dia para outro cadastrado; não acumula para o dia seguinte e não mexe no contador global.
- **Ledger** (aba "Quota Ledger"): consume, refund, transfer_out/in, admin_adjust (Node) e reset (Apps Script). Falha ao gravar o ledger não bloqueia a operação.
- **Admin** (`/admin`, `/api/admin/*`): só quem tem `role = admin` na aba "Use Controller". Gerencia cota padrão e teto global, usuários (saldo, cota própria, papel, adicionar/excluir) e vê analytics (extrações, tickets, chamadas à API, ranking) e as movimentações do ledger.
- O estado das extrações vive **em memória** (Map em `extractionService.js`): `replicaCount` deve ser **1**. Extrações concluídas ficam 30 min para download. Se o servidor reiniciar no meio de uma extração, ela se perde; o Apps Script de controle (`sweepStaleProcessing`) marca como `failed` e devolve os tickets das que ficaram em `processing` por mais de 2 horas.
- A exclusão mútua das escritas de cota é um mutex em processo (`utils/mutex.js`), válido com 1 réplica. O reset do Apps Script não compartilha esse lock (risco baixo, de madrugada).
- A aba "Log" tem colunas pesadas (`ticket_ids`): atualizações usam `SheetsDB.patchByKey` e o analytics usa `getRowsPartial`, que leem só as colunas necessárias. Nunca use `getRows` na aba Log.
- Health check: `GET /api/health` retorna `{ status: 'ok' }`.

### Secrets de Produção

Injetadas pelo Secrets Manager (ver `values.yml`):

- `GOOGLE_CLIENT_EMAIL` — e-mail da service account (precisa ser **Editora** da planilha de controle)
- `GOOGLE_PRIVATE_KEY` — chave privada da service account
- `CONTROL_SPREADSHEET_ID` — ID da planilha de controle
- `ZENDESK_CLIENT_ID` e `ZENDESK_CLIENT_SECRET` — client OAuth confidencial do Zendesk (modo preferencial)
- `ZENDESK_BASIC_TOKEN` — fallback legado: base64 de `email/token:api_token`. Usado só se o OAuth não estiver configurado

Configuração (não secret): `ZENDESK_BASE_URL`, `ZENDESK_OAUTH_SCOPE` (padrão `read write tickets:read macros:read macros:write`), `ZENDESK_OAUTH_EXPIRES_IN` (opcional), `ZENDESK_MAX_RPM` (padrão 150).
Somente dev local: `DEV_USER_EMAIL` simula o e-mail do usuário logado (NUNCA definir em produção).

## Planilha de controle

| Aba | Colunas |
|-----|---------|
| Use Controller | user, uses_left (legado: extrator antigo), tickets_left, refreshed_at, role (`admin`\|`user`), daily_quota (opcional) — todas texto |
| Config | key, value: `daily_tickets` (1000), `global_daily_tickets` (15000), `global_used_today`, `daily_use` (legado) |
| Log | log_id, date, user, ticket_amount, ticket_ids, status, failed_tickets, api_calls |
| Quota Ledger | date, user, type, delta, ref, note |

`status` do Log: `processing` -> `success` | `partial` | `failed`. O Apps Script de controle (`Apps Script - Controle de Uso do Extrator`) faz o reset diário, o varredor de `processing` travado e mantém a página admin antiga (que continua funcionando enquanto o extrator em Apps Script existir; encerra em 28/10/2026).

## Desenvolvimento Local

```bash
cp .env.example .env
# Preencha GOOGLE_CLIENT_EMAIL, GOOGLE_PRIVATE_KEY, CONTROL_SPREADSHEET_ID, credenciais do Zendesk e DEV_USER_EMAIL
npm install
npm run dev   # igual a "npm start", mas com --use-system-ca (usa os certificados raiz do sistema operacional)
```

Em rede corporativa com inspeção TLS, o `fetch` do Node falha com `UNABLE_TO_GET_ISSUER_CERT_LOCALLY` / `SELF_SIGNED_CERT_IN_CHAIN`. Use `npm run dev` ou aponte `NODE_EXTRA_CA_CERTS` para o certificado raiz da empresa (lidos na inicialização do Node: NÃO funcionam via `.env`). NUNCA usar `NODE_TLS_REJECT_UNAUTHORIZED=0`.

## Deploy

- `npm ci` instala dependências de produção
- Docker copia `src/` e `public/`
- Container roda `node src/server.js` na porta 3001

## Regras

1. `GET /api/health` NUNCA remover — deve retornar `{ status: 'ok' }` (200) sempre, sem tocar em Sheets/Zendesk
2. `HOSTNAME=0.0.0.0` para o servidor escutar em todas as interfaces no container
3. NÃO adicionar banco de dados relacional — Google Sheets é o storage desta aplicação
4. Secrets NUNCA hardcodar (nem credenciais do Zendesk, nem IDs de planilha) e NUNCA persistir o access token do Zendesk (só em memória)
5. Escrita no Sheets sempre via `SheetsDB` (modo RAW; `patchRows` altera só as células pedidas)
6. Dados dinâmicos no front sempre via `textContent`/DOM, nunca `innerHTML`
7. Manter `replicaCount: 1` enquanto o estado das extrações estiver em memória
8. A página de admin fica em `src/views/` (fora de `public/`, que é servido a qualquer usuário); toda rota admin passa por `requireAdmin`
9. Todo pedido ao Zendesk passa pelo limitador (`zendeskClient.request`): não chamar `fetch` do Zendesk por fora

## Rotas

| Método | Caminho | Descrição |
|--------|---------|-----------|
| GET | /api/health | Health check (sem autenticação) |
| GET | /api/me | E-mail do usuário autenticado |
| GET | /api/usage | Saldo de tickets, cota, teto global restante, `is_admin` |
| GET | /api/users | E-mails cadastrados (para escolher o destinatário de uma doação) |
| POST | /api/transfers | Doa tickets (`{ to, amount }`) |
| POST | /api/extractions | Inicia extração (`{ tickets: [...] }`); consome a cota; 202 |
| GET | /api/extractions/current | Extração em andamento/concluída do usuário (ou `null`) |
| GET | /api/extractions/:id | Andamento (`status`, `processed`, `total`, `partial`, `failed_tickets`, `error`) |
| GET | /api/extractions/:id/download | Baixa o .xlsx (extração concluída) |
| GET | / | Página da ferramenta |
| GET | /admin | Página de admin (só admin) |
| GET/PUT | /api/admin/bootstrap, /api/admin/config | Cota padrão e teto global |
| GET/POST/PATCH/DELETE | /api/admin/users | Usuários (saldo, cota própria, papel) |
| GET | /api/admin/analytics, /api/admin/ledger | Analytics e movimentações |
