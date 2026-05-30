const express = require('express');
const path = require('path');
const fs = require('fs');

const app = express();
app.use(express.json());
// 静态文件 + 缓存（图片缓存24小时，重复访问秒开）
app.use(express.static(path.join(__dirname, 'public'), {
  setHeaders: (res, filePath) => {
    if (filePath.match(/\.(webp|png|jpg|jpeg|svg)$/)) {
      res.setHeader('Cache-Control', 'public, max-age=86400, immutable');
    }
  }
}));

// ============================================================
//  根路由 —— 返回报名页面
// ============================================================
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// ============================================================
//  数据库初始化（自动选择 JSON 文件 或 PostgreSQL）
// ============================================================
let db;

// 调试：列出所有数据库相关环境变量
const pgUrl = process.env.DATABASE_URL || process.env.DATABASE_PUBLIC_URL || process.env.POSTGRES_URL || '';
const isPostgres = !!pgUrl;
console.log('DATABASE_URL:', process.env.DATABASE_URL ? '有' : '无');
console.log('DATABASE_PUBLIC_URL:', process.env.DATABASE_PUBLIC_URL ? '有' : '无');
console.log('POSTGRES_URL:', process.env.POSTGRES_URL ? '有' : '无');
console.log('最终使用 PostgreSQL:', isPostgres);

if (isPostgres) {
  // ---- Railway / PostgreSQL ----
  const { Pool } = require('pg');
  const pool = new Pool({
    connectionString: pgUrl,
    ssl: { rejectUnauthorized: false },
  });

  db = {
    async init() {
      // 创建表
      await pool.query(`
        CREATE TABLE IF NOT EXISTS counter (
          id    INTEGER PRIMARY KEY DEFAULT 1,
          value INTEGER NOT NULL DEFAULT 0
        );
      `);
      // 兼容旧表：添加 generation 列
      try {
        await pool.query(`ALTER TABLE counter ADD COLUMN generation INTEGER NOT NULL DEFAULT 1`);
      } catch (e) {
        // 列已存在则忽略
      }
      // 确保初始行存在
      await pool.query(`
        INSERT INTO counter (id, value, generation) VALUES (1, 0, 1)
        ON CONFLICT (id) DO NOTHING;
      `);
      console.log('数据库初始化完成: PostgreSQL');
    },
    async increment() {
      const res = await pool.query(
        `UPDATE counter SET value = value + 1 WHERE id = 1 RETURNING value`
      );
      return res.rows[0].value;
    },
    async getCount() {
      const res = await pool.query(`SELECT value FROM counter WHERE id = 1`);
      return res.rows[0]?.value ?? 0;
    },
    async getInfo() {
      const res = await pool.query(`SELECT value, generation FROM counter WHERE id = 1`);
      return { total: res.rows[0]?.value ?? 0, generation: res.rows[0]?.generation ?? 1 };
    },
    async reset(val) {
      // 重置计数 + 递增版本号（让所有人手机上的旧数据失效）
      await pool.query('UPDATE counter SET value = $1, generation = generation + 1 WHERE id = 1', [val]);
    },
  };
} else {
  // ---- 本地 / JSON 文件 ----
  const COUNTER_FILE = path.join(__dirname, 'counter.json');

  function readAll() {
    try {
      return JSON.parse(fs.readFileSync(COUNTER_FILE, 'utf-8'));
    } catch {
      return { value: 0, generation: 1 };
    }
  }

  function readCounter() { return readAll().value; }

  function writeCounter(value) {
    const data = readAll();
    data.value = value;
    fs.writeFileSync(COUNTER_FILE, JSON.stringify(data));
  }

  function writeAll(data) {
    fs.writeFileSync(COUNTER_FILE, JSON.stringify(data));
  }

  // 确保文件存在
  if (!fs.existsSync(COUNTER_FILE)) {
    writeCounter(0);
  }

  db = {
    async init() { console.log('数据库初始化完成: JSON 文件'); },
    async increment() {
      const next = readCounter() + 1;
      writeCounter(next);
      return next;
    },
    async getCount() {
      return readCounter();
    },
    async getInfo() {
      const data = readAll();
      return { total: data.value, generation: data.generation || 1 };
    },
    async reset(val) {
      const data = readAll();
      data.value = val;
      data.generation = (data.generation || 1) + 1;
      writeAll(data);
    },
  };
}

// ============================================================
//  API 接口
// ============================================================
app.get('/api/count', async (req, res) => {
  try {
    const total = await db.getCount();
    res.json({ total });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// 获取计数 + 版本号（客户端用来判断是否被重置过）
app.get('/api/info', async (req, res) => {
  try {
    const info = await db.getInfo();
    res.json(info);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post('/api/register', async (req, res) => {
  try {
    const number = await db.increment();
    const info = await db.getInfo();
    res.json({ number, generation: info.generation });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// 重置计数器：浏览器打开 /api/reset?key=cufe2026 即可归零
app.get('/api/reset', async (req, res) => {
  if (req.query.key !== 'cufe2026') return res.status(403).json({ error: '密码错误' });
  const val = parseInt(req.query.value) || 0;
  await db.reset(val);
  res.json({ ok: true, message: `计数器已重置为 ${val}` });
});

app.get('/health', (req, res) => {
  // 列出所有环境变量名（只显示以 DATABASE 或 POSTGRES 开头的）
  const keys = Object.keys(process.env).filter(k =>
    k.includes('DATABASE') || k.includes('POSTGRES') || k.includes('PG')
  );
  const vars = {};
  keys.forEach(k => { vars[k] = process.env[k] ? process.env[k].substring(0, 20) + '...' : '空'; });
  res.json({ ok: true, db: isPostgres ? 'PostgreSQL' : 'JSON', envKeys: keys, vars });
});

// ============================================================
//  启动
// ============================================================
const PORT = process.env.PORT || 3000;

(async () => {
  try {
    console.log('正在初始化数据库...');
    await db.init();
    console.log('数据库初始化完毕');
  } catch (e) {
    console.error('数据库初始化失败 (将以只读模式运行):', e.message);
  }

  app.listen(PORT, '0.0.0.0', () => {
    console.log(`✅ 服务已启动: http://0.0.0.0:${PORT}`);
    console.log(`✅ 数据库类型: ${isPostgres ? 'PostgreSQL' : 'JSON 文件'}`);
  });
})();
