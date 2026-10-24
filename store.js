const path = require('path');
const fs = require('fs');
const Database = require('better-sqlite3');
const DB_FILE = path.resolve(process.env.DB_FILE || './data/keyvn.sqlite');
fs.mkdirSync(path.dirname(DB_FILE), { recursive: true });
const db = new Database(DB_FILE);
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');
db.pragma('busy_timeout = 5000');

db.exec(`
CREATE TABLE IF NOT EXISTS users (
 id INTEGER PRIMARY KEY AUTOINCREMENT,
 username TEXT NOT NULL UNIQUE COLLATE NOCASE,
 email TEXT NOT NULL UNIQUE COLLATE NOCASE,
 password_hash TEXT NOT NULL,
 balance INTEGER NOT NULL DEFAULT 0 CHECK(balance >= 0),
 role TEXT NOT NULL DEFAULT 'user' CHECK(role IN ('user','admin')),
 created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS products (
 id INTEGER PRIMARY KEY AUTOINCREMENT,
 name TEXT NOT NULL,
 category TEXT NOT NULL DEFAULT 'KHÁC',
 description TEXT NOT NULL DEFAULT '',
 price INTEGER NOT NULL CHECK(price >= 0),
 stock INTEGER NOT NULL DEFAULT 0 CHECK(stock >= 0),
 image_url TEXT NOT NULL DEFAULT '',
 active INTEGER NOT NULL DEFAULT 1,
 created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS deposits (
 id INTEGER PRIMARY KEY AUTOINCREMENT,
 user_id INTEGER NOT NULL REFERENCES users(id),
 amount INTEGER NOT NULL CHECK(amount > 0),
 payment_code TEXT NOT NULL UNIQUE,
 status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','paid','expired','cancelled')),
 provider_transaction_id TEXT UNIQUE,
 paid_at TEXT,
 created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS wallet_transactions (
 id INTEGER PRIMARY KEY AUTOINCREMENT,
 user_id INTEGER NOT NULL REFERENCES users(id),
 amount INTEGER NOT NULL,
 type TEXT NOT NULL CHECK(type IN ('deposit','purchase','admin_adjustment')),
 reference_type TEXT NOT NULL,
 reference_id INTEGER NOT NULL,
 description TEXT NOT NULL,
 created_at TEXT NOT NULL DEFAULT (datetime('now')),
 UNIQUE(type, reference_type, reference_id)
);
CREATE TABLE IF NOT EXISTS orders (
 id INTEGER PRIMARY KEY AUTOINCREMENT,
 user_id INTEGER NOT NULL REFERENCES users(id),
 total INTEGER NOT NULL CHECK(total >= 0),
 status TEXT NOT NULL DEFAULT 'paid',
 created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS order_items (
 id INTEGER PRIMARY KEY AUTOINCREMENT,
 order_id INTEGER NOT NULL REFERENCES orders(id),
 product_id INTEGER NOT NULL REFERENCES products(id),
 product_name TEXT NOT NULL,
 quantity INTEGER NOT NULL,
 unit_price INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS product_keys (
 id INTEGER PRIMARY KEY AUTOINCREMENT,
 product_id INTEGER NOT NULL REFERENCES products(id),
 secret_value TEXT NOT NULL,
 status TEXT NOT NULL DEFAULT 'available' CHECK(status IN ('available','delivered')),
 order_id INTEGER REFERENCES orders(id),
 delivered_to_user_id INTEGER REFERENCES users(id),
 created_at TEXT NOT NULL DEFAULT (datetime('now')),
 UNIQUE(product_id, secret_value)
);
CREATE TABLE IF NOT EXISTS delivered_keys (
 id INTEGER PRIMARY KEY AUTOINCREMENT,
 order_id INTEGER NOT NULL REFERENCES orders(id),
 user_id INTEGER NOT NULL REFERENCES users(id),
 product_id INTEGER NOT NULL REFERENCES products(id),
 key_value TEXT NOT NULL,
 created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS provider_events (
 id INTEGER PRIMARY KEY AUTOINCREMENT,
 provider TEXT NOT NULL,
 provider_event_id TEXT NOT NULL,
 received_at TEXT NOT NULL DEFAULT (datetime('now')),
 UNIQUE(provider, provider_event_id)
);

CREATE TABLE IF NOT EXISTS discount_codes (
 id INTEGER PRIMARY KEY AUTOINCREMENT,
 code TEXT NOT NULL UNIQUE COLLATE NOCASE,
 kind TEXT NOT NULL CHECK(kind IN ('percent','fixed')),
 value INTEGER NOT NULL CHECK(value > 0),
 min_total INTEGER NOT NULL DEFAULT 0 CHECK(min_total >= 0),
 max_uses INTEGER,
 uses INTEGER NOT NULL DEFAULT 0,
 valid_until TEXT,
 active INTEGER NOT NULL DEFAULT 1,
 created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS discount_redemptions (
 id INTEGER PRIMARY KEY AUTOINCREMENT,
 discount_id INTEGER NOT NULL REFERENCES discount_codes(id),
 user_id INTEGER NOT NULL REFERENCES users(id),
 order_id INTEGER NOT NULL UNIQUE REFERENCES orders(id),
 amount_saved INTEGER NOT NULL,
 created_at TEXT NOT NULL DEFAULT (datetime('now')),
 UNIQUE(discount_id,user_id,order_id)
);
CREATE TABLE IF NOT EXISTS support_tickets (
 id INTEGER PRIMARY KEY AUTOINCREMENT,
 user_id INTEGER NOT NULL REFERENCES users(id),
 subject TEXT NOT NULL,
 status TEXT NOT NULL DEFAULT 'open' CHECK(status IN ('open','answered','closed')),
 created_at TEXT NOT NULL DEFAULT (datetime('now')),
 updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS support_messages (
 id INTEGER PRIMARY KEY AUTOINCREMENT,
 ticket_id INTEGER NOT NULL REFERENCES support_tickets(id),
 sender_user_id INTEGER REFERENCES users(id),
 sender_role TEXT NOT NULL CHECK(sender_role IN ('user','admin')),
 message TEXT NOT NULL,
 created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_tickets_user ON support_tickets(user_id, updated_at DESC);
CREATE INDEX IF NOT EXISTS idx_ticket_messages ON support_messages(ticket_id, id);
CREATE INDEX IF NOT EXISTS idx_deposits_user ON deposits(user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_wallet_user ON wallet_transactions(user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_orders_user ON orders(user_id, created_at DESC);
`);

// Keep displayed stock tied to actual deliverable key inventory, never placeholder numbers.
db.exec("UPDATE products SET stock=(SELECT COUNT(*) FROM product_keys WHERE product_id=products.id AND status='available')");

const seed = db.prepare('SELECT COUNT(*) AS n FROM products').get().n;
if (!seed) {
 const insert = db.prepare('INSERT INTO products(name,category,description,price,stock,image_url) VALUES(?,?,?,?,?,?)');
 const rows = [
  ['NovaX Proxy – IOS','PROXY IOS','Proxy hỗ trợ – IOS Antiband',5000,0,'https://images.unsplash.com/photo-1550745165-9bc0b252726f?auto=format&fit=crop&w=900&q=80'],
  ['Mizze Proxy','KHÁC','Menu proxy hỗ trợ nhiều phiên bản',15000,0,'https://images.unsplash.com/photo-1511512578047-dfb367046420?auto=format&fit=crop&w=900&q=80'],
  ['NovaX Client','KHÁC','Công cụ dành cho thiết bị tương thích',25000,0,'https://images.unsplash.com/photo-1612287230202-1ff1d85d1bdf?auto=format&fit=crop&w=900&q=80'],
  ['INNOVA CHEAT','MENU IOS','Gói tiện ích kỹ thuật số',30000,0,'https://images.unsplash.com/photo-1542751371-adc38448a05e?auto=format&fit=crop&w=900&q=80']
 ];
 const tx = db.transaction(() => rows.forEach(r => insert.run(...r)));
 tx();
}

function getUserById(id) { return db.prepare('SELECT * FROM users WHERE id=?').get(id); }
function getUserByLogin(login) { return db.prepare('SELECT * FROM users WHERE username=? COLLATE NOCASE OR email=? COLLATE NOCASE').get(login, login); }
function createUser({username,email,passwordHash}) { return db.prepare('INSERT INTO users(username,email,password_hash) VALUES(?,?,?)').run(username,email,passwordHash).lastInsertRowid; }
function listProducts() { return db.prepare('SELECT id,name,category,description,price,stock,image_url AS imageUrl FROM products WHERE active=1 ORDER BY id DESC').all(); }
function getProduct(id) { return db.prepare('SELECT id,name,category,description,price,stock,image_url AS imageUrl,active FROM products WHERE id=?').get(id); }
function createProduct(p) {
 const r=db.prepare('INSERT INTO products(name,category,description,price,stock,image_url) VALUES(@name,@category,@description,@price,@stock,@imageUrl)').run(p);
 return getProduct(r.lastInsertRowid);
}
function updateProduct(id,p) {
 const old=getProduct(id); if(!old)return false;
 const next={name:p.name===undefined?old.name:String(p.name).slice(0,120),category:p.category===undefined?old.category:String(p.category).slice(0,40),description:p.description===undefined?old.description:String(p.description).slice(0,500),price:p.price===undefined?old.price:Number(p.price),stock:p.stock===undefined?old.stock:Number(p.stock),imageUrl:p.imageUrl===undefined?old.imageUrl:String(p.imageUrl).slice(0,500),active:p.active===undefined?old.active:(p.active?1:0)};
 db.prepare('UPDATE products SET name=@name,category=@category,description=@description,price=@price,stock=@stock,image_url=@imageUrl,active=@active WHERE id=@id').run({...next,id});
 return true;
}
function createDeposit(userId,amount) {
 const code='KV'+cryptoRandom(10);
 const r=db.prepare('INSERT INTO deposits(user_id,amount,payment_code) VALUES(?,?,?)').run(userId,amount,code);
 return db.prepare('SELECT * FROM deposits WHERE id=?').get(r.lastInsertRowid);
}
function cryptoRandom(n) { return require('crypto').randomBytes(n).toString('hex').toUpperCase(); }

const applySepayTransfer = db.transaction((event, opts) => {
 const eventId=String(event.id ?? '');
 const amount=Number(event.transferAmount);
 const codeCandidates=[event.code,event.content,event.description].filter(v=>typeof v==='string' && v.length);
 if (!eventId || !Number.isSafeInteger(amount) || amount <= 0) return {ok:false,error:'Missing transaction ID or invalid amount'};
 if (opts.requireIncoming && String(event.transferType || '').toLowerCase() !== 'in') return {ok:true,status:'ignored'};
 if (opts.expectedAccount && String(event.accountNumber || '').replace(/\s/g,'') !== String(opts.expectedAccount).replace(/\s/g,'')) return {ok:true,status:'ignored'};
 const seen=db.prepare('SELECT id FROM provider_events WHERE provider=? AND provider_event_id=?').get('sepay',eventId);
 if (seen) return {ok:true,status:'duplicate'};
 // Only match a server-created payment code; never trust amount alone or user-supplied ID.
 let matched=null;
 for (const text of codeCandidates) {
   const normalized=text.toUpperCase();
   matched=db.prepare("SELECT * FROM deposits WHERE status='pending' AND instr(?, payment_code)>0").get(normalized);
   if(matched)break;
 }
 if (!matched) {
   db.prepare('INSERT INTO provider_events(provider,provider_event_id) VALUES(?,?)').run('sepay',eventId);
   return {ok:true,status:'ignored'};
 }
 if (amount !== matched.amount) {
   db.prepare('INSERT INTO provider_events(provider,provider_event_id) VALUES(?,?)').run('sepay',eventId);
   return {ok:true,status:'ignored'};
 }
 db.prepare('INSERT INTO provider_events(provider,provider_event_id) VALUES(?,?)').run('sepay',eventId);
 const updated=db.prepare("UPDATE deposits SET status='paid', provider_transaction_id=?, paid_at=datetime('now') WHERE id=? AND status='pending'").run(eventId,matched.id);
 if (!updated.changes) return {ok:true,status:'duplicate'};
 db.prepare('UPDATE users SET balance=balance+? WHERE id=?').run(matched.amount,matched.user_id);
 db.prepare("INSERT INTO wallet_transactions(user_id,amount,type,reference_type,reference_id,description) VALUES(?,?,'deposit','deposit',?,?)")
   .run(matched.user_id,matched.amount,matched.id,`Nạp ví thành công (${matched.payment_code})`);
 return {ok:true,status:'credited'};
});

function listWalletTransactions(userId) { return db.prepare('SELECT id,amount,type,reference_type AS referenceType,reference_id AS referenceId,description,created_at AS createdAt FROM wallet_transactions WHERE user_id=? ORDER BY id DESC LIMIT 100').all(userId); }
function listDeposits(userId) { return db.prepare('SELECT id,amount,payment_code AS paymentCode,status,provider_transaction_id AS providerTransactionId,paid_at AS paidAt,created_at AS createdAt FROM deposits WHERE user_id=? ORDER BY id DESC LIMIT 100').all(userId); }
const createOrderFromWallet = db.transaction((userId, items, couponCode = '') => {
 if (!items.length || items.length > 50) throw new Error('Giỏ hàng không hợp lệ.');
 const normalized=new Map();
 for(const item of items) {
   const id=Number(item.id), quantity=Number(item.quantity);
   if(!Number.isSafeInteger(id)||!Number.isSafeInteger(quantity)||quantity<1||quantity>50)throw new Error('Số lượng sản phẩm không hợp lệ.');
   normalized.set(id,(normalized.get(id)||0)+quantity);
 }
 const lines=[]; let total=0;
 for(const [id,quantity] of normalized) {
   const p=db.prepare('SELECT * FROM products WHERE id=? AND active=1').get(id);
   if(!p)throw new Error('Có sản phẩm không còn tồn tại.');
   if(p.stock<quantity)throw new Error(`Sản phẩm "${p.name}" không đủ hàng.`);
   const keys=db.prepare("SELECT id,secret_value FROM product_keys WHERE product_id=? AND status='available' ORDER BY id LIMIT ?").all(id,quantity);
   // Never charge a customer unless the backend can fulfill the digital delivery.
   if(keys.length<quantity)throw new Error(`Kho key giao tự động của "${p.name}" chưa có đủ mã. Vui lòng liên hệ quản trị viên.`);
   lines.push({product:p,quantity,keys});
   total+=p.price*quantity;
   if(!Number.isSafeInteger(total))throw new Error('Tổng đơn hàng vượt giới hạn.');
 }
 const user=db.prepare('SELECT balance FROM users WHERE id=?').get(userId);
 let discount=null, saved=0;
 const code=String(couponCode||'').trim().toUpperCase();
 if(code){
   discount=db.prepare('SELECT * FROM discount_codes WHERE code=? COLLATE NOCASE AND active=1').get(code);
   if(!discount)throw new Error('Mã giảm giá không hợp lệ hoặc đã tắt.');
   if(discount.valid_until && new Date(discount.valid_until).getTime()<Date.now())throw new Error('Mã giảm giá đã hết hạn.');
   if(discount.max_uses!==null && discount.uses>=discount.max_uses)throw new Error('Mã giảm giá đã hết lượt sử dụng.');
   if(total<discount.min_total)throw new Error(`Đơn hàng cần tối thiểu ${discount.min_total}đ để dùng mã này.`);
   saved=discount.kind==='percent'?Math.floor(total*discount.value/100):discount.value;
   saved=Math.min(total,saved);
 }
 const subtotal=total; total-=saved;
 if(!user||user.balance<total)throw new Error('Số dư ví không đủ. Vui lòng nạp tiền.');
 const orderId=db.prepare("INSERT INTO orders(user_id,total,status) VALUES(?,?,'paid')").run(userId,total).lastInsertRowid;
 if(discount){
   db.prepare('INSERT INTO discount_redemptions(discount_id,user_id,order_id,amount_saved) VALUES(?,?,?,?)').run(discount.id,userId,orderId,saved);
   db.prepare('UPDATE discount_codes SET uses=uses+1 WHERE id=?').run(discount.id);
 }
 for(const line of lines) {
   const p=line.product;
   db.prepare('UPDATE products SET stock=stock-? WHERE id=? AND stock>=?').run(line.quantity,p.id,line.quantity);
   db.prepare('INSERT INTO order_items(order_id,product_id,product_name,quantity,unit_price) VALUES(?,?,?,?,?)').run(orderId,p.id,p.name,line.quantity,p.price);
   for(const key of line.keys) {
     db.prepare("UPDATE product_keys SET status='delivered',order_id=?,delivered_to_user_id=? WHERE id=? AND status='available'").run(orderId,userId,key.id);
     db.prepare('INSERT INTO delivered_keys(order_id,user_id,product_id,key_value) VALUES(?,?,?,?)').run(orderId,userId,p.id,key.secret_value);
   }
 }
 db.prepare('UPDATE users SET balance=balance-? WHERE id=?').run(total,userId);
 db.prepare("INSERT INTO wallet_transactions(user_id,amount,type,reference_type,reference_id,description) VALUES(?,?,'purchase','order',?,?)").run(userId,-total,orderId,`Thanh toán đơn hàng #${orderId}`);
 return {id:orderId,total,subtotal,discount:saved,couponCode:discount?discount.code:null,status:'paid',items:lines.map(l=>({name:l.product.name,quantity:l.quantity,unitPrice:l.product.price,deliveredKeys:l.keys.map(k=>k.secret_value)})),createdAt:new Date().toISOString()};
});
function listOrders(userId) {
 const orders=db.prepare('SELECT id,total,status,created_at AS createdAt FROM orders WHERE user_id=? ORDER BY id DESC LIMIT 100').all(userId);
 return orders.map(o=>({...o,items:db.prepare('SELECT product_name AS name,quantity,unit_price AS unitPrice FROM order_items WHERE order_id=?').all(o.id),keys:db.prepare('SELECT product_id AS productId,key_value AS keyValue FROM delivered_keys WHERE order_id=? AND user_id=?').all(o.id,userId)}));
}
function addKeys(productId,keys) {
 if(!getProduct(productId))throw new Error('Không tìm thấy sản phẩm');
 const insert=db.prepare("INSERT INTO product_keys(product_id,secret_value) VALUES(?,?)");
 const tx=db.transaction(()=>{let n=0;for(const k of keys){insert.run(productId,k.trim());n++;}return n;});
 const n=tx();
 db.prepare("UPDATE products SET stock=(SELECT COUNT(*) FROM product_keys WHERE product_id=? AND status='available') WHERE id=?").run(productId,productId);
 return n;
}
function adminSummary() {
 return {
  users:db.prepare('SELECT COUNT(*) AS n FROM users').get().n,
  pendingDeposits:db.prepare("SELECT COUNT(*) AS n FROM deposits WHERE status='pending'").get().n,
  paidDeposits:db.prepare("SELECT COUNT(*) AS n FROM deposits WHERE status='paid'").get().n,
  orderCount:db.prepare('SELECT COUNT(*) AS n FROM orders').get().n,
  products:listProducts()
 };
}
function adminDeposits() { return db.prepare('SELECT d.id,d.amount,d.payment_code AS paymentCode,d.status,d.created_at AS createdAt,u.username,u.email FROM deposits d JOIN users u ON u.id=d.user_id ORDER BY d.id DESC LIMIT 200').all(); }
function adminOrders() { return db.prepare('SELECT o.id,o.total,o.status,o.created_at AS createdAt,u.username FROM orders o JOIN users u ON u.id=o.user_id ORDER BY o.id DESC LIMIT 200').all(); }


function getRank(userId) {
 const spent=db.prepare("SELECT COALESCE(SUM(total),0) AS total FROM orders WHERE user_id=? AND status='paid'").get(userId).total;
 if(spent>=1000000)return {name:'Kim cương',code:'diamond',spent,nextAt:null};
 if(spent>=500000)return {name:'Vàng',code:'gold',spent,nextAt:1000000};
 if(spent>=100000)return {name:'Bạc',code:'silver',spent,nextAt:500000};
 return {name:'Đồng',code:'bronze',spent,nextAt:100000};
}
function createDiscount(d){
 const code=String(d.code||'').trim().toUpperCase();
 if(!/^[A-Z0-9_-]{3,32}$/.test(code))throw new Error('Mã chỉ gồm chữ in hoa, số, _ hoặc - (3–32 ký tự).');
 const kind=d.kind==='percent'?'percent':'fixed', value=Number(d.value), minTotal=Number(d.minTotal||0), maxUses=d.maxUses===''||d.maxUses==null?null:Number(d.maxUses);
 if(!Number.isSafeInteger(value)||value<1||(kind==='percent'&&value>90))throw new Error('Giá trị giảm không hợp lệ (phần trăm tối đa 90%).');
 if(!Number.isSafeInteger(minTotal)||minTotal<0|| (maxUses!==null&&(!Number.isSafeInteger(maxUses)||maxUses<1)))throw new Error('Điều kiện mã giảm giá không hợp lệ.');
 const r=db.prepare('INSERT INTO discount_codes(code,kind,value,min_total,max_uses,valid_until) VALUES(?,?,?,?,?,?)').run(code,kind,value,minTotal,maxUses,d.validUntil||null);
 return db.prepare('SELECT * FROM discount_codes WHERE id=?').get(r.lastInsertRowid);
}
function listDiscounts(){return db.prepare('SELECT id,code,kind,value,min_total AS minTotal,max_uses AS maxUses,uses,valid_until AS validUntil,active,created_at AS createdAt FROM discount_codes ORDER BY id DESC').all();}
function setDiscountActive(id,active){return db.prepare('UPDATE discount_codes SET active=? WHERE id=?').run(active?1:0,id).changes>0;}
function createTicket(userId,subject,message){
 const tx=db.transaction(()=>{const id=db.prepare("INSERT INTO support_tickets(user_id,subject) VALUES(?,?)").run(userId,subject).lastInsertRowid;db.prepare("INSERT INTO support_messages(ticket_id,sender_user_id,sender_role,message) VALUES(?,?,'user',?)").run(id,userId,message);return getTicket(id,userId,true);});return tx();
}
function getTicket(id,userId,isAdmin=false){const t=db.prepare('SELECT t.id,t.user_id AS userId,t.subject,t.status,t.created_at AS createdAt,t.updated_at AS updatedAt,u.username FROM support_tickets t JOIN users u ON u.id=t.user_id WHERE t.id=?').get(id);if(!t||(!isAdmin&&t.userId!==userId))return null;t.messages=db.prepare('SELECT m.id,m.sender_role AS senderRole,m.message,m.created_at AS createdAt,u.username FROM support_messages m LEFT JOIN users u ON u.id=m.sender_user_id WHERE m.ticket_id=? ORDER BY m.id').all(id);return t;}
function listTickets(userId,isAdmin=false){const rows=isAdmin?db.prepare('SELECT id,user_id AS userId,subject,status,created_at AS createdAt,updated_at AS updatedAt FROM support_tickets ORDER BY updated_at DESC LIMIT 200').all():db.prepare('SELECT id,user_id AS userId,subject,status,created_at AS createdAt,updated_at AS updatedAt FROM support_tickets WHERE user_id=? ORDER BY updated_at DESC LIMIT 100').all(userId);return rows.map(t=>({...t,messages:db.prepare('SELECT m.id,m.sender_role AS senderRole,m.message,m.created_at AS createdAt,u.username FROM support_messages m LEFT JOIN users u ON u.id=m.sender_user_id WHERE m.ticket_id=? ORDER BY m.id').all(t.id)}));}
function replyTicket(ticketId,userId,role,message,isAdmin=false){
 const t=db.prepare('SELECT * FROM support_tickets WHERE id=?').get(ticketId);if(!t||(!isAdmin&&t.user_id!==userId))return null;if(t.status==='closed'&&!isAdmin)throw new Error('Phiếu hỗ trợ đã đóng.');
 const tx=db.transaction(()=>{db.prepare('INSERT INTO support_messages(ticket_id,sender_user_id,sender_role,message) VALUES(?,?,?,?)').run(ticketId,userId,role,message);db.prepare("UPDATE support_tickets SET status=?,updated_at=datetime('now') WHERE id=?").run(isAdmin?'answered':'open',ticketId);return getTicket(ticketId,userId,isAdmin);});return tx();
}
function closeTicket(ticketId){return db.prepare("UPDATE support_tickets SET status='closed',updated_at=datetime('now') WHERE id=?").run(ticketId).changes>0;}
function walletAudit(){return db.prepare('SELECT w.id,w.user_id AS userId,u.username,w.amount,w.type,w.reference_type AS referenceType,w.reference_id AS referenceId,w.description,w.created_at AS createdAt FROM wallet_transactions w JOIN users u ON u.id=w.user_id ORDER BY w.id DESC LIMIT 300').all();}

module.exports={db,getRank,createDiscount,listDiscounts,setDiscountActive,createTicket,getTicket,listTickets,replyTicket,closeTicket,walletAudit,getUserById,getUserByLogin,createUser,listProducts,getProduct,createProduct,updateProduct,createDeposit,applySepayTransfer,listWalletTransactions,listDeposits,createOrderFromWallet,listOrders,addKeys,adminSummary,adminDeposits,adminOrders};
