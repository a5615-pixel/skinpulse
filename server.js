require('dotenv').config();

const express = require('express');
const session = require('express-session');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const bcrypt = require('bcryptjs');
const crypto = require('crypto');
const path = require('path');
const db = require('./db');
const { createMollieClient } = require('@mollie/api-client');

const app = express();

if (process.env.NODE_ENV === 'production') {
  app.set('trust proxy', 1);
}

const PORT = Number(process.env.PORT || 3001);

const PUBLIC_URL = (
  process.env.PUBLIC_URL ||
  `http://localhost:${PORT}`
).replace(/\/$/, '');

const PRODUCT_NAME = 'CS2 Inventory Audit';
const PRODUCT_PRICE_CENTS = 1000;

const mollie = process.env.MOLLIE_API_KEY
  ? createMollieClient({
      apiKey: process.env.MOLLIE_API_KEY
    })
  : null;


/* =========================================================
   EXPRESS
========================================================= */

app.set('view engine', 'ejs');

app.set(
  'views',
  path.join(__dirname, 'views')
);

app.use(
  '/static',
  express.static(
    path.join(__dirname, 'public')
  )
);


/* =========================================================
   SEGURANÇA
========================================================= */

app.use(
  helmet({
    contentSecurityPolicy: {
      directives: {
        "default-src": [
          "'self'"
        ],

        "style-src": [
          "'self'",
          "'unsafe-inline'"
        ],

        "script-src": [
          "'self'"
        ],

        "img-src": [
          "'self'",
          "data:",
          "https://community.fastly.steamstatic.com",
          "https://steamcommunity-a.akamaihd.net"
        ],

        "form-action": [
          "'self'",
          "https://www.mollie.com",
          "https://*.mollie.com"
        ],

        "frame-ancestors": [
          "'none'"
        ]
      }
    }
  })
);


app.use(
  express.urlencoded({
    extended: false,
    limit: '50kb'
  })
);

app.use(
  express.json({
    limit: '50kb'
  })
);


/* =========================================================
   SESSÕES
========================================================= */

app.use(
  session({
    secret:
      process.env.SESSION_SECRET ||
      'DEV_ONLY_CHANGE_ME',

    resave: false,

    saveUninitialized: false,

    cookie: {
      httpOnly: true,
      sameSite: 'lax',

      secure:
        process.env.NODE_ENV === 'production',

      maxAge:
        1000 * 60 * 60 * 24 * 7
    }
  })
);


/* =========================================================
   RATE LIMIT
========================================================= */

app.use(
  rateLimit({
    windowMs: 60 * 1000,
    limit: 120,
    standardHeaders: true,
    legacyHeaders: false
  })
);


const authLimiter = rateLimit({
  windowMs: 10 * 60 * 1000,
  limit: 25,
  standardHeaders: true,
  legacyHeaders: false
});


/* =========================================================
   FUNÇÕES GERAIS
========================================================= */

function now() {
  return new Date().toISOString();
}


function uid() {
  return crypto.randomUUID();
}


function normalizeEmail(value) {
  return String(value || '')
    .trim()
    .toLowerCase();
}


/* =========================================================
   AUTH
========================================================= */

function requireAuth(req, res, next) {

  if (!req.session.userId) {
    return res.redirect('/login');
  }

  next();
}


function isAdmin(req) {

  return Boolean(
    req.session.userEmail &&
    process.env.ADMIN_EMAIL &&
    req.session.userEmail.toLowerCase() ===
      process.env.ADMIN_EMAIL.toLowerCase()
  );
}


function requireAdmin(req, res, next) {

  if (!req.session.userId) {
    return res.redirect('/login');
  }

  if (!isAdmin(req)) {
    return res
      .status(403)
      .send('Acesso negado.');
  }

  next();
}


/* =========================================================
   CSRF
========================================================= */

function csrfMiddleware(req, res, next) {

  if (!req.session.csrfToken) {
    req.session.csrfToken =
      crypto
        .randomBytes(24)
        .toString('hex');
  }

  res.locals.csrfToken =
    req.session.csrfToken;

  next();
}


app.use(csrfMiddleware);


function verifyCsrf(req, res, next) {

  const token =
    String(
      req.body?._csrf ||
      ''
    );

  if (
    !token ||
    token !== req.session.csrfToken
  ) {

    return res
      .status(403)
      .send(
        'Pedido inválido. Atualiza a página e tenta novamente.'
      );
  }

  next();
}


/* =========================================================
   VARIÁVEIS GLOBAIS DAS VIEWS
========================================================= */

app.use((req, res, next) => {

  res.locals.user =
    req.session.userId
      ? {
          id: req.session.userId,
          email: req.session.userEmail
        }
      : null;

  res.locals.isAdmin =
    isAdmin(req);

  res.locals.whatsapp =
    'https://wa.me/351962250419';

  res.locals.discord =
    'https://discord.gg/D3w7nrtjb2';

  res.locals.productPrice =
    '10,00 €';

  res.locals.paymentReady =
    Boolean(mollie);

  res.locals.devMode =
    process.env.NODE_ENV !== 'production' &&
    process.env.ENABLE_FAKE_PAYMENTS === 'true';

  next();
});


/* =========================================================
   PEDIDOS
========================================================= */

function getOrderForUser(
  orderId,
  userId
) {

  return db
    .prepare(`
      SELECT *
      FROM orders
      WHERE id = ?
      AND user_id = ?
    `)
    .get(
      orderId,
      userId
    );
}


/* =========================================================
   MARCAR PEDIDO COMO PAGO
========================================================= */

function markPaid(
  order,
  paymentId
) {

  if (!order) {
    return;
  }

  if (
    [
      'paid',
      'submitted',
      'delivered'
    ].includes(order.status)
  ) {
    return;
  }

  db.prepare(`
    UPDATE orders

    SET
      status = 'paid',
      paid_at = ?,
      mollie_payment_id =
        COALESCE(
          mollie_payment_id,
          ?
        )

    WHERE id = ?
  `).run(
    now(),
    paymentId || null,
    order.id
  );
}


/* =========================================================
   MOLLIE
========================================================= */

async function reconcileMollie(order) {

  if (
    !mollie ||
    !order?.mollie_payment_id
  ) {
    return order;
  }

  try {

    const payment =
      await mollie.payments.get(
        order.mollie_payment_id
      );

    const metadataOrderId =
      typeof payment.metadata === 'object' &&
      payment.metadata
        ? payment.metadata.orderId
        : null;

    const expectedValue =
      (
        order.amount_cents /
        100
      ).toFixed(2);

    const amountMatches =
      payment.amount?.currency ===
        order.currency &&
      payment.amount?.value ===
        expectedValue;

    if (
      payment.status === 'paid' &&
      metadataOrderId === order.id &&
      amountMatches
    ) {

      markPaid(
        order,
        payment.id
      );
    }

  } catch (err) {

    console.error(
      'Erro Mollie:',
      err.message
    );
  }

  return db
    .prepare(`
      SELECT *
      FROM orders
      WHERE id = ?
    `)
    .get(order.id);
}


/* =========================================================
   DISCORD
========================================================= */

async function notifyDiscord(message) {

  const url =
    process.env.DISCORD_WEBHOOK_URL;

  if (!url) {
    return;
  }

  try {

    await fetch(
      url,
      {
        method: 'POST',

        headers: {
          'content-type':
            'application/json'
        },

        body:
          JSON.stringify({
            content: message
          })
      }
    );

  } catch (err) {

    console.error(
      'Discord:',
      err.message
    );
  }
}


/* =========================================================
   STEAM ID
========================================================= */

function extractSteamId(value) {

  const text =
    String(value || '').trim();

  if (/^\d{17}$/.test(text)) {
    return text;
  }

  const match =
    text.match(
      /(?:profiles\/|inventory\/)(\d{17})/
    );

  return match
    ? match[1]
    : null;
}


/* =========================================================
   PREÇOS STEAM
========================================================= */

const steamPriceCache =
  new Map();


function sleep(ms) {

  return new Promise(
    resolve =>
      setTimeout(resolve, ms)
  );
}


function parseSteamPrice(text) {

  if (!text) {
    return 0;
  }

  let value =
    String(text)
      .replace(/\s/g, '')
      .replace(/[^\d,.-]/g, '');

  if (!value) {
    return 0;
  }

  if (
    value.includes(',') &&
    !value.includes('.')
  ) {

    value =
      value.replace(',', '.');

  } else if (
    value.includes(',') &&
    value.includes('.') &&
    value.lastIndexOf(',') >
      value.lastIndexOf('.')
  ) {

    value =
      value
        .replace(/\./g, '')
        .replace(',', '.');

  } else if (
    value.includes(',') &&
    value.includes('.') &&
    value.lastIndexOf('.') >
      value.lastIndexOf(',')
  ) {

    value =
      value.replace(/,/g, '');
  }

  return Number(value) || 0;
}


async function getSteamMarketPrice(
  marketHashName
) {

  const cached =
    steamPriceCache.get(
      marketHashName
    );

  if (
    cached &&
    Date.now() - cached.time <
      15 * 60 * 1000
  ) {
    return cached.data;
  }

  const params =
    new URLSearchParams({
      appid: '730',
      currency: '3',
      country: 'PT',
      market_hash_name:
        marketHashName
    });

  try {

    const response =
      await fetch(
        `https://steamcommunity.com/market/priceoverview/?${params.toString()}`,
        {
          headers: {
            'user-agent':
              'Mozilla/5.0 SkinPulse/1.0'
          },

          signal:
            AbortSignal.timeout(12000)
        }
      );

    if (!response.ok) {

      console.log(
        `Steam Market HTTP ${response.status}: ${marketHashName}`
      );

      return null;
    }

    const data =
      await response.json();

    if (!data?.success) {
      return null;
    }

    const result = {

      lowestText:
        data.lowest_price ||
        null,

      medianText:
        data.median_price ||
        null,

      volume:
        data.volume ||
        null,

      lowest:
        parseSteamPrice(
          data.lowest_price
        ),

      median:
        parseSteamPrice(
          data.median_price
        )
    };

    steamPriceCache.set(
      marketHashName,
      {
        time: Date.now(),
        data: result
      }
    );

    return result;

  } catch (err) {

    console.error(
      `Erro preço Steam ${marketHashName}:`,
      err.message
    );

    return null;
  }
}


/* =========================================================
   INVENTÁRIO STEAM + IMAGENS + PREÇOS
========================================================= */

async function buildInventorySnapshot(
  steamId
) {

  const url =
    `https://steamcommunity.com/inventory/${encodeURIComponent(
      steamId
    )}/730/2?l=english&count=2000`;

  const response =
    await fetch(
      url,
      {
        headers: {
          'user-agent':
            'SkinPulse/1.0 inventory-audit'
        },

        signal:
          AbortSignal.timeout(15000)
      }
    );

  if (!response.ok) {

    throw new Error(
      `Steam respondeu com HTTP ${response.status}. O inventário pode estar privado ou indisponível.`
    );
  }

  const data =
    await response.json();

  if (
    !data ||
    !Array.isArray(data.assets) ||
    !Array.isArray(data.descriptions)
  ) {

    throw new Error(
      'Não foi possível ler o inventário. Confirma que o inventário está público.'
    );
  }

  const descriptions =
    new Map();

  for (const d of data.descriptions) {

    descriptions.set(
      `${d.classid}_${d.instanceid || '0'}`,
      d
    );
  }

  const counts =
    new Map();

  const marketableItems =
    new Map();

  let tradeable = 0;
  let marketable = 0;

  for (const asset of data.assets) {

    const description =
      descriptions.get(
        `${asset.classid}_${asset.instanceid || '0'}`
      ) ||
      descriptions.get(
        `${asset.classid}_0`
      );

    const name =
      description?.market_hash_name ||
      description?.name ||
      `Item ${asset.classid}`;

    const amount =
      Number(
        asset.amount || 1
      );

    counts.set(
      name,
      (
        counts.get(name) ||
        0
      ) + amount
    );

    if (description?.tradable) {
      tradeable += amount;
    }

    if (description?.marketable) {

      marketable += amount;

      const existing =
        marketableItems.get(name);

      const image =
        description?.icon_url
          ? `https://community.fastly.steamstatic.com/economy/image/${description.icon_url}/160fx120f`
          : null;

      marketableItems.set(
        name,
        {
          quantity:
            (
              existing?.quantity ||
              0
            ) + amount,

          image:
            existing?.image ||
            image
        }
      );
    }
  }


  const duplicates =
    [...counts.entries()]
      .filter(
        ([, count]) =>
          count > 1
      )
      .sort(
        (a, b) =>
          b[1] - a[1]
      )
      .slice(0, 20);


  const entries =
    [...marketableItems.entries()]
      .slice(0, 40);


  const pricedItems =
    [];

  let steamTotal = 0;
  let foundPrices = 0;


  for (
    const [
      name,
      itemData
    ] of entries
  ) {

    const quantity =
      itemData.quantity;

    const image =
      itemData.image;

    const price =
      await getSteamMarketPrice(
        name
      );

    if (
      price &&
      price.lowest > 0
    ) {

      const total =
        price.lowest *
        quantity;

      steamTotal += total;

      foundPrices++;

      pricedItems.push({
        name,
        quantity,
        image,
        total,
        ...price
      });

    } else {

      pricedItems.push({
        name,
        quantity,
        image,
        total: 0,
        lowestText: null,
        medianText: null,
        volume: null
      });
    }

    await sleep(700);
  }


  pricedItems.sort(
    (a, b) =>
      b.total - a.total
  );


  const pricedLines =
    pricedItems.map(item => {

      const quantityText =
        item.quantity > 1
          ? ` ×${item.quantity}`
          : '';

      let line;

      if (!item.lowestText) {

        line =
          `- ${item.name}${quantityText} — preço não encontrado`;

      } else {

        line =
          `- ${item.name}${quantityText} — ${item.lowestText}`;

        if (item.quantity > 1) {

          line +=
            ` — Total: ${item.total
              .toFixed(2)
              .replace('.', ',')} €`;
        }

        if (item.volume) {

          line +=
            ` — Volume: ${item.volume}`;
        }
      }

      if (item.image) {

        line +=
          ` ||IMG||${item.image}`;
      }

      return line;
    });


  const quickSaleEstimate =
    steamTotal * 0.85;


  return [

    'SKINPULSE — ANÁLISE AUTOMÁTICA',

    '',

    `SteamID64: ${steamId}`,

    '',

    'RESUMO',

    `Itens CS2 detetados: ${data.assets.length}`,

    `Nomes únicos: ${counts.size}`,

    `Itens tradable: ${tradeable}`,

    `Itens marketable: ${marketable}`,

    `Preços encontrados: ${foundPrices}/${entries.length}`,

    '',

    'VALOR ESTIMADO',

    `Steam Market: ${steamTotal
      .toFixed(2)
      .replace('.', ',')} €`,

    `Venda rápida estimada*: ${quickSaleEstimate
      .toFixed(2)
      .replace('.', ',')} €`,

    '',

    '*A venda rápida é apenas uma estimativa inicial de 85% do valor Steam.',

    'Não é um preço garantido nem representa necessariamente o valor recebido num marketplace externo.',

    '',

    'ITENS COM PREÇO',

    pricedLines.length
      ? pricedLines.join('\n')
      : '- Não foi possível encontrar preços.',

    '',

    'REPETIDOS',

    duplicates.length
      ? duplicates
          .map(
            ([name, count]) =>
              `- ${name} ×${count}`
          )
          .join('\n')
      : '- Nenhum repetido detetado.',

    '',

    'NOTA',

    'Os preços podem mudar a qualquer momento.',

    'Float, pattern, stickers aplicados e possíveis overpays ainda não estão incluídos.',

    'Medalhas, badges e itens não marketable não entram no valor Steam calculado.'

  ].join('\n');
}


/* =========================================================
   HOME
========================================================= */

app.get(
  '/',
  (req, res) => {

    res.render(
      'home',
      {
        title:
          'SkinPulse — CS2 Inventory Audit'
      }
    );
  }
);


/* =========================================================
   REGISTO
========================================================= */

app.get(
  '/register',
  (req, res) => {

    if (req.session.userId) {
      return res.redirect(
        '/dashboard'
      );
    }

    res.render(
      'register',
      {
        title:
          'Criar conta',

        error:
          null
      }
    );
  }
);


app.post(
  '/register',
  authLimiter,
  verifyCsrf,
  async (req, res) => {

    const email =
      normalizeEmail(
        req.body.email
      );

    const password =
      String(
        req.body.password ||
        ''
      );

    if (
      !email.includes('@') ||
      password.length < 8
    ) {

      return res
        .status(400)
        .render(
          'register',
          {
            title:
              'Criar conta',

            error:
              'Usa um email válido e uma password com pelo menos 8 caracteres.'
          }
        );
    }

    const exists =
      db
        .prepare(`
          SELECT id
          FROM users
          WHERE email = ?
        `)
        .get(email);

    if (exists) {

      return res
        .status(400)
        .render(
          'register',
          {
            title:
              'Criar conta',

            error:
              'Já existe uma conta com esse email.'
          }
        );
    }

    const id =
      uid();

    const passwordHash =
      await bcrypt.hash(
        password,
        12
      );

    db.prepare(`
      INSERT INTO users (
        id,
        email,
        password_hash,
        created_at
      )

      VALUES (
        ?,
        ?,
        ?,
        ?
      )
    `).run(
      id,
      email,
      passwordHash,
      now()
    );

    req.session.userId =
      id;

    req.session.userEmail =
      email;

    res.redirect(
      '/dashboard'
    );
  }
);


/* =========================================================
   LOGIN
========================================================= */

app.get(
  '/login',
  (req, res) => {

    if (req.session.userId) {

      return res.redirect(
        '/dashboard'
      );
    }

    res.render(
      'login',
      {
        title:
          'Entrar',

        error:
          null
      }
    );
  }
);


app.post(
  '/login',
  authLimiter,
  verifyCsrf,
  async (req, res) => {

    const email =
      normalizeEmail(
        req.body.email
      );

    const password =
      String(
        req.body.password ||
        ''
      );

    const user =
      db
        .prepare(`
          SELECT *
          FROM users
          WHERE email = ?
        `)
        .get(email);

    if (
      !user ||
      !(
        await bcrypt.compare(
          password,
          user.password_hash
        )
      )
    ) {

      return res
        .status(401)
        .render(
          'login',
          {
            title:
              'Entrar',

            error:
              'Email ou password incorretos.'
          }
        );
    }

    req.session.userId =
      user.id;

    req.session.userEmail =
      user.email;

    res.redirect(
      '/dashboard'
    );
  }
);


/* =========================================================
   LOGOUT
========================================================= */

app.post(
  '/logout',
  verifyCsrf,
  (req, res) => {

    req.session.destroy(
      () => {
        res.redirect('/');
      }
    );
  }
);


/* =========================================================
   NOVO PEDIDO MB WAY MANUAL
========================================================= */

app.post(
  '/manual-checkout',
  requireAuth,
  verifyCsrf,
  (req, res) => {

    const orderId =
      uid();

    db.prepare(`
      INSERT INTO orders (
        id,
        user_id,
        product_name,
        amount_cents,
        currency,
        status,
        payment_method,
        created_at
      )

      VALUES (
        ?,
        ?,
        ?,
        ?,
        'EUR',
        'awaiting_payment',
        'mbway_manual',
        ?
      )
    `).run(
      orderId,
      req.session.userId,
      PRODUCT_NAME,
      PRODUCT_PRICE_CENTS,
      now()
    );

    res.redirect(
      `/order/${orderId}`
    );
  }
);


/* =========================================================
   CLIENTE INDICA PAGAMENTO
========================================================= */

app.post(
  '/order/:id/claim-manual-payment',
  requireAuth,
  verifyCsrf,
  (req, res) => {

    const order =
      getOrderForUser(
        req.params.id,
        req.session.userId
      );

    if (!order) {

      return res
        .status(404)
        .send(
          'Pedido não encontrado.'
        );
    }

    if (
      ![
        'awaiting_payment',
        'payment_claimed'
      ].includes(order.status)
    ) {

      return res
        .status(400)
        .send(
          'Este pedido já não está à espera de pagamento.'
        );
    }

    const note =
      String(
        req.body.paymentNote ||
        ''
      )
        .trim()
        .slice(0, 500);

    if (note.length < 3) {

      return res
        .status(400)
        .send(
          'Indica o nome usado no pagamento e a hora aproximada.'
        );
    }

    db.prepare(`
      UPDATE orders

      SET
        status = 'payment_claimed',
        manual_payment_note = ?,
        manual_payment_claimed_at = ?

      WHERE id = ?
    `).run(
      note,
      now(),
      order.id
    );

    notifyDiscord(
      `💶 Pagamento MB WAY indicado — pedido ${order.id.slice(0, 8)}`
    );

    res.redirect(
      `/order/${order.id}`
    );
  }
);


/* =========================================================
   DASHBOARD
========================================================= */

app.get(
  '/dashboard',
  requireAuth,
  (req, res) => {

    const orders =
      db
        .prepare(`
          SELECT *
          FROM orders

          WHERE user_id = ?

          ORDER BY created_at DESC
        `)
        .all(
          req.session.userId
        );

    res.render(
      'dashboard',
      {
        title:
          'A minha conta',

        orders
      }
    );
  }
);


/* =========================================================
   CHECKOUT MOLLIE
========================================================= */

app.post(
  '/checkout',
  requireAuth,
  verifyCsrf,
  async (req, res) => {

    if (!mollie) {

      return res
        .status(503)
        .send(
          'A Mollie ainda não está configurada.'
        );
    }

    const orderId =
      uid();

    db.prepare(`
      INSERT INTO orders (
        id,
        user_id,
        product_name,
        amount_cents,
        currency,
        status,
        created_at
      )

      VALUES (
        ?,
        ?,
        ?,
        ?,
        'EUR',
        'created',
        ?
      )
    `).run(
      orderId,
      req.session.userId,
      PRODUCT_NAME,
      PRODUCT_PRICE_CENTS,
      now()
    );

    try {

      const payment =
        await mollie.payments.create({

          amount: {
            currency: 'EUR',
            value: '10.00'
          },

          description:
            `${PRODUCT_NAME} — ${orderId.slice(0, 8)}`,

          redirectUrl:
            `${PUBLIC_URL}/order/${orderId}`,

          webhookUrl:
            `${PUBLIC_URL}/webhooks/mollie`,

          method:
            'mbway',

          locale:
            'pt_PT',

          metadata: {
            orderId,
            userId:
              req.session.userId,
            product:
              'inventory-audit'
          }
        });

      db.prepare(`
        UPDATE orders
        SET mollie_payment_id = ?
        WHERE id = ?
      `).run(
        payment.id,
        orderId
      );

      const checkoutUrl =
        payment.getCheckoutUrl();

      if (!checkoutUrl) {

        throw new Error(
          'Mollie não devolveu checkout URL.'
        );
      }

      return res.redirect(
        checkoutUrl
      );

    } catch (err) {

      console.error(err);

      db.prepare(`
        UPDATE orders
        SET status = 'payment_error'
        WHERE id = ?
      `).run(
        orderId
      );

      return res
        .status(500)
        .send(
          'Não foi possível iniciar o pagamento.'
        );
    }
  }
);


/* =========================================================
   WEBHOOK MOLLIE
========================================================= */

app.post(
  '/webhooks/mollie',
  async (req, res) => {

    const paymentId =
      String(
        req.body?.id ||
        req.body?.data?.id ||
        ''
      ).trim();

    if (
      !paymentId ||
      !mollie
    ) {

      return res
        .status(200)
        .send('ok');
    }

    try {

      const payment =
        await mollie.payments.get(
          paymentId
        );

      const orderId =
        typeof payment.metadata === 'object' &&
        payment.metadata
          ? payment.metadata.orderId
          : null;

      if (!orderId) {

        return res
          .status(200)
          .send('ok');
      }

      const order =
        db
          .prepare(`
            SELECT *
            FROM orders
            WHERE id = ?
          `)
          .get(orderId);

      if (
        !order ||
        order.mollie_payment_id !==
          payment.id
      ) {

        return res
          .status(200)
          .send('ok');
      }

      const expectedValue =
        (
          order.amount_cents /
          100
        ).toFixed(2);

      const amountMatches =
        payment.amount?.currency ===
          order.currency &&
        payment.amount?.value ===
          expectedValue;

      if (
        payment.status === 'paid' &&
        amountMatches
      ) {

        markPaid(
          order,
          payment.id
        );
      }

      return res
        .status(200)
        .send('ok');

    } catch (err) {

      console.error(
        'Webhook Mollie:',
        err
      );

      return res
        .status(200)
        .send('ok');
    }
  }
);


/* =========================================================
   VER PEDIDO
========================================================= */

app.get(
  '/order/:id',
  requireAuth,
  async (req, res) => {

    let order =
      getOrderForUser(
        req.params.id,
        req.session.userId
      );

    if (!order) {

      return res
        .status(404)
        .send(
          'Pedido não encontrado.'
        );
    }

    order =
      await reconcileMollie(
        order
      );

    res.render(
      'order',
      {
        title:
          `Pedido ${order.id.slice(0, 8)}`,

        order,

        fakePayments:
          process.env.NODE_ENV !==
            'production' &&
          process.env.ENABLE_FAKE_PAYMENTS ===
            'true'
      }
    );
  }
);


/* =========================================================
   ANALISAR INVENTÁRIO
========================================================= */

app.post(
  '/order/:id/inventory',
  requireAuth,
  verifyCsrf,
  async (req, res) => {

    let order =
      getOrderForUser(
        req.params.id,
        req.session.userId
      );

    if (!order) {

      return res
        .status(404)
        .send(
          'Pedido não encontrado.'
        );
    }

    order =
      await reconcileMollie(
        order
      );

    if (
      ![
        'paid',
        'submitted',
        'delivered'
      ].includes(order.status)
    ) {

      return res
        .status(402)
        .send(
          'O pagamento ainda não está confirmado.'
        );
    }

    const steamId =
      extractSteamId(
        req.body.steam
      );

    const goal =
      String(
        req.body.goal ||
        ''
      )
        .trim()
        .slice(0, 1500);

    if (!steamId) {

      return res
        .status(400)
        .send(
          'Envia um SteamID64 de 17 dígitos ou um link /profiles/ válido.'
        );
    }

    try {

      const autoReport =
        await buildInventorySnapshot(
          steamId
        );

      db.prepare(`
        UPDATE orders

        SET
          steam_id = ?,
          goal = ?,
          auto_report = ?,

          status =
            CASE
              WHEN status = 'delivered'
              THEN 'delivered'
              ELSE 'submitted'
            END

        WHERE id = ?
      `).run(
        steamId,
        goal,
        autoReport,
        order.id
      );

      await notifyDiscord(
        `📦 Inventário analisado — pedido ${order.id.slice(0, 8)} — SteamID ${steamId}`
      );

      return res.redirect(
        `/order/${order.id}`
      );

    } catch (err) {

      console.error(err);

      return res
        .status(400)
        .send(
          `Não consegui analisar o inventário: ${err.message}`
        );
    }
  }
);


/* =========================================================
   DOWNLOAD RELATÓRIO
========================================================= */

app.get(
  '/order/:id/download',
  requireAuth,
  (req, res) => {

    const order =
      getOrderForUser(
        req.params.id,
        req.session.userId
      );

    if (!order) {

      return res
        .status(404)
        .send(
          'Pedido não encontrado.'
        );
    }

    if (
      ![
        'paid',
        'submitted',
        'delivered'
      ].includes(order.status)
    ) {

      return res
        .status(402)
        .send(
          'Pagamento ainda não confirmado.'
        );
    }

    const cleanAutoReport =
      String(
        order.auto_report ||
        'Snapshot automático ainda não gerado.'
      ).replace(
        /\s*\|\|IMG\|\|https?:\/\/[^\s]+/g,
        ''
      );

    const content = [

      `SkinPulse — Pedido ${order.id}`,

      `Produto: ${order.product_name}`,

      `Estado: ${order.status}`,

      `Pago em: ${order.paid_at || '-'}`,

      '',

      cleanAutoReport,

      '',

      'ANÁLISE FINAL:',

      order.final_report ||
        'A análise final ainda não foi entregue.'

    ].join('\n');

    res.setHeader(
      'content-type',
      'text/plain; charset=utf-8'
    );

    res.setHeader(
      'content-disposition',
      `attachment; filename="skinpulse-${order.id.slice(0, 8)}.txt"`
    );

    res.send(content);
  }
);


/* =========================================================
   PAGAMENTO TESTE
========================================================= */

app.post(
  '/dev/pay/:id',
  requireAuth,
  verifyCsrf,
  (req, res) => {

    if (
      process.env.NODE_ENV ===
        'production' ||
      process.env.ENABLE_FAKE_PAYMENTS !==
        'true'
    ) {

      return res
        .status(404)
        .send('Not found');
    }

    const order =
      getOrderForUser(
        req.params.id,
        req.session.userId
      );

    if (!order) {

      return res
        .status(404)
        .send(
          'Pedido não encontrado.'
        );
    }

    markPaid(
      order,
      `DEV_FAKE_PAYMENT_${order.id}`
    );

    res.redirect(
      `/order/${order.id}`
    );
  }
);


/* =========================================================
   PEDIDO TESTE
========================================================= */

app.get(
  '/dev/new-order',
  requireAuth,
  (req, res) => {

    if (
      process.env.NODE_ENV ===
        'production' ||
      process.env.ENABLE_FAKE_PAYMENTS !==
        'true'
    ) {

      return res
        .status(404)
        .send('Not found');
    }

    const orderId =
      uid();

    db.prepare(`
      INSERT INTO orders (
        id,
        user_id,
        product_name,
        amount_cents,
        currency,
        status,
        created_at
      )

      VALUES (
        ?,
        ?,
        ?,
        ?,
        'EUR',
        'created',
        ?
      )
    `).run(
      orderId,
      req.session.userId,
      PRODUCT_NAME,
      PRODUCT_PRICE_CENTS,
      now()
    );

    res.redirect(
      `/order/${orderId}`
    );
  }
);


/* =========================================================
   ADMIN
========================================================= */

app.get(
  '/admin',
  requireAdmin,
  (req, res) => {

    const orders =
      db
        .prepare(`
          SELECT
            o.*,
            u.email

          FROM orders o

          JOIN users u
            ON u.id = o.user_id

          ORDER BY
            o.created_at DESC
        `)
        .all();

    res.render(
      'admin',
      {
        title: 'Admin',
        orders
      }
    );
  }
);


/* =========================================================
   ADMIN PEDIDO
========================================================= */

app.get(
  '/admin/order/:id',
  requireAdmin,
  (req, res) => {

    const order =
      db
        .prepare(`
          SELECT
            o.*,
            u.email

          FROM orders o

          JOIN users u
            ON u.id = o.user_id

          WHERE o.id = ?
        `)
        .get(
          req.params.id
        );

    if (!order) {

      return res
        .status(404)
        .send(
          'Pedido não encontrado.'
        );
    }

    res.render(
      'admin-order',
      {
        title:
          'Editar pedido',

        order
      }
    );
  }
);


/* =========================================================
   ADMIN CONFIRMAR MB WAY
========================================================= */

app.post(
  '/admin/order/:id/approve-manual-payment',
  requireAdmin,
  verifyCsrf,
  (req, res) => {

    const order =
      db
        .prepare(`
          SELECT *
          FROM orders
          WHERE id = ?
        `)
        .get(
          req.params.id
        );

    if (!order) {

      return res
        .status(404)
        .send(
          'Pedido não encontrado.'
        );
    }

    if (
      order.payment_method !==
      'mbway_manual'
    ) {

      return res
        .status(400)
        .send(
          'Este pedido não é MB WAY manual.'
        );
    }

    if (
      ![
        'awaiting_payment',
        'payment_claimed'
      ].includes(order.status)
    ) {

      return res
        .status(400)
        .send(
          'Este pedido já não está pendente.'
        );
    }

    markPaid(
      order,
      `MBWAY_MANUAL_APPROVED_${order.id}`
    );

    res.redirect(
      `/admin/order/${order.id}`
    );
  }
);


/* =========================================================
   ADMIN ENTREGAR RELATÓRIO
========================================================= */

app.post(
  '/admin/order/:id/deliver',
  requireAdmin,
  verifyCsrf,
  (req, res) => {

    const finalReport =
      String(
        req.body.finalReport ||
        ''
      )
        .trim()
        .slice(0, 50000);

    if (!finalReport) {

      return res
        .status(400)
        .send(
          'O relatório não pode estar vazio.'
        );
    }

    const order =
      db
        .prepare(`
          SELECT *
          FROM orders
          WHERE id = ?
        `)
        .get(
          req.params.id
        );

    if (!order) {

      return res
        .status(404)
        .send(
          'Pedido não encontrado.'
        );
    }

    if (
      ![
        'paid',
        'submitted',
        'delivered'
      ].includes(order.status)
    ) {

      return res
        .status(400)
        .send(
          'Este pedido ainda não está pago.'
        );
    }

    db.prepare(`
      UPDATE orders

      SET
        final_report = ?,
        status = 'delivered',
        delivered_at = ?

      WHERE id = ?
    `).run(
      finalReport,
      now(),
      order.id
    );

    res.redirect(
      `/admin/order/${order.id}`
    );
  }
);


/* =========================================================
   HEALTH
========================================================= */

app.get(
  '/health',
  (req, res) => {

    res.json({
      ok: true,
      service: 'skinpulse'
    });
  }
);


/* =========================================================
   404
========================================================= */

app.use(
  (req, res) => {

    res
      .status(404)
      .send(
        'Página não encontrada.'
      );
  }
);


/* =========================================================
   START
========================================================= */

app.listen(
  PORT,
  () => {

    console.log(
      `SkinPulse: http://localhost:${PORT}`
    );

    if (!mollie) {

      console.log(
        '⚠️ Mollie não configurada. MB WAY manual continua disponível.'
      );
    }

    if (
      !process.env.SESSION_SECRET ||
      process.env.SESSION_SECRET ===
        'DEV_ONLY_CHANGE_ME'
    ) {

      console.log(
        '⚠️ Define SESSION_SECRET antes de publicar.'
      );
    }
  }
);