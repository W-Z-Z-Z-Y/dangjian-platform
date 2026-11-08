/**
 * 人工智能协会党建平台 - 增强版API服务
 * 包含用户认证、题库管理和答题记录功能
 */

const express = require('express');
const mysql = require('mysql2/promise');
const cors = require('cors');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { DB_CONFIG, PORT, HOST } = require('./config');
const { hashPassword, verifyPassword, generateToken, verifyToken } = require('./security');

const app = express();


function toSummarySlide(item) {
  return {
    id: item.id,
    tag: item.tag,
    title: item.title,
    desc: item.desc,
    link: item.link,
    linkText: item.linkText,
    image: item.image,
    bgImage: item.bgImage,
    bg: item.bg,
    icon: item.icon
  };
}

function toSummaryNews(item) {
  return {
    id: item.id,
    icon: item.icon,
    title: item.title,
    tag: item.tag,
    tagColor: item.tagColor,
    date: item.date,
    link: item.link,
    image: item.image,
    bg: item.bg
  };
}

function toSummaryActivity(item) {
  return {
    id: item.id,
    icon: item.icon,
    title: item.title,
    tag: item.tag,
    tagColor: item.tagColor,
    status: item.status,
    statusColor: item.statusColor,
    date: item.date,
    location: item.location,
    enrolled: item.enrolled,
    capacity: item.capacity,
    btnColor: item.btnColor,
    btnText: item.btnText,
    bg: item.bg
  };
}

// 中间件
app.use(cors());
app.use(express.json({ limit: '20mb' }));
app.use(express.urlencoded({ extended: true, limit: '20mb' }));

let pool;
const WRONG_NOTEBOOK_STATE_FILE = path.join(__dirname, 'wrong-notebook-state.json');
let wrongNotebookState = { users: {} };

// 单账号单设备在线：只允许每个用户保留最近一次登录会话
const activeUserSessions = new Map();

// 首页/统计接口：实时计数缓存，避免数据库抖动拖慢首屏
const REALTIME_STATS_CACHE_TTL_MS = 15 * 1000;
let realtimeStatsCache = null;
let realtimeStatsCacheAt = 0;

// 初始化数据库连接池
async function initDB() {
  try {
    pool = mysql.createPool(DB_CONFIG);
    // 测试连接
    const connection = await pool.getConnection();
    console.log('✅ MySQL数据库连接成功');
    connection.release();
    return true;
  } catch (error) {
    console.error('❌ MySQL数据库连接失败:', error.message);
    return false;
  }
}

// ============================================================
// 工具函数
// ============================================================

function loadWrongNotebookState() {
  try {
    if (!fs.existsSync(WRONG_NOTEBOOK_STATE_FILE)) {
      wrongNotebookState = { users: {} };
      return;
    }

    const raw = fs.readFileSync(WRONG_NOTEBOOK_STATE_FILE, 'utf8');
    const parsed = JSON.parse(raw);
    wrongNotebookState = parsed && typeof parsed === 'object' ? parsed : { users: {} };
    if (!wrongNotebookState.users || typeof wrongNotebookState.users !== 'object') {
      wrongNotebookState.users = {};
    }
  } catch (error) {
    console.error('⚠️ 错题本状态加载失败:', error.message);
    wrongNotebookState = { users: {} };
  }
}

function saveWrongNotebookState() {
  try {
    fs.writeFileSync(WRONG_NOTEBOOK_STATE_FILE, JSON.stringify(wrongNotebookState, null, 2), 'utf8');
  } catch (error) {
    console.error('⚠️ 错题本状态保存失败:', error.message);
  }
}

function getUserWrongNotebookRemovedMap(userId) {
  const key = String(userId);
  if (!wrongNotebookState.users[key] || typeof wrongNotebookState.users[key] !== 'object') {
    wrongNotebookState.users[key] = {};
  }
  return wrongNotebookState.users[key];
}

async function buildUserWrongNotebookData(userId, limit = 50) {
  const [records] = await pool.query(
    `SELECT id, quiz_data, created_at
     FROM quiz_records
     WHERE user_id = ?
       AND quiz_data IS NOT NULL
     ORDER BY created_at DESC`,
    [userId]
  );

  const removedMap = getUserWrongNotebookRemovedMap(userId);
  const wrongQuestionMap = new Map();

  records.forEach((record) => {
    if (!record.quiz_data) return;

    let quizItems = [];
    if (Array.isArray(record.quiz_data)) {
      quizItems = record.quiz_data;
    } else if (typeof record.quiz_data === 'string') {
      try {
        quizItems = JSON.parse(record.quiz_data);
      } catch (error) {
        return;
      }
    } else {
      return;
    }

    if (!Array.isArray(quizItems)) return;

    quizItems.forEach((item) => {
      if (!item || item.is_correct !== false) return;

      const key = String(item.question_id || item.question || '').trim();
      if (!key) return;

      const removedAt = removedMap[key] ? new Date(removedMap[key]).getTime() : 0;
      const wrongAt = new Date(record.created_at).getTime();
      if (removedAt && wrongAt <= removedAt) {
        return;
      }

      const existing = wrongQuestionMap.get(key);
      const normalized = {
        question_key: key,
        question_id: item.question_id || null,
        question: item.question || '未命名题目',
        type: item.type || 'single',
        options: Array.isArray(item.options) ? item.options : [],
        correct_answer: item.correct_answer,
        correct_answer_text: item.correct_answer_text || '',
        user_answer: item.user_answer,
        user_answer_text: item.user_answer_text || '未作答',
        wrong_count: 1,
        last_wrong_at: record.created_at
      };

      if (!existing) {
        wrongQuestionMap.set(key, normalized);
        return;
      }

      existing.wrong_count += 1;
      if (wrongAt >= new Date(existing.last_wrong_at).getTime()) {
        existing.type = normalized.type;
        existing.options = normalized.options;
        existing.correct_answer = normalized.correct_answer;
        existing.correct_answer_text = normalized.correct_answer_text;
        existing.user_answer = normalized.user_answer;
        existing.user_answer_text = normalized.user_answer_text;
        existing.last_wrong_at = normalized.last_wrong_at;
      }
    });
  });

  const questions = Array.from(wrongQuestionMap.values())
    .sort((a, b) => new Date(b.last_wrong_at).getTime() - new Date(a.last_wrong_at).getTime())
    .slice(0, Math.max(parseInt(limit, 10) || 50, 1));

  const totalWrongAttempts = questions.reduce((sum, item) => sum + Number(item.wrong_count || 0), 0);

  return {
    questions,
    stats: {
      total_wrong_questions: questions.length,
      total_wrong_attempts: totalWrongAttempts
    }
  };
}

// 认证中间件
async function authenticate(req, res, next) {
  const token = req.headers['authorization']?.replace('Bearer ', '');

  if (!token) {
    return res.status(401).json({
      success: false,
      message: '未提供认证令牌'
    });
  }

  const payload = verifyToken(token);
  if (!payload) {
    return res.status(401).json({
      success: false,
      message: '认证令牌无效或已过期'
    });
  }

  // 验证用户是否仍然存在
  try {
    const [users] = await pool.query(
      'SELECT id, username, role, name, email, phone, avatar FROM users WHERE id = ? AND is_active = TRUE',
      [payload.userId]
    );

    if (users.length === 0) {
      return res.status(401).json({
        success: false,
        message: '用户不存在或已被禁用'
      });
    }

    const activeSessionId = activeUserSessions.get(payload.userId);
    if (!activeSessionId || payload.sessionId !== activeSessionId) {
      return res.status(401).json({
        success: false,
        message: '账号已在其他设备登录，请重新登录'
      });
    }

    req.user = users[0];
    next();
  } catch (error) {
    console.error('认证查询失败:', error);
    return res.status(500).json({
      success: false,
      message: '认证失败',
      error: error.message
    });
  }
}

// 管理员权限中间件
function requireAdmin(req, res, next) {
  if (req.user.role !== 'admin') {
    return res.status(403).json({
      success: false,
      message: '需要管理员权限'
    });
  }
  next();
}

async function queryCountFast(sql, timeoutMs = 900) {
  if (!pool) throw new Error('数据库连接池不可用');

  return Promise.race([
    pool.query({ sql, timeout: timeoutMs }),
    new Promise((_, reject) => {
      setTimeout(() => reject(new Error('DB_QUERY_TIMEOUT')), timeoutMs + 120);
    })
  ]);
}

async function getRealtimeCountsFast() {
  const now = Date.now();
  if (realtimeStatsCache && (now - realtimeStatsCacheAt) < REALTIME_STATS_CACHE_TTL_MS) {
    return realtimeStatsCache;
  }

  try {
    const [[userCount], [userTotalCount], [recordCount]] = await Promise.all([
      queryCountFast('SELECT COUNT(*) as cnt FROM users WHERE is_active = TRUE', 900),
      queryCountFast('SELECT COUNT(*) as cnt FROM users', 900),
      queryCountFast('SELECT COUNT(*) as cnt FROM quiz_records', 900)
    ]);

    const fresh = {
      activeUsers: Number(userCount?.[0]?.cnt || 0),
      totalUsers: Number(userTotalCount?.[0]?.cnt || 0),
      totalQuizRecords: Number(recordCount?.[0]?.cnt || 0)
    };
    realtimeStatsCache = fresh;
    realtimeStatsCacheAt = now;
    return fresh;
  } catch (error) {
    // 回退到最近缓存，确保接口快速返回
    if (realtimeStatsCache) return realtimeStatsCache;
    return null;
  }
}

function buildSiteStatsPayload(realtimeCounts) {
  const fallbackMembers = Number(contentStore.siteStats.partyMembers || 0);
  const activeUsers = realtimeCounts ? Number(realtimeCounts.activeUsers || 0) : fallbackMembers;
  const totalUsers = realtimeCounts
    ? Number(realtimeCounts.totalUsers || realtimeCounts.activeUsers || fallbackMembers)
    : fallbackMembers;
  const totalQuizRecords = realtimeCounts ? Number(realtimeCounts.totalQuizRecords || 0) : 0;
  const pendingMessages = (contentStore.messages || []).filter(item => item.status === '待审核').length;

  return {
    partyBranches: contentStore.siteStats.partyBranches,
    partyMembers: activeUsers || fallbackMembers,
    totalUsers: totalUsers || activeUsers || fallbackMembers,
    totalActivities: contentStore.activities.length,
    participationRate: contentStore.siteStats.participationRate,
    totalQuizRecords,
    pendingMessages,
    updatedAt: new Date().toISOString()
  };
}

// ============================================================
// 用户认证API
// ============================================================

// 用户登录
app.post('/api/auth/login', async (req, res) => {
  try {
    const { username, password } = req.body;

    if (!username || !password) {
      return res.status(400).json({
        success: false,
        message: '请输入用户名和密码'
      });
    }

    const [users] = await pool.query(
      `SELECT id, username, password, name, role, email, phone, avatar
       FROM users WHERE username = ? AND is_active = TRUE`,
      [username]
    );

    if (users.length === 0 || !verifyPassword(password, users[0].password)) {
      return res.status(401).json({
        success: false,
        message: '用户名或密码错误'
      });
    }

    const user = users[0];
    const sessionId = crypto.randomBytes(16).toString('hex');
    activeUserSessions.set(user.id, sessionId);
    const token = generateToken(user, sessionId);

    // 更新最后登录时间
    await pool.query(
      'UPDATE users SET last_login = NOW() WHERE id = ?',
      [user.id]
    );

    res.json({
      success: true,
      message: '登录成功',
      data: {
        user: {
          id: user.id,
          username: user.username,
          name: user.name,
          role: user.role,
          email: user.email,
          phone: user.phone,
          avatar: user.avatar
        },
        token: token
      }
    });

  } catch (error) {
    console.error('登录失败:', error);
    res.status(500).json({
      success: false,
      message: '登录失败',
      error: error.message
    });
  }
});

// 用户注册
app.post('/api/auth/register', async (req, res) => {
  try {
    const { username, password, name, email, phone } = req.body;

    if (!username || !password || !name) {
      return res.status(400).json({
        success: false,
        message: '用户名、密码和姓名是必填项'
      });
    }

    // 检查用户名是否已存在
    const [existingUsers] = await pool.query(
      'SELECT id FROM users WHERE username = ?',
      [username]
    );

    if (existingUsers.length > 0) {
      return res.status(400).json({
        success: false,
        message: '用户名已存在'
      });
    }

    const hashedPassword = hashPassword(password);

    const [result] = await pool.query(
      `INSERT INTO users (username, password, name, email, phone, role)
       VALUES (?, ?, ?, ?, ?, 'user')`,
      [username, hashedPassword, name, email || null, phone || null]
    );

    // 获取新创建的用户
    const [users] = await pool.query(
      `SELECT id, username, name, role, email, phone, avatar
       FROM users WHERE id = ?`,
      [result.insertId]
    );

    const user = users[0];
    const sessionId = crypto.randomBytes(16).toString('hex');
    activeUserSessions.set(user.id, sessionId);
    const token = generateToken(user, sessionId);

    res.status(201).json({
      success: true,
      message: '注册成功',
      data: {
        user: {
          id: user.id,
          username: user.username,
          name: user.name,
          role: user.role,
          email: user.email,
          phone: user.phone
        },
        token: token
      }
    });

  } catch (error) {
    console.error('注册失败:', error);
    res.status(500).json({
      success: false,
      message: '注册失败',
      error: error.message
    });
  }
});

// 获取当前用户信息
app.get('/api/auth/me', authenticate, async (req, res) => {
  try {
    res.json({
      success: true,
      data: {
        user: req.user
      }
    });
  } catch (error) {
    console.error('获取用户信息失败:', error);
    res.status(500).json({
      success: false,
      message: '获取用户信息失败',
      error: error.message
    });
  }
});

// 更新当前用户资料
app.put('/api/auth/profile', authenticate, async (req, res) => {
  try {
    const userId = req.user.id;
    const name = typeof req.body.name === 'string' ? req.body.name.trim() : null;
    const email = typeof req.body.email === 'string' ? req.body.email.trim() : null;
    const phone = typeof req.body.phone === 'string' ? req.body.phone.trim() : null;
    const avatar = typeof req.body.avatar === 'string' ? req.body.avatar.trim() : null;

    if (name !== null && !name) {
      return res.status(400).json({ success: false, message: '姓名不能为空' });
    }
    if (name && name.length > 30) {
      return res.status(400).json({ success: false, message: '姓名长度不能超过30个字符' });
    }
    if (email && !/^\S+@\S+\.\S+$/.test(email)) {
      return res.status(400).json({ success: false, message: '邮箱格式不正确' });
    }
    if (phone && !/^[0-9+\-\s]{6,20}$/.test(phone)) {
      return res.status(400).json({ success: false, message: '手机号格式不正确' });
    }
    if (avatar && avatar.length > 255) {
      return res.status(400).json({ success: false, message: '头像地址长度过长' });
    }

    await pool.query(
      `UPDATE users SET
         name = COALESCE(?, name),
         email = COALESCE(?, email),
         phone = COALESCE(?, phone),
         avatar = COALESCE(?, avatar)
       WHERE id = ?`,
      [name, email, phone, avatar, userId]
    );

    const [rows] = await pool.query(
      'SELECT id, username, role, name, email, phone, avatar FROM users WHERE id = ?',
      [userId]
    );

    if (!rows.length) {
      return res.status(404).json({ success: false, message: '用户不存在' });
    }

    res.json({
      success: true,
      message: '资料更新成功',
      data: {
        user: rows[0]
      }
    });
  } catch (error) {
    console.error('更新个人资料失败:', error);
    res.status(500).json({ success: false, message: '更新个人资料失败', error: error.message });
  }
});

// ============================================================
// 用户管理API (需要管理员权限)
// ============================================================

// 获取所有用户
app.get('/api/users', authenticate, requireAdmin, async (req, res) => {
  try {
    const [users] = await pool.query(
      `SELECT id, username, name, role, email, phone, avatar,
              last_login, created_at, updated_at, is_active
       FROM users
       ORDER BY created_at DESC`
    );

    res.json({
      success: true,
      data: users,
      total: users.length
    });
  } catch (error) {
    console.error('获取用户列表失败:', error);
    res.status(500).json({
      success: false,
      message: '获取用户列表失败',
      error: error.message
    });
  }
});

// 更新用户信息
app.put('/api/users/:id', authenticate, requireAdmin, async (req, res) => {
  try {
    const { id } = req.params;
    const { name, email, phone, role, is_active } = req.body;

    const [result] = await pool.query(
      `UPDATE users SET
        name = COALESCE(?, name),
        email = COALESCE(?, email),
        phone = COALESCE(?, phone),
        role = COALESCE(?, role),
        is_active = COALESCE(?, is_active)
       WHERE id = ?`,
      [name, email, phone, role, is_active, id]
    );

    if (result.affectedRows === 0) {
      return res.status(404).json({
        success: false,
        message: '用户不存在'
      });
    }

    res.json({
      success: true,
      message: '用户信息更新成功'
    });
  } catch (error) {
    console.error('更新用户信息失败:', error);
    res.status(500).json({
      success: false,
      message: '更新用户信息失败',
      error: error.message
    });
  }
});

// 新增用户（管理员）
app.post('/api/users', authenticate, requireAdmin, async (req, res) => {
  try {
    const { username, password, name, email, phone, role } = req.body;
    if (!username || !password || !name) {
      return res.status(400).json({ success: false, message: '用户名、密码和姓名是必填项' });
    }
    const [existing] = await pool.query('SELECT id FROM users WHERE username = ?', [username]);
    if (existing.length > 0) {
      return res.status(400).json({ success: false, message: '用户名已存在' });
    }
    const hashedPassword = hashPassword(password);
    const [result] = await pool.query(
      `INSERT INTO users (username, password, name, email, phone, role, is_active) VALUES (?, ?, ?, ?, ?, ?, TRUE)`,
      [username, hashedPassword, name, email || null, phone || null, role || 'user']
    );
    res.status(201).json({ success: true, message: '用户创建成功', data: { id: result.insertId } });
  } catch (error) {
    console.error('创建用户失败:', error);
    res.status(500).json({ success: false, message: '创建用户失败', error: error.message });
  }
});

// 删除用户（管理员，不能删除自己）
app.delete('/api/users/:id', authenticate, requireAdmin, async (req, res) => {
  try {
    const targetId = parseInt(req.params.id);
    if (targetId === req.user.id) {
      return res.status(400).json({ success: false, message: '不能删除自己的账号' });
    }
    const [result] = await pool.query('DELETE FROM users WHERE id = ?', [targetId]);
    if (result.affectedRows === 0) {
      return res.status(404).json({ success: false, message: '用户不存在' });
    }
    res.json({ success: true, message: '用户已删除' });
  } catch (error) {
    console.error('删除用户失败:', error);
    res.status(500).json({ success: false, message: '删除用户失败', error: error.message });
  }
});

// 重置用户密码（管理员）
app.post('/api/users/:id/reset-password', authenticate, requireAdmin, async (req, res) => {
  try {
    const { newPassword } = req.body;
    if (!newPassword || newPassword.length < 4) {
      return res.status(400).json({ success: false, message: '新密码不能少于4位' });
    }
    const hashedPassword = hashPassword(newPassword);
    const [result] = await pool.query('UPDATE users SET password = ? WHERE id = ?', [hashedPassword, req.params.id]);
    if (result.affectedRows === 0) {
      return res.status(404).json({ success: false, message: '用户不存在' });
    }
    res.json({ success: true, message: '密码已重置' });
  } catch (error) {
    console.error('重置密码失败:', error);
    res.status(500).json({ success: false, message: '重置密码失败', error: error.message });
  }
});

// ============================================================
// 题目管理API (原有功能，添加认证)
// ============================================================

// 获取所有题目
app.get('/api/questions', async (req, res) => {
  try {
    const [rows] = await pool.query('SELECT * FROM questions ORDER BY id');
    res.json({
      success: true,
      data: rows,
      total: rows.length
    });
  } catch (error) {
    console.error('获取题目失败:', error);
    res.status(500).json({
      success: false,
      message: '获取题目失败',
      error: error.message
    });
  }
});

// 按题型获取题目
app.get('/api/questions/type/:type', async (req, res) => {
  try {
    const { type } = req.params;
    const [rows] = await pool.query(
      'SELECT * FROM questions WHERE type = ? ORDER BY id',
      [type]
    );
    res.json({
      success: true,
      data: rows,
      total: rows.length,
      type: type
    });
  } catch (error) {
    console.error('获取题目失败:', error);
    res.status(500).json({
      success: false,
      message: '获取题目失败',
      error: error.message
    });
  }
});

// 获取单题
app.get('/api/questions/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const [rows] = await pool.query(
      'SELECT * FROM questions WHERE id = ?',
      [id]
    );
    if (rows.length === 0) {
      return res.status(404).json({
        success: false,
        message: '题目不存在'
      });
    }
    res.json({
      success: true,
      data: rows[0]
    });
  } catch (error) {
    console.error('获取题目失败:', error);
    res.status(500).json({
      success: false,
      message: '获取题目失败',
      error: error.message
    });
  }
});

// 添加题目 (需要管理员权限)
app.post('/api/questions', authenticate, requireAdmin, async (req, res) => {
  try {
    const { type, title, option_a, option_b, option_c, option_d, answer, score, category } = req.body;

    // 验证必填字段
    if (!type || !title || !answer) {
      return res.status(400).json({
        success: false,
        message: '缺少必填字段'
      });
    }

    const [result] = await pool.query(
      `INSERT INTO questions (type, title, option_a, option_b, option_c, option_d, answer, score, category)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [type, title, option_a || null, option_b || null, option_c || null, option_d || null, answer, score || 2, category || '党建知识']
    );

    res.json({
      success: true,
      message: '题目添加成功',
      insertId: result.insertId
    });
  } catch (error) {
    console.error('添加题目失败:', error);
    res.status(500).json({
      success: false,
      message: '添加题目失败',
      error: error.message
    });
  }
});

// 更新题目 (需要管理员权限)
app.put('/api/questions/:id', authenticate, requireAdmin, async (req, res) => {
  try {
    const { id } = req.params;
    const { type, title, option_a, option_b, option_c, option_d, answer, score, category } = req.body;

    const [result] = await pool.query(
      `UPDATE questions SET
       type = COALESCE(?, type),
       title = COALESCE(?, title),
       option_a = ?,
       option_b = ?,
       option_c = ?,
       option_d = ?,
       answer = COALESCE(?, answer),
       score = COALESCE(?, score),
       category = COALESCE(?, category)
       WHERE id = ?`,
      [type, title, option_a, option_b, option_c, option_d, answer, score, category, id]
    );

    if (result.affectedRows === 0) {
      return res.status(404).json({
        success: false,
        message: '题目不存在'
      });
    }

    res.json({
      success: true,
      message: '题目更新成功'
    });
  } catch (error) {
    console.error('更新题目失败:', error);
    res.status(500).json({
      success: false,
      message: '更新题目失败',
      error: error.message
    });
  }
});

// 删除题目 (需要管理员权限)
app.delete('/api/questions/:id', authenticate, requireAdmin, async (req, res) => {
  try {
    const { id } = req.params;
    const [result] = await pool.query(
      'DELETE FROM questions WHERE id = ?',
      [id]
    );

    if (result.affectedRows === 0) {
      return res.status(404).json({
        success: false,
        message: '题目不存在'
      });
    }

    res.json({
      success: true,
      message: '题目删除成功'
    });
  } catch (error) {
    console.error('删除题目失败:', error);
    res.status(500).json({
      success: false,
      message: '删除题目失败',
      error: error.message
    });
  }
});

// 批量添加题目 (需要管理员权限)
app.post('/api/questions/batch', authenticate, requireAdmin, async (req, res) => {
  try {
    const { questions } = req.body;

    if (!Array.isArray(questions) || questions.length === 0) {
      return res.status(400).json({
        success: false,
        message: '请提供有效的题目数组'
      });
    }

    const values = questions.map(q => [
      q.type, q.title, q.option_a || null, q.option_b || null,
      q.option_c || null, q.option_d || null, q.answer, q.score || 2, q.category || '党建知识'
    ]);

    const [result] = await pool.query(
      `INSERT INTO questions (type, title, option_a, option_b, option_c, option_d, answer, score, category) VALUES ?`,
      [values]
    );

    res.json({
      success: true,
      message: `成功添加 ${result.affectedRows} 道题目`,
      insertedCount: result.affectedRows
    });
  } catch (error) {
    console.error('批量添加题目失败:', error);
    res.status(500).json({
      success: false,
      message: '批量添加题目失败',
      error: error.message
    });
  }
});

// 获取题目统计
app.get('/api/statistics', async (req, res) => {
  try {
    const [typeStats] = await pool.query(
      'SELECT type, COUNT(*) as count FROM questions GROUP BY type'
    );
    const [totalResult] = await pool.query(
      'SELECT COUNT(*) as total FROM questions'
    );

    res.json({
      success: true,
      data: {
        total: totalResult[0].total,
        byType: typeStats
      }
    });
  } catch (error) {
    console.error('获取统计失败:', error);
    res.status(500).json({
      success: false,
      message: '获取统计失败',
      error: error.message
    });
  }
});

// ============================================================
// 答题记录API
// ============================================================

// 提交答题记录
app.post('/api/quiz/records', authenticate, async (req, res) => {
  try {
    const { total_questions, correct_answers, score, time_spent, quiz_data } = req.body;
    const userId = req.user.id;

    const wrongOnlyQuizData = Array.isArray(quiz_data)
      ? quiz_data.filter(item => item && item.is_correct === false)
      : [];

    if (!total_questions || correct_answers === undefined) {
      return res.status(400).json({
        success: false,
        message: '缺少必要参数'
      });
    }

    const [result] = await pool.query(
      `INSERT INTO quiz_records
       (user_id, total_questions, correct_answers, score, time_spent, quiz_data, start_time, end_time)
       VALUES (?, ?, ?, ?, ?, ?, NOW() - INTERVAL ? SECOND, NOW())`,
      [userId, total_questions, correct_answers, score || 0, time_spent || null,
       wrongOnlyQuizData.length ? JSON.stringify(wrongOnlyQuizData) : null, time_spent || 0]
    );

    res.json({
      success: true,
      message: '答题记录保存成功',
      recordId: result.insertId
    });
  } catch (error) {
    console.error('保存答题记录失败:', error);
    res.status(500).json({
      success: false,
      message: '保存答题记录失败',
      error: error.message
    });
  }
});

// 获取用户的答题记录
app.get('/api/quiz/records', authenticate, async (req, res) => {
  try {
    const userId = req.user.id;
    const { limit = 20, offset = 0 } = req.query;

    const [records] = await pool.query(
      `SELECT id, total_questions, correct_answers, score, time_spent,
              start_time, end_time, created_at
       FROM quiz_records
       WHERE user_id = ?
       ORDER BY created_at DESC
       LIMIT ? OFFSET ?`,
      [userId, parseInt(limit), parseInt(offset)]
    );

    // 获取总记录数
    const [countResult] = await pool.query(
      'SELECT COUNT(*) as total FROM quiz_records WHERE user_id = ?',
      [userId]
    );

    // 获取最高分和平均分
    const [statsResult] = await pool.query(
      `SELECT
         MAX(score) as highest_score,
         AVG(score) as average_score,
         COUNT(*) as total_attempts,
         SUM(total_questions) as total_questions_answered,
         SUM(correct_answers) as total_correct_answers
       FROM quiz_records
       WHERE user_id = ?`,
      [userId]
    );

    res.json({
      success: true,
      data: {
        records: records,
        pagination: {
          total: countResult[0].total,
          limit: parseInt(limit),
          offset: parseInt(offset)
        },
        stats: statsResult[0]
      }
    });
  } catch (error) {
    console.error('获取答题记录失败:', error);
    res.status(500).json({
      success: false,
      message: '获取答题记录失败',
      error: error.message
    });
  }
});

// 获取用户错题本
app.get('/api/quiz/wrong-notebook', authenticate, async (req, res) => {
  try {
    const userId = req.user.id;
    const { limit = 50 } = req.query;
    const data = await buildUserWrongNotebookData(userId, limit);

    res.json({
      success: true,
      data
    });
  } catch (error) {
    console.error('获取错题本失败:', error);
    res.status(500).json({
      success: false,
      message: '获取错题本失败',
      error: error.message
    });
  }
});

app.delete('/api/quiz/wrong-notebook/:questionId', authenticate, async (req, res) => {
  try {
    const userId = req.user.id;
    const questionId = String(req.params.questionId || '').trim();
    if (!questionId) {
      return res.status(400).json({ success: false, message: '题目标识不能为空' });
    }

    const removedMap = getUserWrongNotebookRemovedMap(userId);
    removedMap[questionId] = new Date().toISOString();
    saveWrongNotebookState();

    res.json({ success: true, message: '已移出错题本' });
  } catch (error) {
    console.error('移出错题本失败:', error);
    res.status(500).json({ success: false, message: '移出错题本失败', error: error.message });
  }
});

// 获取答题排行榜
app.get('/api/quiz/leaderboard', async (req, res) => {
  try {
    const { limit = 10, period = 'all' } = req.query;

    let dateFilter = '';
    if (period === 'week') {
      dateFilter = 'AND created_at >= DATE_SUB(NOW(), INTERVAL 7 DAY)';
    } else if (period === 'month') {
      dateFilter = 'AND created_at >= DATE_SUB(NOW(), INTERVAL 30 DAY)';
    }

    const [leaderboard] = await pool.query(
      `SELECT
         u.id as user_id,
         u.username,
         u.name,
         u.avatar,
         COUNT(DISTINCT r.id) as attempts,
         MAX(r.score) as highest_score,
         AVG(r.score) as average_score,
         SUM(r.correct_answers) as total_correct
       FROM users u
       LEFT JOIN quiz_records r ON u.id = r.user_id
       WHERE u.is_active = TRUE
         ${dateFilter}
       GROUP BY u.id, u.username, u.name, u.avatar
       ORDER BY highest_score DESC, attempts DESC
       LIMIT ?`,
      [parseInt(limit)]
    );

    res.json({
      success: true,
      data: leaderboard
    });
  } catch (error) {
    console.error('获取排行榜失败:', error);
    res.status(500).json({
      success: false,
      message: '获取排行榜失败',
      error: error.message
    });
  }
});

// ============================================================
// 收藏功能API
// ============================================================

// 添加收藏
app.post('/api/favorites', authenticate, async (req, res) => {
  try {
    const { question_id } = req.body;
    const userId = req.user.id;

    if (!question_id) {
      return res.status(400).json({
        success: false,
        message: '请提供题目ID'
      });
    }

    // 检查题目是否存在
    const [questions] = await pool.query(
      'SELECT id FROM questions WHERE id = ?',
      [question_id]
    );

    if (questions.length === 0) {
      return res.status(404).json({
        success: false,
        message: '题目不存在'
      });
    }

    // 检查是否已收藏
    const [existingFavorites] = await pool.query(
      'SELECT id FROM user_favorites WHERE user_id = ? AND question_id = ?',
      [userId, question_id]
    );

    if (existingFavorites.length > 0) {
      return res.status(400).json({
        success: false,
        message: '该题目已收藏'
      });
    }

    await pool.query(
      'INSERT INTO user_favorites (user_id, question_id) VALUES (?, ?)',
      [userId, question_id]
    );

    res.json({
      success: true,
      message: '收藏成功'
    });
  } catch (error) {
    console.error('添加收藏失败:', error);
    res.status(500).json({
      success: false,
      message: '添加收藏失败',
      error: error.message
    });
  }
});

// 删除收藏
app.delete('/api/favorites/:question_id', authenticate, async (req, res) => {
  try {
    const { question_id } = req.params;
    const userId = req.user.id;

    const [result] = await pool.query(
      'DELETE FROM user_favorites WHERE user_id = ? AND question_id = ?',
      [userId, question_id]
    );

    if (result.affectedRows === 0) {
      return res.status(404).json({
        success: false,
        message: '收藏记录不存在'
      });
    }

    res.json({
      success: true,
      message: '取消收藏成功'
    });
  } catch (error) {
    console.error('删除收藏失败:', error);
    res.status(500).json({
      success: false,
      message: '删除收藏失败',
      error: error.message
    });
  }
});

// 获取用户的收藏列表
app.get('/api/favorites', authenticate, async (req, res) => {
  try {
    const userId = req.user.id;
    const { limit = 20, offset = 0 } = req.query;

    const [favorites] = await pool.query(
      `SELECT
         f.id as favorite_id,
         f.created_at as favorited_at,
         q.id as question_id,
         q.type,
         q.title,
         q.option_a,
         q.option_b,
         q.option_c,
         q.option_d,
         q.answer,
         q.score,
         q.category
       FROM user_favorites f
       JOIN questions q ON f.question_id = q.id
       WHERE f.user_id = ?
       ORDER BY f.created_at DESC
       LIMIT ? OFFSET ?`,
      [userId, parseInt(limit), parseInt(offset)]
    );

    // 获取总收藏数
    const [countResult] = await pool.query(
      'SELECT COUNT(*) as total FROM user_favorites WHERE user_id = ?',
      [userId]
    );

    res.json({
      success: true,
      data: {
        favorites: favorites,
        total: countResult[0].total
      }
    });
  } catch (error) {
    console.error('获取收藏列表失败:', error);
    res.status(500).json({
      success: false,
      message: '获取收藏列表失败',
      error: error.message
    });
  }
});

// ============================================================
// 动态内容API（新闻、活动、轮播、统计、党建内容）
// ============================================================

// ============================================================
// 内容数据持久化（JSON 文件）
// ============================================================
const CONTENT_STORE_FILE = path.join(__dirname, 'content-store.json');

const DEFAULT_CHARTER_CONTENT = [
  {
    id: 1,
    title: '中国共产党章程（节选）',
    tag: '党章党规',
    tagColor: 'red',
    date: '2022-10-22',
    sub: '学习资料',
    content: '中国共产党是中国工人阶级的先锋队，同时是中国人民和中华民族的先锋队，是中国特色社会主义事业的领导核心，代表中国先进生产力的发展要求，代表中国先进文化的前进方向，代表中国最广大人民的根本利益。党的最高理想和最终目标是实现共产主义。\n\n中国共产党以马克思列宁主义、毛泽东思想、邓小平理论、"三个代表"重要思想、科学发展观、习近平新时代中国特色社会主义思想作为自己的行动指南。',
    bg: 'linear-gradient(135deg,#4a0000,#960000)'
  }
];

function ensureContentStoreStructure() {
  let changed = false;

  if (!contentStore.partyContent || typeof contentStore.partyContent !== 'object') {
    contentStore.partyContent = {};
    changed = true;
  }

  if (!Array.isArray(contentStore.partyContent.charter) || contentStore.partyContent.charter.length === 0) {
    contentStore.partyContent.charter = JSON.parse(JSON.stringify(DEFAULT_CHARTER_CONTENT));
    changed = true;
  }

  ['policy', 'history', 'tech'].forEach((category) => {
    if (category in contentStore.partyContent) {
      delete contentStore.partyContent[category];
      changed = true;
    }
  });

  return changed;
}

function saveContentStore() {
  try {
    fs.writeFileSync(CONTENT_STORE_FILE, JSON.stringify(contentStore, null, 2), 'utf8');
  } catch (e) {
    console.error('⚠️ 内容数据保存失败:', e.message);
  }
}

function loadContentStore() {
  try {
    if (fs.existsSync(CONTENT_STORE_FILE)) {
      const raw = fs.readFileSync(CONTENT_STORE_FILE, 'utf8');
      const saved = JSON.parse(raw);
      // 将保存的数据合并到 contentStore（保留默认结构）
      Object.assign(contentStore, saved);
      const changed = ensureContentStoreStructure();
      if (changed) saveContentStore();
      console.log('✅ 内容数据已从文件加载（包含图片）');
    }
  } catch (e) {
    console.error('⚠️ 内容数据加载失败，使用默认数据:', e.message);
  }
}

// --- 内存数据存储（后续可迁移至数据库） ---
let contentStore = {
  slides: [
    { id: 1, tag: '党建活动', title: '2024年人工智能协会<br>党员发展大会圆满举行', desc: '全体党员深入学习贯彻习近平新时代中国特色社会主义思想，共谋社团党建新发展', link: 'party-detail.html', linkText: '查看详情 →', bg: 'linear-gradient(135deg,#4a0000,#c90000,#165DFF)' },
    { id: 2, tag: 'AI社团风采', title: '人工智能 × 党建融合<br>科技赋能新时代党建工作', desc: '用人工智能技术助力党建工作现代化，打造智慧党建新模式', link: 'showcase.html', linkText: '了解更多 →', bg: 'linear-gradient(135deg,#003a99,#165DFF,#c90000)' },
    { id: 3, tag: '学习园地', title: '党建学习中心正式上线<br>在线答题·学习积分·资料库', desc: '构建完善的党员学习体系，随时随地学党史、知党情、跟党走', link: 'study.html', linkText: '进入学习 →', bg: 'linear-gradient(135deg,#5a0000,#960000,#0032aa)' }
  ],
  news: [
    { id: 1, icon: '🚩', title: '人工智能协会2024年度党员发展大会圆满召开', tag: '要闻', tagColor: 'red', date: '2024-12-15', link: 'party-detail.html' },
    { id: 2, icon: '📖', title: '关于深入开展主题教育学习活动的通知', tag: '通知', tagColor: 'blue', date: '2024-12-10', link: 'party-detail.html' },
    { id: 3, icon: '🎖️', title: '社团党支部荣获"优秀党支部"称号', tag: '荣誉', tagColor: 'gold', date: '2024-12-05', link: 'party-detail.html' },
    { id: 4, icon: '🏛️', title: '第四季度预备党员宣誓仪式隆重举行', tag: '活动', tagColor: 'red', date: '2024-11-28', link: 'party-detail.html' },
    { id: 5, icon: '💡', title: 'AI赋能党建：智慧党建平台建设工作汇报', tag: 'AI党建', tagColor: 'blue', date: '2024-11-20', link: 'party-detail.html' }
  ],
  activities: [
    { id: 1, icon: '🚩', title: '2024年第四季度主题党日活动', tag: '党日活动', tagColor: 'red', status: '报名中', statusColor: 'green', date: '2024-12-20 14:00', location: '图书馆报告厅', enrolled: 28, capacity: 50, bg: 'linear-gradient(135deg,#4a0000,#c90000)', btnColor: 'red', btnText: '立即报名' },
    { id: 2, icon: '🤖', title: 'AI技术与党建融合研讨会', tag: 'AI融合', tagColor: 'blue', status: '报名中', statusColor: 'green', date: '2024-12-18 10:00', location: '实验楼202', enrolled: 15, capacity: 30, bg: 'linear-gradient(135deg,#003a99,#165DFF)', btnColor: 'blue', btnText: '立即报名' },
    { id: 3, icon: '📖', title: '党史学习教育专题讲座', tag: '学习教育', tagColor: 'gold', status: '已结束', statusColor: 'gray', date: '2024-12-10 09:00', location: '行政楼多功能厅', enrolled: 45, capacity: 45, bg: 'linear-gradient(135deg,#5a3000,#c9a84c)', btnColor: 'outline', btnText: '查看回顾' },
    { id: 4, icon: '🏛️', title: '第四季度预备党员宣誓仪式', tag: '仪式活动', tagColor: 'red', status: '已结束', statusColor: 'gray', date: '2024-11-28 09:00', location: '党建活动室', enrolled: 20, capacity: 20, bg: 'linear-gradient(135deg,#4a0000,#960000)', btnColor: 'outline', btnText: '查看回顾' },
    { id: 5, icon: '🌟', title: '党员志愿服务进社区活动', tag: '志愿服务', tagColor: 'blue', status: '报名中', statusColor: 'green', date: '2024-12-22 08:30', location: '周边社区', enrolled: 12, capacity: 20, bg: 'linear-gradient(135deg,#003a99,#165DFF)', btnColor: 'blue', btnText: '立即报名' },
    { id: 6, icon: '📝', title: '2024年度组织生活会', tag: '组织生活', tagColor: 'red', status: '报名中', statusColor: 'green', date: '2024-12-25 14:00', location: '党建活动室', enrolled: 30, capacity: 36, bg: 'linear-gradient(135deg,#5a0000,#c90000)', btnColor: 'red', btnText: '立即报名' }
  ],
  messages: [],
  siteStats: {
    partyBranches: 1, partyMembers: 36, totalActivities: 58, participationRate: 100
  },
  partyContent: {
    news: [
      { id: 1, icon: '🚩', title: '人工智能协会2024年度党员发展大会圆满召开', tag: '要闻', tagColor: 'red', date: '2024-12-15', bg: 'linear-gradient(135deg,#4a0000,#c90000)' },
      { id: 2, icon: '📋', title: '关于深入开展主题教育学习活动的通知', tag: '通知', tagColor: 'blue', date: '2024-12-10', bg: 'linear-gradient(135deg,#003a99,#165DFF)' },
      { id: 3, icon: '🎖️', title: '社团党支部荣获"优秀党支部"称号', tag: '荣誉', tagColor: 'gold', date: '2024-12-05', bg: 'linear-gradient(135deg,#5a3000,#c9a84c)' },
      { id: 4, icon: '🏛️', title: '第四季度预备党员宣誓仪式隆重举行', tag: '活动', tagColor: 'red', date: '2024-11-28', bg: 'linear-gradient(135deg,#4a0000,#960000)' },
      { id: 5, icon: '💡', title: 'AI赋能党建：智慧党建平台建设工作汇报', tag: 'AI党建', tagColor: 'blue', date: '2024-11-20', bg: 'linear-gradient(135deg,#003a99,#0040CC)' },
      { id: 6, icon: '📰', title: '党支部书记开展"不忘初心"专题组织生活会', tag: '组织生活', tagColor: 'red', date: '2024-11-15', bg: 'linear-gradient(135deg,#4a0000,#c90000)' }
    ],
    charter: JSON.parse(JSON.stringify(DEFAULT_CHARTER_CONTENT)),
    culture: [
      { id: 1, icon: '🏔️', title: '长征精神：伟大的精神力量', tag: '红色文化', tagColor: 'red', bg: 'linear-gradient(135deg,#4a0000,#c90000)' },
      { id: 2, icon: '🌾', title: '延安精神：艰苦奋斗、实事求是', tag: '红色文化', tagColor: 'red', bg: 'linear-gradient(135deg,#5a0000,#960000)' },
      { id: 3, icon: '🕊️', title: '雷锋精神：全心全意为人民服务', tag: '精神谱系', tagColor: 'blue', bg: 'linear-gradient(135deg,#003a99,#165DFF)' }
    ]
  },
  showcaseContent: {
    intro: {
      about: [
        '人工智能协会成立于2021年，是首个以人工智能技术为核心的学生社团，现有成员120余人，党员36名。',
        '社团以"智汇智慧、AI引领"为宗旨，将党建工作与AI技术深度融合，致力于培养德才兼备的复合型AI人才。',
        '党支部自成立以来，连续三年获评"优秀党支部"，多次承办党建创新活动。'
      ],
      stats: {
        members: 120,
        excellentYears: 3,
        activities: 58,
        honors: 15
      }
    },
    activities: [
      { id: 1, icon: '🤖', title: 'AI+党建创新实验室成果展示', tag: 'AI融合', tagColor: 'blue', date: '2024-11-30', content: '展示AI赋能党建的技术成果与应用实践。' },
      { id: 2, icon: '🚩', title: '智慧党建平台上线发布会', tag: '重大活动', tagColor: 'red', date: '2024-10-01', content: '发布新一代智慧党建平台，推动党建数字化。' },
      { id: 3, icon: '🏆', title: '全国高校党建创新大赛获奖', tag: '荣誉', tagColor: 'gold', date: '2024-09-15', content: '凭借AI党建方案获得全国高校党建创新大赛奖项。' }
    ],
    members: [],
    honors: [
      { id: 1, icon: '🏆', title: '全国高校党建创新大赛一等奖', level: '全国级', date: '2024年', content: '以AI赋能党建项目获评一等奖。' },
      { id: 2, icon: '🎖️', title: '优秀党支部（三连冠）', level: '党委级', date: '2022-2024年', content: '连续三年获评优秀党支部。' },
      { id: 3, icon: '⭐', title: 'AI应用创新奖', level: '省级', date: '2024年', content: '社团项目在省级竞赛中获奖。' }
    ]
  }
};

// 获取轮播数据
app.get('/api/content/slides', (req, res) => {
  res.json({ success: true, data: contentStore.slides });
});

// 获取新闻列表
app.get('/api/content/news', (req, res) => {
  const { limit, summary } = req.query;
  let data = contentStore.news;
  if (limit) data = data.slice(0, parseInt(limit));
  if (String(summary) === '1') data = data.map(toSummaryNews);
  res.json({ success: true, data });
});

// 获取活动列表
app.get('/api/content/activities', (req, res) => {
  const { status, limit, summary } = req.query;
  let data = contentStore.activities;
  if (status && status !== '全部活动') {
    data = data.filter(a => a.status === status);
  }
  if (limit) data = data.slice(0, parseInt(limit));
  if (String(summary) === '1') data = data.map(toSummaryActivity);
  res.json({ success: true, data });
});

// 获取留言建议（仅公开已通过）
app.get('/api/content/messages', (req, res) => {
  const { type, limit } = req.query;
  let data = (contentStore.messages || []).filter(item => item.status === '已通过');
  if (type && type !== '全部类型') {
    data = data.filter(item => item.type === type);
  }
  data.sort((a, b) => String(b.createdAt || '').localeCompare(String(a.createdAt || '')));
  if (limit) data = data.slice(0, parseInt(limit, 10));
  res.json({ success: true, data: data.map(({ contact, ...publicMessage }) => publicMessage) });
});

// 提交留言建议（公开接口）
app.post('/api/content/messages', (req, res) => {
  const anonymous = req.body.anonymous === true || req.body.anonymous === 'true';
  const name = String(req.body.name || '').trim();
  const content = String(req.body.content || '').trim();
  const type = String(req.body.type || '意见建议').trim() || '意见建议';
  const contact = String(req.body.contact || '').trim();

  if (!anonymous && !name) {
    return res.status(400).json({ success: false, message: '请输入姓名或昵称' });
  }
  if (!content) {
    return res.status(400).json({ success: false, message: '请输入留言内容' });
  }
  if (content.length > 1000) {
    return res.status(400).json({ success: false, message: '留言内容不能超过1000字' });
  }

  const item = {
    id: contentStore.messages.length > 0 ? Math.max(...contentStore.messages.map(m => m.id)) + 1 : 1,
    name: anonymous ? '匿名用户' : name,
    contact: anonymous ? '' : contact,
    anonymous,
    type,
    content,
    status: '待审核',
    createdAt: new Date().toISOString().slice(0, 19).replace('T', ' '),
    reviewedAt: null
  };

  contentStore.messages.unshift(item);
  saveContentStore();
  res.json({ success: true, message: '留言提交成功，待管理员审核', data: item });
});

// 获取站点统计
app.get('/api/content/site-stats', async (req, res) => {
  const realtimeCounts = await getRealtimeCountsFast();
  res.json({
    success: true,
    data: buildSiteStatsPayload(realtimeCounts)
  });
});

// 首页聚合数据（首访优化：减少前端请求次数）
app.get('/api/content/home', async (req, res) => {
  const newsLimit = Math.min(Math.max(parseInt(req.query.newsLimit || '5', 10), 1), 20);
  const actLimit = Math.min(Math.max(parseInt(req.query.activityLimit || '3', 10), 1), 20);
  const realtimeCounts = await getRealtimeCountsFast();

  res.json({
    success: true,
    data: {
      slides: contentStore.slides.map(toSummarySlide),
      news: contentStore.news.slice(0, newsLimit).map(toSummaryNews),
      activities: contentStore.activities.slice(0, actLimit).map(toSummaryActivity),
      stats: buildSiteStatsPayload(realtimeCounts)
    }
  });
});

// 获取党建内容（按分类）
// 注意：news 分类直接复用 contentStore.news，保证后台"党建内容管理"与党建引领页数据一致
app.get('/api/content/party/:category', (req, res) => {
  const { category } = req.params;
  if (category === 'news') {
    return res.json({ success: true, data: contentStore.news });
  }
  const data = contentStore.partyContent[category];
  if (!data) {
    return res.status(404).json({ success: false, message: '分类不存在' });
  }
  res.json({ success: true, data });
});

// 更新党建内容分类数据（管理员）
app.put('/api/content/party/:category', authenticate, requireAdmin, (req, res) => {
  const { category } = req.params;
  const allowed = ['charter', 'culture'];
  if (!allowed.includes(category)) {
    return res.status(404).json({ success: false, message: '分类不存在或不支持直接更新' });
  }

  const payload = req.body;
  if (!Array.isArray(payload)) {
    return res.status(400).json({ success: false, message: '请求数据格式不正确' });
  }

  if (!contentStore.partyContent) {
    contentStore.partyContent = {};
  }

  contentStore.partyContent[category] = payload;
  saveContentStore();
  res.json({ success: true, message: '党建分类内容更新成功', data: contentStore.partyContent[category] });
});

// 获取社团风采内容（按分类）
app.get('/api/content/showcase/:category', (req, res) => {
  const { category } = req.params;
  const showcase = contentStore.showcaseContent || {};
  const allowed = ['intro', 'activities', 'members', 'honors'];
  if (!allowed.includes(category)) {
    return res.status(404).json({ success: false, message: '分类不存在' });
  }
  const data = showcase[category];
  if (data === undefined) {
    return res.status(404).json({ success: false, message: '分类数据不存在' });
  }
  res.json({ success: true, data });
});

// ---- 内容管理 CRUD（管理员） ----

// 添加新闻
app.post('/api/content/news', authenticate, requireAdmin, (req, res) => {
  const item = req.body;
  item.id = contentStore.news.length > 0 ? Math.max(...contentStore.news.map(n => n.id)) + 1 : 1;
  contentStore.news.unshift(item);
  saveContentStore();
  res.json({ success: true, message: '新闻添加成功', data: item });
});

// 更新新闻
app.put('/api/content/news/:id', authenticate, requireAdmin, (req, res) => {
  const id = parseInt(req.params.id);
  const idx = contentStore.news.findIndex(n => n.id === id);
  if (idx === -1) return res.status(404).json({ success: false, message: '新闻不存在' });
  contentStore.news[idx] = { ...contentStore.news[idx], ...req.body, id };
  saveContentStore();
  res.json({ success: true, message: '新闻更新成功', data: contentStore.news[idx] });
});

// 删除新闻
app.delete('/api/content/news/:id', authenticate, requireAdmin, (req, res) => {
  const id = parseInt(req.params.id);
  const idx = contentStore.news.findIndex(n => n.id === id);
  if (idx === -1) return res.status(404).json({ success: false, message: '新闻不存在' });
  contentStore.news.splice(idx, 1);
  saveContentStore();
  res.json({ success: true, message: '新闻删除成功' });
});

// 添加活动
app.post('/api/content/activities', authenticate, requireAdmin, (req, res) => {
  const item = req.body;
  item.id = contentStore.activities.length > 0 ? Math.max(...contentStore.activities.map(a => a.id)) + 1 : 1;
  contentStore.activities.unshift(item);
  saveContentStore();
  res.json({ success: true, message: '活动添加成功', data: item });
});

// 更新活动
app.put('/api/content/activities/:id', authenticate, requireAdmin, (req, res) => {
  const id = parseInt(req.params.id);
  const idx = contentStore.activities.findIndex(a => a.id === id);
  if (idx === -1) return res.status(404).json({ success: false, message: '活动不存在' });
  contentStore.activities[idx] = { ...contentStore.activities[idx], ...req.body, id };
  saveContentStore();
  res.json({ success: true, message: '活动更新成功', data: contentStore.activities[idx] });
});

// 删除活动
app.delete('/api/content/activities/:id', authenticate, requireAdmin, (req, res) => {
  const id = parseInt(req.params.id);
  const idx = contentStore.activities.findIndex(a => a.id === id);
  if (idx === -1) return res.status(404).json({ success: false, message: '活动不存在' });
  contentStore.activities.splice(idx, 1);
  saveContentStore();
  res.json({ success: true, message: '活动删除成功' });
});

// 更新社团风采分类数据（管理员）
app.put('/api/content/showcase/:category', authenticate, requireAdmin, (req, res) => {
  const { category } = req.params;
  const allowed = ['intro', 'activities', 'members', 'honors'];
  if (!allowed.includes(category)) {
    return res.status(404).json({ success: false, message: '分类不存在' });
  }

  if (!contentStore.showcaseContent) {
    contentStore.showcaseContent = {};
  }

  const payload = req.body;
  if ((category === 'intro' && (typeof payload !== 'object' || payload === null || Array.isArray(payload))) ||
      (category !== 'intro' && !Array.isArray(payload))) {
    return res.status(400).json({ success: false, message: '请求数据格式不正确' });
  }

  contentStore.showcaseContent[category] = payload;
  saveContentStore();
  res.json({ success: true, message: '社团风采数据更新成功', data: contentStore.showcaseContent[category] });
});

// 管理员：获取留言建议列表
app.get('/api/content/messages/admin', authenticate, requireAdmin, (req, res) => {
  const { status, type, limit } = req.query;
  let data = contentStore.messages || [];
  if (status && status !== '全部状态') {
    data = data.filter(item => item.status === status);
  }
  if (type && type !== '全部类型') {
    data = data.filter(item => item.type === type);
  }
  data = data.slice().sort((a, b) => String(b.createdAt || '').localeCompare(String(a.createdAt || '')));
  if (limit) data = data.slice(0, parseInt(limit, 10));
  res.json({ success: true, data });
});

// 管理员：审核留言建议
app.put('/api/content/messages/:id/review', authenticate, requireAdmin, (req, res) => {
  const id = parseInt(req.params.id, 10);
  const status = String(req.body.status || '').trim();
  if (!['待审核', '已通过', '已驳回'].includes(status)) {
    return res.status(400).json({ success: false, message: '无效的审核状态' });
  }

  const idx = contentStore.messages.findIndex(item => item.id === id);
  if (idx === -1) {
    return res.status(404).json({ success: false, message: '留言不存在' });
  }

  contentStore.messages[idx] = {
    ...contentStore.messages[idx],
    status,
    reviewedAt: new Date().toISOString().slice(0, 19).replace('T', ' ')
  };
  saveContentStore();
  res.json({ success: true, message: '留言状态更新成功', data: contentStore.messages[idx] });
});

// 管理员：删除留言建议
app.delete('/api/content/messages/:id', authenticate, requireAdmin, (req, res) => {
  const id = parseInt(req.params.id, 10);
  const idx = contentStore.messages.findIndex(item => item.id === id);
  if (idx === -1) {
    return res.status(404).json({ success: false, message: '留言不存在' });
  }
  contentStore.messages.splice(idx, 1);
  saveContentStore();
  res.json({ success: true, message: '留言删除成功' });
});

// 更新站点统计
app.put('/api/content/site-stats', authenticate, requireAdmin, (req, res) => {
  contentStore.siteStats = { ...contentStore.siteStats, ...req.body };
  saveContentStore();
  res.json({ success: true, message: '统计更新成功', data: contentStore.siteStats });
});

// 添加轮播
app.post('/api/content/slides', authenticate, requireAdmin, (req, res) => {
  const item = req.body;
  item.id = contentStore.slides.length > 0 ? Math.max(...contentStore.slides.map(s => s.id)) + 1 : 1;
  contentStore.slides.push(item);
  saveContentStore();
  res.json({ success: true, message: '轮播添加成功', data: item });
});

// 更新轮播
app.put('/api/content/slides/:id', authenticate, requireAdmin, (req, res) => {
  const id = parseInt(req.params.id);
  const idx = contentStore.slides.findIndex(s => s.id === id);
  if (idx === -1) return res.status(404).json({ success: false, message: '轮播不存在' });
  contentStore.slides[idx] = { ...contentStore.slides[idx], ...req.body, id };
  saveContentStore();
  res.json({ success: true, message: '轮播更新成功', data: contentStore.slides[idx] });
});

// 删除轮播
app.delete('/api/content/slides/:id', authenticate, requireAdmin, (req, res) => {
  const id = parseInt(req.params.id);
  const idx = contentStore.slides.findIndex(s => s.id === id);
  if (idx === -1) return res.status(404).json({ success: false, message: '轮播不存在' });
  contentStore.slides.splice(idx, 1);
  saveContentStore();
  res.json({ success: true, message: '轮播删除成功' });
});

// ============================================================
// 系统API
// ============================================================

const CHAT_KNOWLEDGE_BASE = {
  '入党': '加入中国共产党，需满足以下基本条件：\n① 年满18周岁的中国工人、农民、军人、知识分子和其他社会阶层的先进分子\n② 承认党的纲领和章程\n③ 愿意参加党的一个组织并在其中积极工作\n④ 执行党的决议\n⑤ 按时缴纳党费',
  '义务': '党员的八项义务：\n① 认真学习马克思列宁主义、毛泽东思想等\n② 贯彻执行党的基本路线和各项方针政策\n③ 坚持党和人民的利益高于一切\n④ 自觉遵守党的纪律\n⑤ 维护党的团结和统一\n⑥ 密切联系群众\n⑦ 发扬社会主义新风尚\n⑧ 切实开展批评和自我批评',
  '民主集中制': '民主集中制是党的根本组织制度和领导制度，其基本原则是：\n① 个人服从组织\n② 少数服从多数\n③ 下级服从上级\n④ 全党服从中央',
  '最高领导机构': '党的最高领导机关，是党的全国代表大会和它所产生的中央委员会。在全国代表大会闭会期间，中央委员会领导党的全部工作。',
  '积极分子': '申请成为入党积极分子的步骤：\n① 向所在党支部书面提交入党申请书\n② 党支部指定1-2名正式党员作为培养联系人\n③ 经支部大会讨论通过，确定为入党积极分子\n④ 参加党组织安排的教育培训（不少于一年）',
  '党费': '党费缴纳规定：\n• 3000元以下：0.5%\n• 3000-5000元：1%\n• 5000-10000元：1.5%\n• 10000元以上：2%\n• 学生党员：每月1元',
  '组织生活': '党的组织生活主要形式：\n① 党员大会（支部大会）\n② 党支部委员会会议\n③ 党小组会议\n④ 党员领导干部民主生活会\n⑤ 批评和自我批评',
  '纪律': '党的纪律处分有5种：\n① 警告\n② 严重警告\n③ 撤销党内职务\n④ 留党察看\n⑤ 开除党籍'
};

const DEEPSEEK_CONFIG = {
  baseUrl: (process.env.DEEPSEEK_BASE_URL || 'https://api.deepseek.com').replace(/\/$/, ''),
  apiKey: process.env.DEEPSEEK_API_KEY || '',
  model: process.env.DEEPSEEK_MODEL || 'deepseek-flash',
  timeoutMs: Number(process.env.DEEPSEEK_TIMEOUT_MS || 15000)
};

function deepSeekReady() {
  return Boolean(DEEPSEEK_CONFIG.apiKey);
}

function normalizeHistory(history) {
  if (!Array.isArray(history)) return [];

  return history
    .filter(item => item && (item.role === 'user' || item.role === 'assistant') && typeof item.content === 'string')
    .slice(-12)
    .map(item => ({ role: item.role, content: item.content.trim() }))
    .filter(item => item.content.length > 0);
}

async function askDeepSeek(message, history) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), DEEPSEEK_CONFIG.timeoutMs);

  const systemPrompt = [
    '你是一个中文AI党建。',
    '回答要准确、简洁、友好。',
    '当问题与党建无关时，简短提醒用户聚焦党建主题。',
    '不要编造政策条文和日期，不确定时明确说明。'
  ].join('\n');

  const payload = {
    model: DEEPSEEK_CONFIG.model,
    messages: [
      { role: 'system', content: systemPrompt },
      ...normalizeHistory(history),
      { role: 'user', content: String(message || '').trim() }
    ],
    temperature: 0.4,
    stream: false
  };

  try {
    const response = await fetch(`${DEEPSEEK_CONFIG.baseUrl}/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${DEEPSEEK_CONFIG.apiKey}`
      },
      body: JSON.stringify(payload),
      signal: controller.signal
    });

    const data = await response.json().catch(() => null);

    if (!response.ok) {
      const errorMessage = data && data.error && data.error.message
        ? data.error.message
        : `DeepSeek请求失败(${response.status})`;
      throw new Error(errorMessage);
    }

    const reply = data && data.choices && data.choices[0] && data.choices[0].message
      ? data.choices[0].message.content
      : '';

    if (!reply || !reply.trim()) {
      throw new Error('DeepSeek返回内容为空');
    }

    return {
      reply: reply.trim(),
      model: data.model || DEEPSEEK_CONFIG.model
    };
  } finally {
    clearTimeout(timer);
  }
}

function buildChatResponse(message) {
  const normalizedMessage = String(message || '').trim();

  if (!normalizedMessage) {
    return {
      answer: '请输入您的党建问题，例如：入党的基本条件是什么？',
      matchedKeyword: null,
      suggestions: ['入党条件', '党员义务', '民主集中制']
    };
  }

  for (const [keyword, answer] of Object.entries(CHAT_KNOWLEDGE_BASE)) {
    if (normalizedMessage.includes(keyword)) {
      return {
        answer,
        matchedKeyword: keyword,
        suggestions: ['入党条件', '党员义务', '民主集中制', '党费缴纳', '组织生活会']
      };
    }
  }

  const relatedNews = Array.isArray(contentStore.news)
    ? contentStore.news.filter(item => normalizedMessage.includes('活动') || normalizedMessage.includes('学习') || normalizedMessage.includes('党建'))
        .slice(0, 2)
        .map(item => `• ${item.title}`)
    : [];

  const answer = [
    '抱歉，我暂时无法直接回答这个问题。您可以换一种问法，或尝试下面这些主题：',
    '• 入党条件',
    '• 党员义务',
    '• 民主集中制',
    '• 入党积极分子',
    '• 党费缴纳',
    '• 组织生活会',
    '• 党的纪律处分'
  ];

  if (relatedNews.length > 0) {
    answer.push('', '您也可以先查看这些平台内容：', ...relatedNews);
  }

  return {
    answer: answer.join('\n'),
    matchedKeyword: null,
    suggestions: ['入党条件', '党员义务', '民主集中制', '入党积极分子']
  };
}

// 健康检查
app.get('/api/health', (req, res) => {
  res.json({
    success: true,
    message: 'API服务运行正常',
    timestamp: new Date().toISOString()
  });
});

app.get('/api/chat/health', (req, res) => {
  res.json({
    success: true,
    message: 'Chat服务预热成功',
    timestamp: new Date().toISOString()
  });
});

app.post('/api/chat', async (req, res) => {
  const { message, history } = req.body || {};

  if (!message || typeof message !== 'string' || !message.trim()) {
    return res.status(400).json({
      success: false,
      message: 'message 不能为空'
    });
  }

  if (deepSeekReady()) {
    try {
      const llm = await askDeepSeek(message, history);
      return res.json({
        success: true,
        data: {
          reply: llm.reply,
          matchedKeyword: null,
          suggestions: ['入党条件', '党员义务', '民主集中制', '组织生活会'],
          historyLength: Array.isArray(history) ? history.length : 0,
          model: llm.model,
          provider: 'deepseek'
        }
      });
    } catch (error) {
      console.error('DeepSeek调用失败，回退本地知识库:', error.message);
    }
  }

  const response = buildChatResponse(message);

  res.json({
    success: true,
    data: {
      reply: response.answer,
      matchedKeyword: response.matchedKeyword,
      suggestions: response.suggestions,
      historyLength: Array.isArray(history) ? history.length : 0,
      model: 'rule-based-party-assistant',
      provider: 'local-fallback'
    }
  });
});

// 系统统计
app.get('/api/system/stats', authenticate, requireAdmin, async (req, res) => {
  try {
    const [userStats] = await pool.query(
      'SELECT COUNT(*) as total_users, SUM(is_active = TRUE) as active_users FROM users'
    );
    const [questionStats] = await pool.query(
      'SELECT COUNT(*) as total_questions FROM questions'
    );
    const [recordStats] = await pool.query(
      'SELECT COUNT(*) as total_records, AVG(score) as avg_score FROM quiz_records'
    );

    res.json({
      success: true,
      data: {
        users: userStats[0],
        questions: questionStats[0],
        records: recordStats[0]
      }
    });
  } catch (error) {
    console.error('获取系统统计失败:', error);
    res.status(500).json({
      success: false,
      message: '获取系统统计失败',
      error: error.message
    });
  }
});

// 根路径
app.get('/api', (req, res) => {
  res.json({
    name: '党建平台增强版API服务',
    version: '2.0.0',
    description: '包含用户认证、题库管理、答题记录和收藏功能',
    endpoints: {
      auth: [
        'POST /api/auth/login      - 用户登录',
        'POST /api/auth/register   - 用户注册',
        'GET  /api/auth/me         - 获取当前用户信息'
      ],
      users: [
        'GET  /api/users           - 获取所有用户（管理员）',
        'POST /api/users           - 新增用户（管理员）',
        'PUT  /api/users/:id       - 更新用户信息（管理员）',
        'DELETE /api/users/:id     - 删除用户（管理员）',
        'POST /api/users/:id/reset-password - 重置密码（管理员）'
      ],
      questions: [
        'GET  /api/questions       - 获取所有题目',
        'GET  /api/questions/:id   - 获取单题',
        'GET  /api/questions/type/:type - 按题型获取',
        'POST /api/questions       - 添加题目（管理员）',
        'PUT  /api/questions/:id   - 更新题目（管理员）',
        'DELETE /api/questions/:id - 删除题目（管理员）',
        'POST /api/questions/batch - 批量添加（管理员）',
        'GET  /api/statistics      - 获取题目统计'
      ],
      quiz: [
        'POST /api/quiz/records    - 提交答题记录',
        'GET  /api/quiz/records    - 获取用户答题记录',
        'GET  /api/quiz/leaderboard - 获取排行榜',
        'GET  /api/quiz/wrong-notebook - 获取用户错题本'
      ],
      favorites: [
        'POST /api/favorites       - 添加收藏',
        'DELETE /api/favorites/:id - 删除收藏',
        'GET  /api/favorites       - 获取收藏列表'
      ],
      system: [
        'POST /api/chat            - AI党建问答',
        'GET  /api/health          - 健康检查',
        'GET  /api/system/stats    - 系统统计（管理员）'
      ]
    }
  });
});

// Only public assets are served. Backend code, local configuration and data stay private.
const publicRoot = path.resolve(__dirname, '..');
app.use((req, res, next) => {
  if (!/^\/(?:[a-z0-9-]+\.html|common(?:-enhanced)?\.js|styles\.css)?$/.test(req.path)) {
    return res.sendStatus(404);
  }
  return next();
}, express.static(publicRoot, { dotfiles: 'deny', index: 'index.html' }));

// 统一处理请求体过大错误
app.use((err, req, res, next) => {
  if (err && (err.type === 'entity.too.large' || err.name === 'PayloadTooLargeError')) {
    return res.status(413).json({
      success: false,
      message: '上传内容过大，请压缩图片后重试（建议单张不超过5MB）'
    });
  }
  return next(err);
});

// ============================================================
// 启动服务
// ============================================================
async function startServer() {
  const dbConnected = await initDB();

  if (!dbConnected) {
    console.error('❌ 无法启动服务：数据库连接失败');
    console.log('请检查MySQL服务是否启动，以及环境变量 DB_HOST/DB_PORT/DB_USER/DB_PASSWORD/DB_NAME 是否正确');
    process.exit(1);
  }

  // 加载持久化内容数据（包含之前保存的图片）
  loadContentStore();
  loadWrongNotebookState();
  ensureContentStoreStructure();

  app.listen(PORT, HOST, () => {
    console.log(`✅ 党建平台增强版API服务已启动: http://localhost:${PORT}`);
    console.log(`📋 API文档: http://localhost:${PORT}/api`);
    console.log(`📚 数据库: ${DB_CONFIG.database}`);
  });
}

startServer();