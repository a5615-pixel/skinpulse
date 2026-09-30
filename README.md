# SkinPulse MVP

MVP funcional para vender **CS2 Inventory Audit** por 10 €.

## O que já faz

- Criar conta / login.
- Checkout MB WAY através da Mollie.
- Cria pedidos automaticamente.
- Webhook confirma o pagamento no servidor.
- Só desbloqueia a compra quando o pagamento está realmente `paid`.
- Área privada do cliente.
- Cliente submete SteamID64.
- Snapshot automático de inventário CS2 público.
- Painel ADM.
- Entrega do relatório final ao cliente.
- Download do pedido em `.txt`.
- Discord e WhatsApp integrados.
- IBAN pedido pelo WhatsApp.
- Proteções básicas: passwords com bcrypt, CSRF, rate limit, headers Helmet, cookies httpOnly.
- Modo DEV para testar sem gastar dinheiro.

---

## 1) Instalar

Precisas de Node.js instalado.

Abre o terminal dentro da pasta:

```bash
npm install
```

Copia `.env.example` para `.env`.

No Windows PowerShell:

```powershell
Copy-Item .env.example .env
```

Depois abre `.env` e altera pelo menos:

```env
SESSION_SECRET=uma-chave-grande-e-aleatoria
ADMIN_EMAIL=o-teu-email
```

## 2) Testar SEM dinheiro

Mantém:

```env
ENABLE_FAKE_PAYMENTS=true
```

Arranca:

```bash
npm run dev
```

Abre:

```text
http://localhost:3000
```

Cria uma conta.

Sem Mollie configurada, no Dashboard aparece a opção para criares um pedido de teste.
Dentro do pedido podes clicar em **DEV: simular pagamento aprovado**.

A simulação é automaticamente desativada quando `NODE_ENV=production`.

## 3) MB WAY automático com Mollie

Cria uma conta Mollie e obtém uma API key de teste.

No `.env`:

```env
MOLLIE_API_KEY=test_xxxxxxxxx
PUBLIC_URL=https://o-teu-dominio.pt
```

O `PUBLIC_URL` precisa de ser público para a Mollie conseguir chamar:

```text
https://o-teu-dominio.pt/webhooks/mollie
```

Depois, quando estiver tudo testado e a tua conta/método MB WAY estiver aprovado, troca a key `test_...` pela `live_...`.

### Importante

Não uses a rota DEV em produção.
Mantém `ENABLE_FAKE_PAYMENTS=false` quando publicares.

## 4) Painel ADM

Regista no site uma conta com o mesmo email que colocaste em:

```env
ADMIN_EMAIL=o-teu-email
```

Depois abre:

```text
/admin
```

Podes abrir um pedido, ver o SteamID, o snapshot e colar a análise final.
Ao guardar, o cliente vê o relatório imediatamente na sua área privada.

## 5) Discord

Para receber avisos de compras no Discord, cria um **Webhook** num canal do teu servidor e cola em:

```env
DISCORD_WEBHOOK_URL=https://discord.com/api/webhooks/...
```

O link de convite do servidor já está configurado:

```text
https://discord.gg/D3w7nrtjb2
```

## 6) WhatsApp e IBAN

WhatsApp / MB WAY manual:

```text
+351 962 250 419
```

O IBAN não é mostrado publicamente. O botão abre o WhatsApp para o cliente o pedir.

---

## O que ainda não é 100% automático

O pagamento e o desbloqueio **podem ser automáticos**.

O snapshot do inventário também é automático.

A **avaliação monetária final** ainda fica para revisão no painel ADM, porque preços, floats, patterns e stickers requerem fontes de mercado/inspect específicas. O próximo passo pode ligar uma API de preços/float para automatizar essa parte também.

## Antes de publicar

- Usa uma `SESSION_SECRET` forte.
- Define `ENABLE_FAKE_PAYMENTS=false`.
- Usa HTTPS.
- Configura a key Mollie no servidor, nunca no browser.
- Mantém backups da pasta `data/`.
- Para muitos clientes, migra SQLite para PostgreSQL.


## Nota para Node.js 24 / Windows

Esta versão foi atualizada para `better-sqlite3` 13.x e já não usa `connect-sqlite3`.
Isto evita a instalação de módulos SQLite adicionais durante o teste local.

Se tiveste uma instalação falhada anteriormente, apaga `node_modules` e `package-lock.json`
antes de executar novamente `npm install`.

Em PowerShell:

```powershell
Remove-Item -Recurse -Force node_modules -ErrorAction SilentlyContinue
Remove-Item package-lock.json -Force -ErrorAction SilentlyContinue
npm cache verify
npm install
```

As sessões usam MemoryStore apenas neste MVP local. Antes de produção devem ser migradas
para Redis ou PostgreSQL.


## MB WAY manual sem Mollie

Esta versão permite vender sem Mollie:

1. Cliente cria conta.
2. Clica **Nova análise — 10 € (MB WAY)**.
3. Vê o número `+351 962 250 419`.
4. Faz o pagamento na app MB WAY.
5. Clica **Já paguei** e indica nome/hora.
6. No painel `/admin`, o administrador abre o pedido.
7. Confirma na app bancária/MB WAY se os 10 € chegaram.
8. Só depois clica **Confirmo que recebi 10 €**.
9. O pedido passa a `paid` e o cliente pode submeter o inventário.

Nunca aprovar apenas com base no que o cliente escreve ou numa screenshot; confirmar sempre a entrada real do dinheiro.
