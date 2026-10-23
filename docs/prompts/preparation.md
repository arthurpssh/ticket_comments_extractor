# Preparacao — Especifico: Node.js 24 + Express + Google Sheets API

## Stack deste template
- Framework: Express 5
- Runtime: Node.js 24
- Storage: Google Sheets via googleapis (sem uso do Drive)
- Integracao externa: API do Zendesk (fetch nativo)
- Sem banco de dados relacional

## Regras especificas

- NAO adicionar Next.js, Vite ou outro framework de frontend
- NAO adicionar Prisma, Liquibase ou qualquer ORM/migrations
- Health check: `GET /api/health` retorna `{ status: 'ok' }` (Express handler, nao checar Google Sheets)
- Dockerfile copia `src/` e `public/`, roda `npm ci --omit=dev`, CMD `node src/server.js`
- Script start: `node src/server.js`
- Env `PORT=3001` obrigatorio
- `replicaCount: 1`: o estado das extracoes (andamento e arquivo gerado) fica em memoria

## Secrets

Secrets (injetados via AWS Secrets Manager):

- `GOOGLE_CLIENT_EMAIL` — e-mail da service account (precisa ser **Editora** da planilha de controle)
- `GOOGLE_PRIVATE_KEY` — chave privada PEM da service account
- `CONTROL_SPREADSHEET_ID` — ID da planilha de controle (abas "Use Controller" e "Log")
- `ZENDESK_CLIENT_ID` e `ZENDESK_CLIENT_SECRET` — client OAuth (client credentials) do Zendesk
- `ZENDESK_BASIC_TOKEN` — fallback legado: base64 de `email/token:api_token` (Authorization: Basic)

Configuracao (nao secret), definida diretamente no `env:` do values.yml:

- `ZENDESK_BASE_URL` — URL base da API do Zendesk
- `ZENDESK_OAUTH_SCOPE` — escopos OAuth solicitados (padrao `read write tickets:read macros:read macros:write`)

No values.yml cada secret e um `secretKeyRef` com nome no formato `{app-name}-{env-name-kebab}`.

## deploy.yaml — Jobs

Jobs obrigatorios: `resolve`, `build`, `infra` (needs: [build]), `deploy` (needs: [build, infra, resolve]).
NAO ha job `liquibase` — nao ha banco de dados.
NAO ha step `npm run build` — Express nao precisa de build step.
