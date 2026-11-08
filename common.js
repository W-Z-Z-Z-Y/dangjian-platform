/* ============================================================
   智慧党建平台 - 增强版共享JavaScript文件
   支持API集成和动态数据
   ============================================================ */

// API配置
const API_CONFIG = {
  baseUrl: '/api',
  getAuthToken: function() {
    return localStorage.getItem('authToken');
  },
  setAuthToken: function(token) {
    localStorage.setItem('authToken', token);
  },
  removeAuthToken: function() {
    localStorage.removeItem('authToken');
  },
  getHeaders: function() {
    const headers = {
      'Content-Type': 'application/json'
    };
    const token = this.getAuthToken();
    if (token) {
      headers['Authorization'] = `Bearer ${token}`;
    }
    return headers;
  }
};

const API_CACHE_PREFIX = 'party_api_cache_v1:';
const API_CACHE_TTL_MS = 30 * 1000;
const API_INFLIGHT = new Map();

function getApiMethod(options) {
  return (options.method || 'GET').toUpperCase();
}

function getApiCacheKey(url) {
  const token = API_CONFIG.getAuthToken() || '';
  return `${API_CACHE_PREFIX}${url}|${token}`;
}

function readApiCache(url) {
  try {
    const key = getApiCacheKey(url);
    const raw = sessionStorage.getItem(key);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    if (Date.now() - (parsed.timestamp || 0) > API_CACHE_TTL_MS) {
      sessionStorage.removeItem(key);
      return null;
    }
    return parsed.data;
  } catch (e) {
    return null;
  }
}

function writeApiCache(url, data) {
  try {
    const key = getApiCacheKey(url);
    sessionStorage.setItem(key, JSON.stringify({ timestamp: Date.now(), data }));
  } catch (e) {
    // 忽略缓存异常
  }
}

function clearApiCache() {
  try {
    const keysToRemove = [];
    for (let i = 0; i < sessionStorage.length; i += 1) {
      const key = sessionStorage.key(i);
      if (key && key.startsWith(API_CACHE_PREFIX)) keysToRemove.push(key);
    }
    keysToRemove.forEach(key => sessionStorage.removeItem(key));
  } catch (e) {
    // 忽略清理异常
  }
}

/* ============================================================
   API请求辅助函数
   ============================================================ */
async function apiRequest(endpoint, options = {}) {
  const url = `${API_CONFIG.baseUrl}${endpoint}`;
  const method = getApiMethod(options);
  const useCache = method === 'GET' && options.noCache !== true;
  const hasCustomTimeout = options.timeoutMs !== undefined && options.timeoutMs !== null;
  const isPublicContentRequest = method === 'GET' && endpoint.startsWith('/content/');
  const timeoutMs = hasCustomTimeout
    ? Number(options.timeoutMs)
    : (isPublicContentRequest ? 0 : (method === 'GET' ? 30000 : 10000));

  if (useCache) {
    const cached = readApiCache(url);
    if (cached) return cached;
  }

  const inflightKey = `${method}:${url}`;
  if (API_INFLIGHT.has(inflightKey)) {
    return API_INFLIGHT.get(inflightKey);
  }

  const defaultOptions = {
    headers: API_CONFIG.getHeaders(),
    ...options
  };

  const hasExternalSignal = !!defaultOptions.signal;
  let timeoutId = null;
  let timeoutController = null;
  if (!hasExternalSignal && timeoutMs > 0 && typeof AbortController !== 'undefined') {
    timeoutController = new AbortController();
    defaultOptions.signal = timeoutController.signal;
  }

  delete defaultOptions.timeoutMs;

  const requestPromise = (async () => {
    try {
    if (timeoutController) {
      timeoutId = setTimeout(() => timeoutController.abort(), timeoutMs);
    }

    const response = await fetch(url, defaultOptions);
    const data = await response.json().catch(() => ({}));

    if (!response.ok) {
      // 认证失败，清除本地存储
      if (response.status === 401) {
        localStorage.removeItem('authToken');
        localStorage.removeItem('userLoggedIn');
        localStorage.removeItem('userName');
        localStorage.removeItem('userRole');
        showToast('❌ 登录已过期，请重新登录');
        setTimeout(() => {
          if (!window.location.href.includes('login.html')) {
            window.location.href = 'login.html';
          }
        }, 1500);
      }

      throw new Error(data.message || `请求失败: ${response.status}`);
    }

    if (useCache) {
      writeApiCache(url, data);
    } else if (method !== 'GET') {
      clearApiCache();
    }

    return data;
    } catch (error) {
    if (!options.silent) {
      console.error('API请求错误:', error);
    }
    const isTimeout = error && (error.name === 'AbortError' || String(error.message || '').includes('aborted'));
    const friendlyMessage = isTimeout ? `请求超时（>${timeoutMs}ms）` : error.message;
    if (!options.silent) {
      showToast(`❌ ${friendlyMessage}`, 'error');
    }
    if (isTimeout) {
      const timeoutErr = new Error(friendlyMessage);
      timeoutErr.name = 'TimeoutError';
      throw timeoutErr;
    }
    throw error;
    } finally {
      if (timeoutId) clearTimeout(timeoutId);
      API_INFLIGHT.delete(inflightKey);
    }
  })();

  API_INFLIGHT.set(inflightKey, requestPromise);
  return requestPromise;
}

/* ============================================================
   用户认证API函数
   ============================================================ */

// 用户登录
async function doLogin() {
  const username = document.getElementById('loginUser').value;
  const password = document.getElementById('loginPass').value;

  if (!username || !password) {
    showToast('❌ 请输入用户名和密码');
    return;
  }

  try {
    const data = await apiRequest('/auth/login', {
      method: 'POST',
      body: JSON.stringify({ username, password })
    });

    if (data.success) {
      const { user, token } = data.data;

      // 保存用户信息和令牌
      API_CONFIG.setAuthToken(token);
      localStorage.setItem('userLoggedIn', 'true');
      localStorage.setItem('userName', user.name);
      localStorage.setItem('userRole', user.role);
      localStorage.setItem('userId', user.id);
      localStorage.setItem('userEmail', user.email || '');
      localStorage.setItem('userPhone', user.phone || '');
      localStorage.setItem('userAvatar', user.avatar || '');

      showToast(`✅ 登录成功！欢迎回来，${user.name}`);
      updateNavigation();

      setTimeout(() => {
        window.location.href = user.role === 'admin' ? 'admin.html' : 'index.html';
      }, 800);
    }
  } catch (error) {
    // 错误已在apiRequest中处理
  }
}

// 用户注册
async function doRegister() {
  const username = document.getElementById('registerUser').value;
  const password = document.getElementById('registerPass').value;
  const confirmPassword = document.getElementById('registerConfirmPass').value;
  const name = document.getElementById('registerName').value;
  const email = document.getElementById('registerEmail').value;
  const phone = document.getElementById('registerPhone').value;

  if (!username || !password || !name) {
    showToast('❌ 用户名、密码和姓名是必填项');
    return;
  }

  if (password !== confirmPassword) {
    showToast('❌ 两次输入的密码不一致');
    return;
  }

  try {
    const data = await apiRequest('/auth/register', {
      method: 'POST',
      body: JSON.stringify({ username, password, name, email, phone })
    });

    if (data.success) {
      const { user, token } = data.data;

      // 保存用户信息和令牌
      API_CONFIG.setAuthToken(token);
      localStorage.setItem('userLoggedIn', 'true');
      localStorage.setItem('userName', user.name);
      localStorage.setItem('userRole', user.role);
      localStorage.setItem('userId', user.id);
      localStorage.setItem('userEmail', user.email || '');
      localStorage.setItem('userPhone', user.phone || '');

      showToast(`✅ 注册成功！欢迎加入，${user.name}`);
      updateNavigation();

      setTimeout(() => {
        window.location.href = 'index.html';
      }, 800);
    }
  } catch (error) {
    // 错误已在apiRequest中处理
  }
}

// 用户注销
function doLogout() {
  if (confirm('确定要退出登录吗？')) {
    API_CONFIG.removeAuthToken();
    localStorage.removeItem('userLoggedIn');
    localStorage.removeItem('userName');
    localStorage.removeItem('userRole');
    localStorage.removeItem('userId');
    localStorage.removeItem('userEmail');
    localStorage.removeItem('userPhone');
    localStorage.removeItem('userAvatar');

    showToast('👋 已成功退出登录');
    updateNavigation();

    setTimeout(() => {
      window.location.href = 'index.html';
    }, 800);
  }
}

// 检查登录状态并获取用户信息
async function checkAuthStatus() {
  const token = API_CONFIG.getAuthToken();
  if (!token) {
    return false;
  }

  try {
    const data = await apiRequest('/auth/me');
    if (data.success) {
      const user = data.data.user;
      // 更新本地存储
      localStorage.setItem('userLoggedIn', 'true');
      localStorage.setItem('userName', user.name);
      localStorage.setItem('userRole', user.role);
      localStorage.setItem('userId', user.id);
      localStorage.setItem('userEmail', user.email || '');
      localStorage.setItem('userPhone', user.phone || '');
      localStorage.setItem('userAvatar', user.avatar || '');
      return true;
    }
  } catch (error) {
    // 认证失败，清除本地存储
    API_CONFIG.removeAuthToken();
    localStorage.removeItem('userLoggedIn');
    localStorage.removeItem('userName');
    localStorage.removeItem('userRole');
    localStorage.removeItem('userId');
    localStorage.removeItem('userEmail');
    localStorage.removeItem('userPhone');
    localStorage.removeItem('userAvatar');
    return false;
  }
}

/* ============================================================
   题目API函数
   ============================================================ */

// 获取所有题目
async function getQuestions() {
  try {
    const data = await apiRequest('/questions');
    return data.success ? data.data : [];
  } catch (error) {
    console.error('获取题目失败:', error);
    return [];
  }
}

// 按题型获取题目
async function getQuestionsByType(type) {
  try {
    const data = await apiRequest(`/questions/type/${type}`);
    return data.success ? data.data : [];
  } catch (error) {
    console.error('获取题目失败:', error);
    return [];
  }
}

// 获取随机题目
async function getRandomQuestions(count = 10) {
  try {
    const data = await apiRequest('/questions');
    if (!data.success) return [];

    const allQuestions = data.data;
    // 随机选择题目
    const shuffled = [...allQuestions].sort(() => Math.random() - 0.5);
    return shuffled.slice(0, count);
  } catch (error) {
    console.error('获取随机题目失败:', error);
    return [];
  }
}

/* ============================================================
   答题记录API函数
   ============================================================ */

// 提交答题记录
async function submitQuizRecord(record) {
  try {
    const data = await apiRequest('/quiz/records', {
      method: 'POST',
      body: JSON.stringify(record)
    });
    return data.success;
  } catch (error) {
    console.error('提交答题记录失败:', error);
    return false;
  }
}

// 获取用户的答题记录
async function getUserQuizRecords(limit = 20, offset = 0) {
  try {
    const data = await apiRequest(`/quiz/records?limit=${limit}&offset=${offset}`);
    return data.success ? data.data : { records: [], pagination: { total: 0 }, stats: {} };
  } catch (error) {
    console.error('获取答题记录失败:', error);
    return { records: [], pagination: { total: 0 }, stats: {} };
  }
}

// 获取答题排行榜
async function getQuizLeaderboard(limit = 10, period = 'all') {
  try {
    const data = await apiRequest(`/quiz/leaderboard?limit=${limit}&period=${period}`);
    return data.success ? data.data : [];
  } catch (error) {
    console.error('获取排行榜失败:', error);
    return [];
  }
}

/* ============================================================
   收藏功能API函数
   ============================================================ */

// 添加收藏
async function addFavorite(questionId) {
  try {
    const data = await apiRequest('/favorites', {
      method: 'POST',
      body: JSON.stringify({ question_id: questionId })
    });
    return data.success;
  } catch (error) {
    console.error('添加收藏失败:', error);
    return false;
  }
}

// 删除收藏
async function removeFavorite(questionId) {
  try {
    const data = await apiRequest(`/favorites/${questionId}`, {
      method: 'DELETE'
    });
    return data.success;
  } catch (error) {
    console.error('删除收藏失败:', error);
    return false;
  }
}

// 获取用户的收藏列表
async function getUserFavorites(limit = 20, offset = 0) {
  try {
    const data = await apiRequest(`/favorites?limit=${limit}&offset=${offset}`);
    return data.success ? data.data : { favorites: [], total: 0 };
  } catch (error) {
    console.error('获取收藏列表失败:', error);
    return { favorites: [], total: 0 };
  }
}

/* ============================================================
   动态内容API函数
   ============================================================ */

const CONTENT_CACHE_PREFIX = 'party_content_cache_v1:';

function hasUsableContent(data) {
  if (Array.isArray(data)) return data.length > 0;
  if (data && typeof data === 'object') return Object.keys(data).length > 0;
  return !!data;
}

function getContentCache(cacheKey, maxAgeMs) {
  try {
    const raw = localStorage.getItem(CONTENT_CACHE_PREFIX + cacheKey);
    if (!raw) return { hit: false, data: null };
    const parsed = JSON.parse(raw);
    const age = Date.now() - (parsed.timestamp || 0);
    return {
      hit: true,
      fresh: age <= maxAgeMs,
      data: parsed.data
    };
  } catch (e) {
    return { hit: false, data: null };
  }
}

function setContentCache(cacheKey, data) {
  try {
    localStorage.setItem(CONTENT_CACHE_PREFIX + cacheKey, JSON.stringify({
      timestamp: Date.now(),
      data
    }));
  } catch (e) {
    // 忽略缓存写入失败（如隐私模式或存储满）
  }
}

function removeContentCache(cacheKey) {
  try {
    localStorage.removeItem(CONTENT_CACHE_PREFIX + cacheKey);
  } catch (e) {
    // 忽略缓存删除失败
  }
}

function refreshContentCache(endpoint, cacheKey) {
  apiRequest(endpoint)
    .then(resp => {
      if (resp.success) setContentCache(cacheKey, resp.data);
    })
    .catch(() => {});
}

// 获取轮播数据
async function getSlides() {
  const cacheKey = 'slides';
  const cache = getContentCache(cacheKey, 2 * 60 * 1000);
  if (cache.hit && cache.fresh) {
    refreshContentCache('/content/slides', cacheKey);
    return cache.data || [];
  }

  try {
    const data = await apiRequest('/content/slides');
    if (data.success) setContentCache(cacheKey, data.data);
    return data.success ? data.data : [];
  } catch (error) {
    console.error('获取轮播数据失败:', error);
    if (cache.hit && cache.data) return cache.data;
    return [];
  }
}

// 获取新闻列表
async function getNewsList(limit, options = {}) {
  const summaryMode = options.summary === true;
  const cacheKey = `news:${limit || 'all'}:${summaryMode ? 'summary' : 'full'}`;
  const params = new URLSearchParams();
  if (limit) params.set('limit', limit);
  if (summaryMode) params.set('summary', '1');
  const query = params.toString() ? `?${params}` : '';
  const endpoint = `/content/news${query}`;
  const cache = getContentCache(cacheKey, 60 * 1000);
  const forceRefresh = options.forceRefresh === true;
  if (!forceRefresh && cache.hit && cache.fresh && hasUsableContent(cache.data)) {
    refreshContentCache(endpoint, cacheKey);
    return cache.data || [];
  }

  try {
    const data = await apiRequest(endpoint, forceRefresh ? { noCache: true } : {});
    if (data.success) setContentCache(cacheKey, data.data);
    return data.success ? data.data : [];
  } catch (error) {
    console.error('获取新闻失败:', error);
    if (cache.hit && hasUsableContent(cache.data)) return cache.data;
    return [];
  }
}

// 获取活动列表
async function getActivities(status, limit, options = {}) {
  const params = new URLSearchParams();
  const summaryMode = options.summary === true;
  if (status) params.set('status', status);
  if (limit) params.set('limit', limit);
  if (summaryMode) params.set('summary', '1');
  const query = params.toString() ? `?${params}` : '';
  const endpoint = `/content/activities${query}`;
  const cacheKey = `activities:${status || 'all'}:${limit || 'all'}:${summaryMode ? 'summary' : 'full'}`;
  const cache = getContentCache(cacheKey, 60 * 1000);
  if (cache.hit && cache.fresh) {
    refreshContentCache(endpoint, cacheKey);
    return cache.data || [];
  }

  try {
    const data = await apiRequest(endpoint);
    if (data.success) setContentCache(cacheKey, data.data);
    return data.success ? data.data : [];
  } catch (error) {
    console.error('获取活动失败:', error);
    if (cache.hit && cache.data) return cache.data;
    return [];
  }
}

async function getActivityDetail(id) {
  const activityId = parseInt(id, 10);
  if (!activityId) return null;
  const activities = await getActivities();
  return activities.find(item => item.id === activityId) || null;
}

// 获取站点统计
async function getSiteStats() {
  const cacheKey = 'site-stats';
  const cache = getContentCache(cacheKey, 2 * 60 * 1000);
  if (cache.hit && cache.fresh) {
    refreshContentCache('/content/site-stats', cacheKey);
    return cache.data || null;
  }

  try {
    const data = await apiRequest('/content/site-stats');
    if (data.success) setContentCache(cacheKey, data.data);
    return data.success ? data.data : null;
  } catch (error) {
    console.error('获取站点统计失败:', error);
    if (cache.hit && cache.data) return cache.data;
    return null;
  }
}

// 获取党建内容
async function getPartyContent(category, options = {}) {
  const cacheKey = `party:${category || 'all'}`;
  const endpoint = `/content/party/${category}`;
  const cache = getContentCache(cacheKey, 2 * 60 * 1000);
  const forceRefresh = options.forceRefresh === true;
  const allowFreshCache = !forceRefresh && cache.hit && cache.fresh && hasUsableContent(cache.data);
  if (allowFreshCache) {
    refreshContentCache(endpoint, cacheKey);
    return cache.data || [];
  }

  try {
    const data = await apiRequest(endpoint, forceRefresh ? { noCache: true } : {});
    if (data.success) setContentCache(cacheKey, data.data);
    return data.success ? data.data : [];
  } catch (error) {
    console.error('获取党建内容失败:', error);
    if (cache.hit && hasUsableContent(cache.data)) return cache.data;
    throw error;
  }
}

// 获取社团风采内容
async function getShowcaseContent(category) {
  const cacheKey = `showcase:${category || 'all'}`;
  const endpoint = `/content/showcase/${category}`;
  const cache = getContentCache(cacheKey, 2 * 60 * 1000);
  if (cache.hit && cache.fresh) {
    refreshContentCache(endpoint, cacheKey);
    return cache.data || (category === 'intro' ? {} : []);
  }

  try {
    const data = await apiRequest(endpoint);
    if (data.success) setContentCache(cacheKey, data.data);
    if (data.success) return data.data;
    return category === 'intro' ? {} : [];
  } catch (error) {
    console.error('获取社团风采内容失败:', error);
    if (cache.hit && cache.data) return cache.data;
    return category === 'intro' ? {} : [];
  }
}

// 获取首页聚合数据（首访优化）
async function getHomeContent(newsLimit = 5, activityLimit = 3) {
  const cacheKey = `home:${newsLimit}:${activityLimit}`;
  const cache = getContentCache(cacheKey, 90 * 1000);
  const hasUsableHomeCache = cache.hit && cache.fresh && cache.data && (
    hasUsableContent(cache.data.news) ||
    hasUsableContent(cache.data.slides) ||
    hasUsableContent(cache.data.activities) ||
    hasUsableContent(cache.data.stats)
  );
  if (hasUsableHomeCache) {
    refreshContentCache(`/content/home?newsLimit=${newsLimit}&activityLimit=${activityLimit}`, cacheKey);
    return cache.data || { slides: [], news: [], stats: null, activities: [] };
  }

  try {
    const data = await apiRequest(`/content/home?newsLimit=${newsLimit}&activityLimit=${activityLimit}`, {
      silent: true
    });

    const payload = data && typeof data === 'object'
      ? (data.data && typeof data.data === 'object' ? data.data : data)
      : null;

    if (!payload || (!Array.isArray(payload.slides) && !Array.isArray(payload.news) && !Array.isArray(payload.activities) && !payload.stats)) {
      throw new Error('首页聚合接口返回异常');
    }

    const result = {
      slides: Array.isArray(payload.slides) ? payload.slides : [],
      news: Array.isArray(payload.news) ? payload.news : [],
      stats: payload.stats || null,
      activities: Array.isArray(payload.activities) ? payload.activities : []
    };
    setContentCache(cacheKey, result);
    return result;
  } catch (error) {
    if (error?.name !== 'TimeoutError') {
      console.warn('获取首页聚合数据失败，已切换降级接口:', error);
    }

    if (cache.hit && cache.data) {
      return cache.data;
    }

    // 降级：并行拉取基础接口，避免首页整块空白
    try {
      const [slides, news, stats, activities] = await Promise.all([
        getSlides(),
        getNewsList(newsLimit, { summary: true }),
        getSiteStats(),
        getActivities(undefined, activityLimit, { summary: true })
      ]);

      const fallbackResult = {
        slides: Array.isArray(slides) ? slides : [],
        news: Array.isArray(news) ? news : [],
        stats: stats || null,
        activities: Array.isArray(activities) ? activities : []
      };
      setContentCache(cacheKey, fallbackResult);
      return fallbackResult;
    } catch (fallbackError) {
      console.warn('首页降级接口也失败:', fallbackError);
      return { slides: [], news: [], stats: null, activities: [] };
    }
  }
}

/* ============================================================
   动态渲染辅助函数
   ============================================================ */

// 渲染轮播
function renderSlides(slides, containerId) {
  const container = document.getElementById(containerId);
  if (!container || !slides.length) return;
  container.innerHTML = slides.map(s => {
    const bgImage = s.bgImage || s.image;
    const bgStyle = bgImage
      ? `background-image:url('${bgImage}');`
      : `background:${s.bg || 'linear-gradient(135deg,#4a0000,#c90000,#165DFF)'};`;
    return `
    <div class="hero-slide">
      <div class="slide-bg" style="${bgStyle}"></div>
      <div class="slide-overlay"></div>
      <div class="slide-content">
        <div class="slide-tag">${s.tag || ''}</div>
        <div class="slide-title">${s.title || ''}</div>
        <div class="slide-desc">${s.desc || ''}</div>
        <a href="${s.link || 'party-detail.html'}" class="btn btn-outline" style="color:#fff;border-color:rgba(255,255,255,0.5);">${s.linkText || '查看详情 →'}</a>
      </div>
    </div>
  `;
  }).join('');
  // 更新 dots
  const dotsContainer = document.querySelector('.hero-dots');
  if (dotsContainer) {
    dotsContainer.innerHTML = slides.map((_, i) =>
      `<div class="hero-dot${i === 0 ? ' active' : ''}" onclick="goSlide(${i})"></div>`
    ).join('');
  }
  slideCount = slides.length;
  slideIdx = 0;
  updateSlider();
}

// 渲染新闻列表
function renderNewsList(news, containerId) {
  const container = document.getElementById(containerId);
  if (!container || !news.length) return;
  container.innerHTML = news.map(n => `
    <a href="${n.id ? `party-detail.html?category=news&id=${encodeURIComponent(n.id)}` : (n.link || 'party-detail.html')}" class="news-item">
      <div class="news-item-thumb" style="${n.image ? `background-image:url('${n.image}');background-size:cover;background-position:center;` : `background:${n.bg || 'linear-gradient(135deg,#4a0000,#c90000)'};`}">${n.image ? '' : (n.icon || '📰')}</div>
      <div class="news-item-body">
        <div class="news-item-title">${n.title}</div>
        <div class="news-item-meta"><span class="tag tag-${n.tagColor}">${n.tag}</span><span>${n.date}</span></div>
      </div>
    </a>
  `).join('');
}

// 渲染统计数据
function renderSiteStats(stats, containerId) {
  const container = document.getElementById(containerId);
  if (!container || !stats) return;
  container.innerHTML = `
    <div class="stat-card"><div class="stat-number">${stats.partyBranches}<span class="stat-unit">个</span></div><div class="stat-label">党支部</div></div>
    <div class="stat-card"><div class="stat-number">${stats.partyMembers}<span class="stat-unit">名</span></div><div class="stat-label">党员同志</div></div>
    <div class="stat-card"><div class="stat-number">${stats.totalActivities}<span class="stat-unit">场</span></div><div class="stat-label">党建活动</div></div>
    <div class="stat-card"><div class="stat-number">${stats.participationRate}<span class="stat-unit">%</span></div><div class="stat-label">党课参与率</div></div>
  `;
}

// 渲染活动卡片
function renderActivityCards(activities, containerId, maxCount) {
  const container = document.getElementById(containerId);
  if (!container) return;
  const items = maxCount ? activities.slice(0, maxCount) : activities;
  if (!items.length) {
    container.innerHTML = '<div class="alert alert-info">暂无活动数据</div>';
    return;
  }
  container.innerHTML = items.map(a => {
    const enrolled = a.status === '已结束' ? `参与 ${a.enrolled} 人` : `已报名 ${a.enrolled}/${a.capacity}`;
    const coverStyle = a.image
      ? `background-image:url('${a.image}');background-size:cover;background-position:center;`
      : `background:${a.bg || 'linear-gradient(135deg,#4a0000,#c90000)'};`;
    return `
    <a href="activity-detail.html?id=${a.id}" class="card act-card">
      <div class="act-card-img" style="${coverStyle}">${a.image ? '' : (a.icon || '📅')}</div>
      <div class="act-card-body">
        <div style="margin-bottom:8px;display:flex;gap:6px;flex-wrap:wrap;">
          <span class="badge badge-${a.tagColor}">${a.tag}</span>
          <span class="badge badge-${a.statusColor}">${a.status}</span>
        </div>
        <div class="act-card-title">${a.title}</div>
        <div class="act-card-meta"><span>📅 ${a.date}</span><span>📍 ${a.location}</span></div>
        <div class="act-card-meta" style="margin-top:6px;"><span>👥 ${enrolled}</span></div>
        <span class="btn btn-${a.btnColor} btn-sm" style="margin-top:14px;display:inline-block;">${a.btnText}</span>
      </div>
    </a>
  `}).join('');
}

// 渲染党建新闻卡片
function renderPartyNewsCards(items, containerId) {
  const container = document.getElementById(containerId);
  if (!container) return;
  if (!items.length) { container.innerHTML = '<div class="alert alert-info">暂无内容</div>'; return; }
  container.innerHTML = `<div class="grid-3">${items.map(n => `
    <a href="party-detail.html?category=news&id=${encodeURIComponent(n.id)}" class="card act-card">
      <div class="act-card-img" style="${n.image ? `background-image:url('${n.image}');background-size:cover;background-position:center;` : `background:${n.bg || 'linear-gradient(135deg,#4a0000,#c90000)'};`}">${n.image ? '' : (n.icon || '🚩')}</div>
      <div class="act-card-body">
        <div class="act-card-title">${n.title}</div>
        <div class="act-card-meta"><span class="badge badge-${n.tagColor}">${n.tag}</span><span>${n.date || n.sub || ''}</span></div>
      </div>
    </a>
  `).join('')}</div>`;
}

// 渲染政策文件表格
function renderPolicyTable(items, containerId, category = 'policy') {
  const container = document.getElementById(containerId);
  if (!container) return;
  if (!items.length) { container.innerHTML = '<div class="alert alert-info">暂无内容</div>'; return; }
  container.innerHTML = `
    <div class="card" style="padding:0;">
      <div class="table-wrap">
        <table>
          <thead><tr><th>文件名称</th><th>类型</th><th>发布日期</th><th>操作</th></tr></thead>
          <tbody>
            ${items.map(p => `
              <tr>
                <td><a href="party-detail.html?category=${encodeURIComponent(category)}&id=${encodeURIComponent(p.id)}" style="color:var(--blue);">${p.title}</a></td>
                <td><span class="badge badge-${p.tagColor}">${p.tag}</span></td>
                <td>${p.date}</td>
                <td><button class="action-btn act-edit" onclick="showToast('开始下载...')">下载</button></td>
              </tr>
            `).join('')}
          </tbody>
        </table>
      </div>
    </div>
  `;
}

/* ============================================================
   原common.js功能（保持兼容）
   ============================================================ */

/* Toast */
function showToast(msg, type = 'success') {
  const toast = document.getElementById('toast');
  if (!toast) return;
  toast.textContent = msg;
  toast.className = 'toast-' + type;
  toast.style.display = 'block';
  setTimeout(() => { toast.style.display = 'none'; }, 3000);
}

/* Navigation */
function updateNavigation() {
  const loggedIn = localStorage.getItem('userLoggedIn') === 'true';
  const userName = localStorage.getItem('userName');
  const userRole = localStorage.getItem('userRole');
  const navRight = document.getElementById('navRight');

  if (navRight) {
    const loginBtn = navRight.querySelector('.nav-btn-login');
    const adminBtn = navRight.querySelector('.nav-btn-admin');
    const logoutBtn = navRight.querySelector('.nav-btn-logout');

    if (loggedIn) {
      // 用户已登录
      if (loginBtn) {
        loginBtn.textContent = '👤 ' + userName;
        loginBtn.onclick = () => window.location.href = 'profile.html';
      }

      if (adminBtn) {
        adminBtn.style.display = (userRole === 'admin') ? 'inline-flex' : 'none';
      }

      // 添加注销按钮（如果不存在）
      if (!logoutBtn && navRight.querySelector('.nav-btn-logout') === null) {
        const logoutBtn = document.createElement('button');
        logoutBtn.className = 'nav-btn nav-btn-logout btn-outline';
        logoutBtn.textContent = '退出登录';
        logoutBtn.onclick = doLogout;
        navRight.appendChild(logoutBtn);
      }
    } else {
      // 用户未登录
      if (loginBtn) {
        loginBtn.textContent = '👤 登录';
        loginBtn.onclick = () => window.location.href = 'login.html';
      }

      if (adminBtn) {
        adminBtn.style.display = 'none';
      }

      // 移除注销按钮
      if (logoutBtn) {
        logoutBtn.remove();
      }
    }
  }

  renderMobileBottomNav();
}

/* Theme */
function toggleTheme() {
  const body = document.body;
  const themeToggle = document.getElementById('themeToggle');

  body.classList.toggle('dark-theme');
  const isDark = body.classList.contains('dark-theme');

  if (themeToggle) {
    themeToggle.textContent = isDark ? '☀️ 浅色' : '🌙 深色';
  }

  localStorage.setItem('theme', isDark ? 'dark' : 'light');
  showToast(isDark ? '🌙 已切换到深色主题' : '☀️ 已切换到浅色主题');
}

function initTheme() {
  const savedTheme = localStorage.getItem('theme');
  if (savedTheme === 'dark') {
    document.body.classList.add('dark-theme');
    const themeToggle = document.getElementById('themeToggle');
    if (themeToggle) themeToggle.textContent = '☀️ 浅色';
  }
}

/* Navbar scroll effects */
function initNavbarEffects() {
  const navbar = document.getElementById('topnav');
  if (!navbar) return;

  window.addEventListener('scroll', function() {
    if (window.scrollY > 50) {
      navbar.classList.add('scrolled');
    } else {
      navbar.classList.remove('scrolled');
    }
  });
}

/* Mobile nav */
function toggleMobileNav() {
  const nav = document.getElementById('mobileNav');
  if (nav) nav.classList.toggle('open');
}

function getCurrentPageName() {
  const path = window.location.pathname || '';
  const file = path.split('/').pop();
  return file || 'index.html';
}

function mapPageToMobileNavKey(pageName) {
  if (pageName === 'index.html') return 'index';
  if (pageName === 'party.html' || pageName === 'party-detail.html') return 'party';
  if (pageName === 'showcase.html' || pageName === 'showcase-detail.html') return 'showcase';
  if (pageName === 'activities.html' || pageName === 'activity-detail.html' || pageName === 'message.html') return 'activities';
  if (pageName === 'study.html' || pageName === 'quiz.html' || pageName === 'chat.html') return 'study';
  if (pageName === 'admin.html') return 'admin';
  if (pageName === 'profile.html') return 'profile';
  if (pageName === 'login.html') return 'login';
  return '';
}

function getMobileNavItems() {
  const loggedIn = localStorage.getItem('userLoggedIn') === 'true';
  const userRole = localStorage.getItem('userRole');

  const items = [
    { key: 'index', href: 'index.html', icon: '🏠', label: '首页' },
    { key: 'party', href: 'party.html', icon: '🚩', label: '党建' },
    { key: 'showcase', href: 'showcase.html', icon: '🌟', label: '风采' },
    { key: 'activities', href: 'activities.html', icon: '📅', label: '活动' },
    { key: 'study', href: 'study.html', icon: '📚', label: '学习' }
  ];

  if (userRole === 'admin') {
    items.push({ key: 'admin', href: 'admin.html', icon: '⚙️', label: '后台' });
  } else if (loggedIn) {
    items.push({ key: 'profile', href: 'profile.html', icon: '👤', label: '我的' });
  } else {
    items.push({ key: 'login', href: 'login.html', icon: '🔐', label: '登录' });
  }

  return items;
}

function shouldShowMobileBottomNav(pageName) {
  return false;
}

function renderMobileBottomNav() {
  const pageName = getCurrentPageName();
  const body = document.body;
  if (!body) return;

  const existing = document.getElementById('mobileBottomNav');
  if (!shouldShowMobileBottomNav(pageName)) {
    if (existing) existing.remove();
    body.classList.remove('has-mobile-bottom-nav');
    return;
  }

  const activeKey = mapPageToMobileNavKey(pageName);
  const items = getMobileNavItems();

  let nav = existing;
  if (!nav) {
    nav = document.createElement('nav');
    nav.id = 'mobileBottomNav';
    nav.className = 'mobile-bottom-nav';
    document.body.appendChild(nav);
  }

  nav.innerHTML = items.map(item => {
    const activeClass = item.key === activeKey ? ' active' : '';
    return `<a class="mobile-bottom-nav-item${activeClass}" href="${item.href}"><span class="icon">${item.icon}</span><span class="label">${item.label}</span></a>`;
  }).join('');

  body.classList.add('has-mobile-bottom-nav');
}

/* Font size */
function changeFontSize(action) {
  const root = document.documentElement;
  let currentSize = parseInt(localStorage.getItem('fontSize') || 16);

  switch (action) {
    case 'increase': currentSize = Math.min(currentSize + 2, 24); break;
    case 'decrease': currentSize = Math.max(currentSize - 2, 12); break;
    case 'reset': currentSize = 16; break;
  }

  root.style.setProperty('--font-size-base', currentSize + 'px');
  root.style.setProperty('--font-size-sm', (currentSize - 2) + 'px');
  root.style.setProperty('--font-size-lg', (currentSize + 2) + 'px');
  root.style.setProperty('--font-size-xl', (currentSize + 4) + 'px');
  root.style.setProperty('--font-size-2xl', (currentSize + 8) + 'px');

  localStorage.setItem('fontSize', currentSize);

  const currentFontSizeEl = document.getElementById('currentFontSize');
  if (currentFontSizeEl) currentFontSizeEl.textContent = currentSize;

  showToast(`字体大小已${action === 'increase' ? '增大' : action === 'decrease' ? '减小' : '重置'}`);
}

function initFontSize() {
  const savedSize = parseInt(localStorage.getItem('fontSize') || 16);
  const root = document.documentElement;
  root.style.setProperty('--font-size-base', savedSize + 'px');
  root.style.setProperty('--font-size-sm', (savedSize - 2) + 'px');
  root.style.setProperty('--font-size-lg', (savedSize + 2) + 'px');
  root.style.setProperty('--font-size-xl', (savedSize + 4) + 'px');
  root.style.setProperty('--font-size-2xl', (savedSize + 8) + 'px');
}

/* Search */
async function performSearch() {
  const searchInput = document.getElementById('searchInput');
  const searchTerm = searchInput ? searchInput.value.trim() : '';

  if (!searchTerm) {
    showToast('请输入搜索关键词');
    return;
  }

  // 暂时使用本地数据，后续可改为API搜索
  const searchData = [
    { title: '关于深入开展主题教育学习活动的通知', category: '通知', date: '2024-12-10' },
    { title: '人工智能协会2024年度党员发展大会圆满召开', category: '要闻', date: '2024-12-15' },
    { title: '社团党支部荣获"优秀党支部"称号', category: '荣誉', date: '2024-12-05' },
    { title: '第四季度预备党员宣誓仪式隆重举行', category: '活动', date: '2024-11-28' },
    { title: 'AI赋能党建：智慧党建平台建设工作汇报', category: 'AI党建', date: '2024-11-20' }
  ];

  const results = searchData.filter(item => {
    return item.title.toLowerCase().includes(searchTerm.toLowerCase()) ||
           item.category.toLowerCase().includes(searchTerm.toLowerCase());
  });

  showSearchResults(results, searchTerm);
}

function showSearchResults(results, searchTerm) {
  const modalContent = `
    <div class="search-results-modal">
      <div class="search-results-header">
        <h3>搜索结果："${searchTerm}"</h3>
        <button class="modal-close" onclick="closeSearchResults()">×</button>
      </div>
      <div class="search-results-body">
        ${results.length > 0 ?
          results.map(item => `
            <div class="search-result-item">
              <div class="search-result-title">${item.title}</div>
              <div class="search-result-meta">
                <span class="tag tag-blue">${item.category}</span>
                <span>${item.date}</span>
              </div>
            </div>
          `).join('') :
          '<div class="alert alert-info">未找到相关内容</div>'
        }
      </div>
    </div>
  `;

  const modalOverlay = document.createElement('div');
  modalOverlay.className = 'modal-overlay open';
  modalOverlay.id = 'searchResultsModal';

  const modal = document.createElement('div');
  modal.className = 'modal';
  modal.innerHTML = modalContent;

  modalOverlay.appendChild(modal);
  document.body.appendChild(modalOverlay);

  modalOverlay.onclick = function(e) {
    if (e.target === modalOverlay) closeSearchResults();
  };
}

function closeSearchResults() {
  const modal = document.getElementById('searchResultsModal');
  if (modal) modal.remove();
}

/* Modal helpers */
function closeModal(modalId) {
  const modal = document.getElementById(modalId);
  if (modal) modal.classList.remove('open');
}

/* Party tabs */
function switchPartyTab(tab, el) {
  document.querySelectorAll('[id^="ptab-"]').forEach(t => t.style.display = 'none');
  const tabEl = document.getElementById('ptab-' + tab);
  if (tabEl) tabEl.style.display = '';
  document.querySelectorAll('#partyNavInner .party-nav-item').forEach(i => i.classList.remove('active'));
  if (el) el.classList.add('active');
}

/* Showcase tabs */
function switchShowcaseTab(tab, el) {
  document.querySelectorAll('[id^="stab-"]').forEach(t => t.style.display = 'none');
  const tabEl = document.getElementById('stab-' + tab);
  if (tabEl) tabEl.style.display = '';
  document.querySelectorAll('#showcaseNavInner .party-nav-item').forEach(i => i.classList.remove('active'));
  if (el) el.classList.add('active');
}

/* Study tabs */
function switchStudyTab(tab, el) {
  document.querySelectorAll('[id^="utab-"]').forEach(t => t.style.display = 'none');
  const tabEl = document.getElementById('utab-' + tab);
  if (tabEl) tabEl.style.display = '';
  document.querySelectorAll('#studyNavInner .party-nav-item').forEach(i => {
    i.classList.remove('active');
    i.style.color = '';
    i.style.borderBottomColor = '';
  });
  if (el) {
    el.classList.add('active');
    el.style.color = 'var(--blue)';
    el.style.borderBottomColor = 'var(--blue)';
  }
}

/* Profile tabs */
function switchProfileTab(tab, el) {
  ['signup', 'study', 'collect', 'achievement', 'download', 'settings'].forEach(t => {
    const tabEl = document.getElementById('ptab-' + t);
    if (tabEl) tabEl.style.display = 'none';
  });
  const tabEl = document.getElementById('ptab-' + tab);
  if (tabEl) tabEl.style.display = '';
  document.querySelectorAll('.profile-tab').forEach(i => i.classList.remove('active'));
  if (el) el.classList.add('active');
}

/* Admin tabs */
function switchAdminPage(page, el) {
  document.querySelectorAll('.admin-page').forEach(p => p.classList.remove('active'));
  const pageEl = document.getElementById('admin-' + page);
  if (pageEl) pageEl.classList.add('active');
  document.querySelectorAll('.admin-nav-item').forEach(i => i.classList.remove('active'));
  if (el) el.classList.add('active');
}

/* Hero slider */
let slideIdx = 0;
let slideCount = 3;

function slideHero(dir) {
  slideIdx = (slideIdx + dir + slideCount) % slideCount;
  updateSlider();
}

function goSlide(i) { slideIdx = i; updateSlider(); }

function updateSlider() {
  const slides = document.getElementById('heroSlides');
  if (slides) slides.style.transform = `translateX(-${slideIdx * 100}%)`;
  document.querySelectorAll('.hero-dot').forEach((d, i) => d.classList.toggle('active', i === slideIdx));
}

/* 访客登录（兼容原有功能） */
function doGuestLogin() {
  let guestName = localStorage.getItem('guestName');
  if (!guestName) {
    guestName = '访客' + String(Math.floor(1000 + Math.random() * 9000));
    localStorage.setItem('guestName', guestName);
  }

  localStorage.setItem('userLoggedIn', 'true');
  localStorage.setItem('userName', guestName);
  localStorage.setItem('userRole', 'guest');

  showToast('👤 ' + guestName + ' 登录成功！您可以浏览公开内容');
  setTimeout(() => { window.location.href = 'index.html'; }, 500);
}

/* 工具函数 */
function isLoggedIn() { return localStorage.getItem('userLoggedIn') === 'true'; }
function getUserRole() { return localStorage.getItem('userRole') || 'guest'; }
function isAdmin() { return getUserRole() === 'admin'; }
function isGuest() { return getUserRole() === 'guest'; }

/* Page loader */
function hidePageLoader() {
  const loader = document.getElementById('pageLoader');
  if (loader) {
    loader.classList.add('hidden');
    setTimeout(() => loader.remove(), 120);
  }
}

/* 页面预取与性能统计 */
function initPagePrefetch() {
  const prefetched = new Set();
  const routeDataPrefetched = new Set();
  const currentPage = (window.location.pathname.split('/').pop() || 'index.html').toLowerCase();
  const isHomePage = currentPage === 'index.html';

  const routeApiWarmups = {
    'index.html': ['/content/home?newsLimit=5&activityLimit=3'],
    'party.html': ['/content/party/news', '/content/party/policy', '/content/party/history', '/content/party/culture', '/content/party/tech'],
    'showcase.html': ['/content/showcase/intro', '/content/showcase/activities', '/content/showcase/members', '/content/showcase/honors'],
    'activities.html': ['/content/activities?limit=6'],
    'study.html': ['/statistics', '/questions?limit=10'],
    'quiz.html': ['/questions?limit=10'],
    'chat.html': ['/chat/health'],
    'profile.html': ['/statistics']
  };

  const globalApiWarmups = isHomePage ? [] : [
    '/content/site-stats',
    '/content/activities?limit=3',
    '/content/news?limit=5'
  ];

  function isInternalHtmlLink(href) {
    if (!href) return false;
    if (href.startsWith('http://') || href.startsWith('https://')) {
      return href.startsWith(window.location.origin) && href.includes('.html');
    }
    return href.endsWith('.html') || href.includes('.html?');
  }

  function prefetchUrl(href) {
    if (!isInternalHtmlLink(href)) return;
    const absUrl = new URL(href, window.location.href).toString();
    if (prefetched.has(absUrl)) return;
    prefetched.add(absUrl);

    fetch(absUrl, {
      method: 'GET',
      credentials: 'same-origin',
      cache: 'force-cache'
    }).catch(() => {});
  }

  function prefetchRouteData(href) {
    if (isHomePage) return;

    try {
      const absUrl = new URL(href, window.location.href);
      const file = absUrl.pathname.split('/').pop() || 'index.html';
      const endpoints = routeApiWarmups[file] || [];
      if (!endpoints.length) return;

      const key = `${file}:${endpoints.join('|')}`;
      if (routeDataPrefetched.has(key)) return;
      routeDataPrefetched.add(key);

      endpoints.forEach(ep => {
        apiRequest(ep, { silent: true, noRedirectOn401: true }).catch(() => {});
      });
    } catch (e) {
      // 忽略预取异常
    }
  }

  document.addEventListener('mouseover', function(e) {
    const link = e.target.closest('a[href]');
    if (!link) return;
    const href = link.getAttribute('href');
    prefetchUrl(href);
    prefetchRouteData(href);
  }, { passive: true });

  document.addEventListener('touchstart', function(e) {
    const link = e.target.closest('a[href]');
    if (!link) return;
    const href = link.getAttribute('href');
    prefetchUrl(href);
    prefetchRouteData(href);
  }, { passive: true });

  const links = Array.from(document.querySelectorAll('a[href]'))
    .map(a => a.getAttribute('href'))
    .filter(href => isInternalHtmlLink(href))
    .slice(0, 8);

  const prefetchDelayMs = currentPage === 'index.html' ? 3200 : 600;

  const warm = () => links.forEach(href => {
    prefetchUrl(href);
    prefetchRouteData(href);
  });

  const warmGlobalApis = () => {
    globalApiWarmups.forEach(ep => {
      apiRequest(ep, { silent: true, noRedirectOn401: true }).catch(() => {});
    });
  };

  if ('requestIdleCallback' in window) {
    requestIdleCallback(() => {
      warm();
      warmGlobalApis();
    }, { timeout: currentPage === 'index.html' ? 4200 : 1200 });
  } else {
    setTimeout(() => {
      warm();
      warmGlobalApis();
    }, prefetchDelayMs);
  }
}

function initPagePerfMetrics() {
  function markNavStart() {
    sessionStorage.setItem('navStartTs', String(Date.now()));
  }

  document.addEventListener('click', function(e) {
    const link = e.target.closest('a[href]');
    if (!link) return;
    const href = link.getAttribute('href') || '';
    if (href.includes('.html')) markNavStart();
  }, true);

  const nav = performance.getEntriesByType('navigation')[0];
  if (nav) {
    const firstScreenMs = Math.round(nav.domContentLoadedEventEnd - nav.startTime);
    const fullLoadMs = Math.round((nav.loadEventEnd || performance.now()) - nav.startTime);
    const ttfbMs = Math.round(nav.responseStart - nav.requestStart);

    const navStartTs = Number(sessionStorage.getItem('navStartTs') || 0);
    const switchLoadMs = navStartTs ? (Date.now() - navStartTs) : null;

    console.log('[PERF] 首屏DOM(ms):', firstScreenMs, '| 全加载(ms):', fullLoadMs, '| TTFB(ms):', ttfbMs,
      switchLoadMs ? `| 切页到可用(ms): ${switchLoadMs}` : '');
  }
}

/* 初始化 */
document.addEventListener('DOMContentLoaded', async function() {
  initTheme();
  initFontSize();
  initNavbarEffects();

  // 先渲染，再异步校验认证，减少首屏阻塞
  updateNavigation();
  hidePageLoader();
  initPagePrefetch();
  initPagePerfMetrics();

  checkAuthStatus()
    .then(() => updateNavigation())
    .catch(() => {});

  const searchInput = document.getElementById('searchInput');
  if (searchInput) {
    searchInput.addEventListener('keypress', function(e) {
      if (e.key === 'Enter') performSearch();
    });
  }

  window.addEventListener('resize', renderMobileBottomNav);
});