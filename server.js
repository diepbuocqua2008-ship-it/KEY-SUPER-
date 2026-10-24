require('dotenv').config();
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const express = require('express');
const helmet = require('helmet');
const session = require('express-session');
const SQLiteStore = require('connect-sqlite3')(session);
const rateLimit = require('express-rate-limit');
const bcrypt = require('bcryptjs');
const db = require('./store');

const app = express();
const isProd = process.env.NODE_ENV === 'production';
const PORT = Number(process.env.PORT || 3000);
const BASE_URL = process.env.BASE_URL || `http://localhost:${PORT}`;
const DATA_DIR = path.resolve(process.env.DB_FILE ? path.dirname(process.env.DB_FILE) : './data');
fs.mkdirSync(DATA_DIR, { recursive: true });

if (isProd && (!process.env.SESSION_SECRET || process.env.SESSION_SECRET.length < 32)) {
  throw new Error('SESSION_SECRET must be at least 32 characters in production.');
}
if (isProd && !BASE_URL.startsWith('https://')) {
  throw new Error('BASE_URL must use HTTPS in production.');
}
app.disable('x-powered-by');
if (isProd) app.set('trust proxy', 1);
app.use(helmet({
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'self'"],
      scriptSrc: ["'self'"],
      styleSrc: ["'self'", "'unsafe-inline'"],
      imgSrc: ["'self'", 'data:', 'https://*.vietqr.io', 'https://img.vietqr.io', 'https://images.unsplash.com'],
      connectSrc: ["'self'"],
      objectSrc: ["'none'"],
      upgradeInsecureRequests: isProd ? [] : null
    }
  }
}));

// SePay HMAC must be verified against the exact raw request bytes, before JSON parsing.
app.post('/api/webhooks/sepay',
  express.raw({ type: 'application/json', limit: '256kb' }),
  (req, res) => {
    try {
      const secret = process.env.SEPAY_WEBHOOK_SECRET;
      if (!secret) return res.status(503).json({ success: false, error: 'Webhook is not configured' });
      const signature = req.get('X-SePay-Signature') || '';
      const timestamp = req.get('X-SePay-Timestamp') || '';
      if (!/^\d{10}$/.test(timestamp)) return res.status(401).json({ success: false });
      const age = Math.abs(Math.floor(Date.now() / 1000) - Number(timestamp));
      if (age > 300) return res.status(401).json({ success: false, error: 'Expired timestamp' });
      const expected = 'sha256=' + crypto.createHmac('sha256', secret)
        .update(`${timestamp}.`).update(req.body).digest('hex');
      const a = Buffer.from(signature);
      const b = Buffer.from(expected);
      if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) {
        return res.status(401).json({ success: false, error: 'Invalid signature' });
      }
      const event = JSON.parse(req.body.toString('utf8'));
      const outcome = db.applySepayTransfer(event, {
        expectedAccount: process.env.SEPAY_BANK_ACCOUNT_NUMBER || '',
        requireIncoming: process.env.SEPAY_REQUIRE_INCOMING !== 'false'
      });
      // SePay expects HTTP 200 + success:true for handled/duplicate notifications.
      if (outcome.ok) return res.status(200).json({ success: true, status: outcome.status });
      // Return 200 for verified but unrelated transactions to prevent pointless retries.
      if (outcome.status === 'ignored') return res.status(200).json({ success: true, status: 'ignored' });
      return res.status(400).json({ success: false, error: outcome.error || 'Could not process transaction' });
    } catch (err) {
      console.error('SePay webhook error:', err.message);
      return res.status(400).json({ success: false, error: 'Invalid webhook payload' });
    }
  }
);

app.use(express.json({ limit: '64kb' }));
app.use(express.urlencoded({ extended: false, limit: '16kb' }));
app.use(session({
  name: 'keyvn.sid',
  secret: process.env.SESSION_SECRET || 'development-only-secret-change-this-before-deploying',
  resave: false,
  saveUninitialized: false,
  rolling: true,
  store: new SQLiteStore({ db: 'sessions.sqlite', dir: DATA_DIR }),
  cookie: {
    httpOnly: true,
    sameSite: 'lax',
    secure: isProd,
    maxAge: 1000 * 60 * 60 * 12
  }
}));

const authLimiter = rateLimit({ windowMs: 15 * 60 * 1000, limit: 20, standardHeaders: true, legacyHeaders: false });
const apiLimiter = rateLimit({ windowMs: 60 * 1000, limit: 120, standardHeaders: true, legacyHeaders: false });
app.use('/api/', apiLimiter);

function safeUser(row) {
  if (!row) return null;
  return { id: row.id, username: row.username, email: row.email, balance: row.balance, role: row.role, createdAt: row.created_at, rank: db.getRank(row.id) };
}
function requireAuth(req, res, next) {
  if (!req.session.userId) return res.status(401).json({ error: 'Vui lòng đăng nhập.' });
  next();
}
function requireAdmin(req, res, next) {
  if (!req.session.userId) return res.status(401).json({ error: 'Vui lòng đăng nhập.' });
  const user = db.getUserById(req.session.userId);
  if (!user || user.role !== 'admin') return res.status(403).json({ error: 'Bạn không có quyền quản trị.' });
  req.user = user;
  next();
}
function csrfGuard(req, res, next) {
  if (['GET', 'HEAD', 'OPTIONS'].includes(req.method)) return next();
  // SameSite=Lax cookies + Origin validation for browser-originated state changes.
  const origin = req.get('origin');
  if (origin) {
    try {
      const got = new URL(origin);
      const expected = new URL(BASE_URL);
      if (got.host !== expected.host || got.protocol !== expected.protocol) {
        return res.status(403).json({ error: 'Origin không hợp lệ.' });
      }
    } catch { return res.status(403).json({ error: 'Origin không hợp lệ.' }); }
  }
  next();
}
app.use('/api', csrfGuard);

app.get('/api/config', (req, res) => {
  res.json({
    shopName: process.env.SHOP_NAME || 'KEYVN',
    currency: 'VND',
    bankTransferEnabled: Boolean(process.env.BANK_BIN && process.env.BANK_ACCOUNT_NUMBER && process.env.BANK_ACCOUNT_NAME),
    user: safeUser(req.session.userId ? db.getUserById(req.session.userId) : null)
  });
});

app.get('/api/products', (req, res) => res.json({ products: db.listProducts() }));
app.get('/api/me', (req, res) => res.json({ user: safeUser(req.session.userId ? db.getUserById(req.session.userId) : null) }));

app.post('/api/auth/register', authLimiter, async (req, res) => {
  const username = String(req.body.username || '').trim();
  const email = String(req.body.email || '').trim().toLowerCase();
  const password = String(req.body.password || '');
  if (!/^[a-zA-Z0-9_]{3,24}$/.test(username)) return res.status(400).json({ error: 'Tên tài khoản cần 3–24 ký tự: chữ, số hoặc dấu gạch dưới.' });
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || email.length > 254) return res.status(400).json({ error: 'Email không hợp lệ.' });
  if (password.length < 10 || password.length > 128) return res.status(400).json({ error: 'Mật khẩu phải dài từ 10 đến 128 ký tự.' });
  try {
    const hash = await bcrypt.hash(password, 12);
    const id = db.createUser({ username, email, passwordHash: hash });
    req.session.regenerate(err => {
      if (err) return res.status(500).json({ error: 'Không thể tạo phiên đăng nhập.' });
      req.session.userId = id;
      req.session.save(e => e ? res.status(500).json({ error: 'Không thể lưu phiên đăng nhập.' }) : res.status(201).json({ user: safeUser(db.getUserById(id)) }));
    });
  } catch (err) {
    if (String(err.message).includes('UNIQUE')) return res.status(409).json({ error: 'Tên tài khoản hoặc email đã được sử dụng.' });
    console.error(err); res.status(500).json({ error: 'Không thể tạo tài khoản.' });
  }
});

app.post('/api/auth/login', authLimiter, async (req, res) => {
  const login = String(req.body.login || '').trim().toLowerCase();
  const password = String(req.body.password || '');
  const user = db.getUserByLogin(login);
  const valid = user ? await bcrypt.compare(password, user.password_hash) : false;
  if (!valid) return res.status(401).json({ error: 'Thông tin đăng nhập không đúng.' });
  req.session.regenerate(err => {
    if (err) return res.status(500).json({ error: 'Không thể tạo phiên đăng nhập.' });
    req.session.userId = user.id;
    req.session.save(e => e ? res.status(500).json({ error: 'Không thể lưu phiên đăng nhập.' }) : res.json({ user: safeUser(db.getUserById(user.id)) }));
  });
});
app.post('/api/auth/logout', requireAuth, (req, res) => req.session.destroy(() => {
  res.clearCookie('keyvn.sid', { httpOnly: true, sameSite: 'lax', secure: isProd });
  res.json({ success: true });
}));

app.get('/api/wallet/transactions', requireAuth, (req, res) => {
  res.json({ transactions: db.listWalletTransactions(req.session.userId) });
});
app.get('/api/wallet/deposits', requireAuth, (req, res) => {
  res.json({ deposits: db.listDeposits(req.session.userId) });
});
app.post('/api/wallet/deposits', requireAuth, (req, res) => {
  const amount = Number(req.body.amount);
  if (!Number.isSafeInteger(amount) || amount < 10000 || amount > 50000000 || amount % 1000 !== 0) {
    return res.status(400).json({ error: 'Số tiền nạp phải từ 10.000đ đến 50.000.000đ và là bội số của 1.000đ.' });
  }
  const bankReady = process.env.BANK_BIN && process.env.BANK_ACCOUNT_NUMBER && process.env.BANK_ACCOUNT_NAME;
  if (!bankReady) return res.status(503).json({ error: 'Chưa cấu hình tài khoản nhận chuyển khoản. Vui lòng cấu hình BANK_BIN, BANK_ACCOUNT_NUMBER và BANK_ACCOUNT_NAME trong .env.' });
  const deposit = db.createDeposit(req.session.userId, amount);
  const qrParams = new URLSearchParams({
    amount: String(amount),
    addInfo: deposit.payment_code,
    accountName: process.env.BANK_ACCOUNT_NAME
  });
  const qrUrl = `https://img.vietqr.io/image/${encodeURIComponent(process.env.BANK_BIN)}-${encodeURIComponent(process.env.BANK_ACCOUNT_NUMBER)}-${encodeURIComponent(process.env.VIETQR_TEMPLATE || 'compact2')}.png?${qrParams.toString()}`;
  res.status(201).json({
    deposit: { id: deposit.id, amount: deposit.amount, paymentCode: deposit.payment_code, status: deposit.status, createdAt: deposit.created_at },
    payment: { bankAccountNumber: process.env.BANK_ACCOUNT_NUMBER, bankAccountName: process.env.BANK_ACCOUNT_NAME, bankBin: process.env.BANK_BIN, qrUrl },
    message: 'Chuyển đúng số tiền và giữ nguyên nội dung chuyển khoản. Số dư chỉ được cộng sau khi webhook SePay được xác minh.'
  });
});

app.post('/api/orders', requireAuth, (req, res) => {
  const items = Array.isArray(req.body.items) ? req.body.items : [];
  try {
    const order = db.createOrderFromWallet(req.session.userId, items, req.body.couponCode || '');
    res.status(201).json({ order });
  } catch (err) {
    res.status(400).json({ error: err.message || 'Không thể tạo đơn hàng.' });
  }
});
app.get('/api/orders', requireAuth, (req, res) => res.json({ orders: db.listOrders(req.session.userId) }));


app.get('/api/rank', requireAuth, (req,res)=>res.json({rank:db.getRank(req.session.userId)}));
app.get('/api/discounts', requireAdmin, (req,res)=>res.json({discounts:db.listDiscounts()}));
app.post('/api/discounts/validate', requireAuth, (req,res)=>{
 const code=String(req.body.code||'').trim().toUpperCase(), subtotal=Number(req.body.subtotal);
 if(!code||!Number.isSafeInteger(subtotal)||subtotal<0)return res.status(400).json({error:'Mã hoặc tổng tiền không hợp lệ.'});
 const d=db.db.prepare('SELECT * FROM discount_codes WHERE code=? COLLATE NOCASE AND active=1').get(code);
 if(!d)return res.status(404).json({error:'Mã giảm giá không hợp lệ.'});
 if(d.valid_until&&new Date(d.valid_until).getTime()<Date.now())return res.status(400).json({error:'Mã giảm giá đã hết hạn.'});
 if(d.max_uses!==null&&d.uses>=d.max_uses)return res.status(400).json({error:'Mã giảm giá đã hết lượt.'});
 if(subtotal<d.min_total)return res.status(400).json({error:`Đơn hàng tối thiểu ${d.min_total}đ.`});
 const saved=Math.min(subtotal,d.kind==='percent'?Math.floor(subtotal*d.value/100):d.value);
 res.json({valid:true,code:d.code,saved,total:subtotal-saved});
});
app.get('/api/support/tickets', requireAuth, (req,res)=>res.json({tickets:db.listTickets(req.session.userId)}));
app.post('/api/support/tickets', requireAuth, (req,res)=>{
 const subject=String(req.body.subject||'').trim(), message=String(req.body.message||'').trim();
 if(subject.length<4||subject.length>120||message.length<3||message.length>3000)return res.status(400).json({error:'Tiêu đề 4–120 ký tự, nội dung 3–3000 ký tự.'});
 try{res.status(201).json({ticket:db.createTicket(req.session.userId,subject,message)});}catch(e){res.status(400).json({error:e.message});}
});
app.post('/api/support/tickets/:id/messages', requireAuth, (req,res)=>{
 const message=String(req.body.message||'').trim();if(message.length<1||message.length>3000)return res.status(400).json({error:'Tin nhắn tối đa 3000 ký tự.'});
 try{const ticket=db.replyTicket(Number(req.params.id),req.session.userId,'user',message,false);if(!ticket)return res.status(404).json({error:'Không tìm thấy phiếu hỗ trợ.'});res.json({ticket});}catch(e){res.status(400).json({error:e.message});}
});
app.get('/api/admin/support/tickets', requireAdmin, (req,res)=>res.json({tickets:db.listTickets(req.session.userId,true)}));
app.post('/api/admin/support/tickets/:id/messages', requireAdmin, (req,res)=>{
 const message=String(req.body.message||'').trim();if(message.length<1||message.length>3000)return res.status(400).json({error:'Tin nhắn tối đa 3000 ký tự.'});
 try{const ticket=db.replyTicket(Number(req.params.id),req.session.userId,'admin',message,true);if(!ticket)return res.status(404).json({error:'Không tìm thấy phiếu hỗ trợ.'});res.json({ticket});}catch(e){res.status(400).json({error:e.message});}
});
app.post('/api/admin/support/tickets/:id/close', requireAdmin, (req,res)=>db.closeTicket(Number(req.params.id))?res.json({success:true}):res.status(404).json({error:'Không tìm thấy phiếu.'}));
app.get('/api/admin/wallet-audit', requireAdmin, (req,res)=>res.json({transactions:db.walletAudit()}));
app.post('/api/admin/discounts', requireAdmin, (req,res)=>{
 try{res.status(201).json({discount:db.createDiscount(req.body)});}catch(e){res.status(400).json({error:e.message.includes('UNIQUE')?'Mã này đã tồn tại.':e.message});}
});
app.patch('/api/admin/discounts/:id', requireAdmin, (req,res)=>db.setDiscountActive(Number(req.params.id),!!req.body.active)?res.json({success:true}):res.status(404).json({error:'Không tìm thấy mã giảm giá.'}));
app.get('/api/admin/summary', requireAdmin, (req, res) => res.json(db.adminSummary()));
app.post('/api/admin/products', requireAdmin, (req, res) => {
  const { name, category, description, price, stock, imageUrl } = req.body;
  if (!String(name || '').trim() || !Number.isSafeInteger(Number(price)) || Number(price) < 0 || !Number.isSafeInteger(Number(stock)) || Number(stock) < 0) {
    return res.status(400).json({ error: 'Tên, giá và kho sản phẩm không hợp lệ.' });
  }
  const product = db.createProduct({ name: String(name).trim().slice(0, 120), category: String(category || 'KHÁC').slice(0, 40), description: String(description || '').slice(0, 500), price: Number(price), stock: Number(stock), imageUrl: String(imageUrl || '').slice(0, 500) });
  res.status(201).json({ product });
});
app.patch('/api/admin/products/:id', requireAdmin, (req, res) => {
  const ok = db.updateProduct(Number(req.params.id), req.body);
  if (!ok) return res.status(404).json({ error: 'Không tìm thấy sản phẩm.' });
  res.json({ product: db.getProduct(Number(req.params.id)) });
});
app.post('/api/admin/products/:id/keys', requireAdmin, (req, res) => {
  const productId = Number(req.params.id);
  const keys = Array.isArray(req.body.keys) ? req.body.keys : [];
  if (!keys.length || keys.length > 500 || keys.some(k => typeof k !== 'string' || !k.trim() || k.length > 500)) {
    return res.status(400).json({ error: 'Cần gửi 1–500 mã hợp lệ.' });
  }
  res.status(201).json({ inserted: db.addKeys(productId, keys) });
});
app.get('/api/admin/deposits', requireAdmin, (req, res) => res.json({ deposits: db.adminDeposits() }));
app.get('/api/admin/orders', requireAdmin, (req, res) => res.json({ orders: db.adminOrders() }));

app.use(express.static(path.join(__dirname, '..', 'public'), { extensions: ['html'] }));
app.get('*', (req, res) => res.sendFile(path.join(__dirname, '..', 'public', 'index.html')));
app.use((err, req, res, next) => {
  console.error(err);
  res.status(500).json({ error: 'Đã xảy ra lỗi máy chủ.' });
});

app.listen(PORT, () => console.log(`KEYVN running at ${BASE_URL}`));
