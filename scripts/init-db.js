const mysql = require('mysql2/promise');
const fs = require('node:fs');
const path = require('node:path');
const { DB_CONFIG } = require('../quiz-api/config');

async function main() {
  const { database, ...config } = DB_CONFIG;
  if (!/^[a-zA-Z0-9_]+$/.test(database)) throw new Error('DB_NAME 只能包含字母、数字和下划线');
  const connection = await mysql.createConnection({ ...config, multipleStatements: true });
  try {
    await connection.query(`CREATE DATABASE IF NOT EXISTS ${mysql.escapeId(database)} CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci`);
    await connection.changeUser({ database });
    const [tables] = await connection.query('SHOW TABLES');
    if (tables.length) throw new Error('目标数据库非空，已停止初始化，现有数据未删除。请使用新的空数据库。');
    const sql = fs.readFileSync(path.join(__dirname, '..', 'database', 'init.sql'), 'utf8');
    await connection.query(sql);
    const [[row]] = await connection.query('SELECT COUNT(*) AS total FROM questions');
    console.log(`初始化完成：${row.total} 道示例题。下一步运行 npm run create-admin。`);
  } finally { await connection.end(); }
}
main().catch(error => { console.error(error.message); process.exitCode = 1; });
