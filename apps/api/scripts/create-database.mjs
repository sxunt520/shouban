import mysql from 'mysql2/promise';

const host = process.env.DB_HOST ?? '127.0.0.1';
const port = Number(process.env.DB_PORT ?? 3306);
const user = process.env.DB_USERNAME ?? 'root';
const password = process.env.DB_PASSWORD ?? '';
const database = process.env.DB_DATABASE ?? 'figure_companion';

if (!/^[a-zA-Z0-9_]+$/.test(database)) {
  throw new Error('DB_DATABASE 只能包含字母、数字和下划线');
}

const connection = await mysql.createConnection({ host, port, user, password });
await connection.query(
  `CREATE DATABASE IF NOT EXISTS \`${database}\` CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci`,
);
await connection.end();
console.log(`MySQL database ready: ${database}`);
