# Validacao — Especifico: Node.js 24 + Express + Google Sheets API

## Stack deste template
- Framework: Express 5
- Runtime: Node.js 24
- Storage: Google Sheets via googleapis
- Sem banco de dados relacional

## Criterios especificos de selecao

- Se codigo e Node.js/Express + Google Sheets API: este template e adequado
- Se codigo e Next.js + banco SQL: recomendar `base-node24-next-prisma-postgresql`
- Se codigo e Next.js sem banco: recomendar `base-node24-next`
- Se codigo e React SPA: recomendar `base-node24-vite-express`

## Aprovacao

APROVAR se:
- App usa Node.js com Express (ou servidor HTTP simples)
- App usa Google Sheets como storage (via googleapis service account)
- Sem banco de dados relacional

## Rejeicao

REJEITAR se:
- App usa Next.js — recomendar templates Next.js
- App usa banco de dados relacional — recomendar templates com Prisma
- App usa banco NoSQL (MongoDB, Firebase) — nenhum template suporta
- App usa runtime diferente de Node.js (Python, Go, Java)
