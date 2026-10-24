require('dotenv').config();
const bcrypt = require('bcryptjs');
const readline = require('readline');
const store = require('../src/store');
const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
const ask = q => new Promise(resolve => rl.question(q, resolve));
(async () => {
  try {
    const username = (await ask('Admin username (3-24 letters/numbers/_): ')).trim();
    const email = (await ask('Admin email: ')).trim().toLowerCase();
    const password = await ask('Admin password (minimum 14 characters): ');
    if (!/^[a-zA-Z0-9_]{3,24}$/.test(username)) throw new Error('Username invalid');
    if (!email.includes('@')) throw new Error('Email invalid');
    if (password.length < 14) throw new Error('Password must be at least 14 characters');
    const passwordHash = await bcrypt.hash(password, 12);
    const id = store.db.prepare("INSERT INTO users(username,email,password_hash,role) VALUES(?,?,?,'admin')").run(username,email,passwordHash).lastInsertRowid;
    console.log(`Admin created with user ID ${id}. Keep credentials safe.`);
  } catch (e) { console.error('Could not create admin:', e.message); process.exitCode = 1; }
  finally { rl.close(); store.db.close(); }
})();
