const crypto = require('node:crypto');
const mysql = require('mysql2/promise');
const { DB_CONFIG } = require('../quiz-api/config');
const { hashPassword } = require('../quiz-api/security');

async function main() {
  const username = process.env.ADMIN_USERNAME || 'admin';
  const suppliedPassword = process.env.ADMIN_PASSWORD;
  const password = suppliedPassword || crypto.randomBytes(18).toString('base64url');
  if (password.length < 12) throw new Error('ADMIN_PASSWORD 至少需要 12 个字符');
  const connection = await mysql.createConnection(DB_CONFIG);
  try {
    const [existing] = await connection.query('SELECT id FROM users WHERE username = ?', [username]);
    if (existing.length) throw new Error('该账号已存在，未覆盖账号或密码');
    await connection.query('INSERT INTO users (username, password, name, role) VALUES (?, ?, ?, ?)',
      [username, hashPassword(password), '平台管理员', 'admin']);
    console.log(`管理员已创建，用户名：${username}`);
    if (!suppliedPassword) console.log(`本次随机密码（请自行保存，不要提交到仓库）：${password}`);
    else console.log('密码使用本机 ADMIN_PASSWORD，未输出密码。');
  } finally { await connection.end(); }
}
main().catch(error => { console.error(error.message); process.exitCode = 1; });
