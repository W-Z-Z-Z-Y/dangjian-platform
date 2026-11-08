# 党建学习平台

原生 HTML/CSS/JavaScript + Node.js/Express + MySQL 的独立项目。保留学习题库、注册登录、答题记录、错题本、收藏、内容管理、留言审核和可选 DeepSeek 问答。

源码不包含真实 API Key、数据库密码、历史用户或运行数据。页面中的新闻、活动和统计为演示内容，使用时可通过后台替换。

## 环境要求

- Node.js 22 或更高版本。
- 已启动的 MySQL 8.0 或更高版本。
- 浏览器通过本项目 HTTP 服务访问页面；不能直接双击 HTML，也不能仅部署到 GitHub Pages。

## 首次启动

在项目根目录打开终端，执行：

```sh
npm ci
```

将根目录 `.env.example` 复制成 `.env`：

```powershell
# Windows PowerShell
Copy-Item .env.example .env
```

```sh
# macOS / Linux
cp .env.example .env
```

编辑 `.env` 中的 `DB_HOST`、`DB_PORT`、`DB_USER`、`DB_PASSWORD`、`DB_NAME`，填入自己的 MySQL 配置。用于首次初始化的账号需要建库、建表权限。`DB_NAME` 选择新的空数据库；初始化不会清空已有数据库。

然后依次执行：

```sh
npm run init-db
npm run create-admin
npm start
```

打开 [本地页面](http://127.0.0.1:8080)。`create-admin` 默认创建用户名 `admin`，随机密码只在你自己的终端显示一次，请保存。也可以在 `.env` 设置 `ADMIN_USERNAME` 和至少 12 位的 `ADMIN_PASSWORD` 后再执行创建命令；已有账号不会被覆盖。

无须 API Key 即可使用注册、登录、题库、后台和本地知识库问答。启用云端问答时，按 [API 与密钥配置指南](docs/API配置指南.md) 填写自己的 DeepSeek Key，重启服务。

## 常用命令

| 命令 | 用途 |
|---|---|
| `npm start` | 同时提供页面和 `/api` 接口，默认只监听本机 8080 端口 |
| `npm run init-db` | 首次创建四张业务表及 75 道示例题，拒绝覆盖非空数据库 |
| `npm run create-admin` | 创建使用者自己的管理员账号 |
| `npm run check` | 检查 JavaScript 语法、页面内嵌脚本及本地文件引用 |

## 项目结构

```text
页面文件、styles.css              前端页面与样式
common.js、common-enhanced.js    两组正在使用的页面共享逻辑
quiz-api/server.js               唯一后端入口
quiz-api/config.js               读取根目录 .env
quiz-api/security.js             密码散列与令牌签名
database/init.sql                空表结构及题库，不含默认用户
scripts/                        初始化、创建管理员与检查命令
docs/API配置指南.md              密钥名称、填写位置与官方获取入口
```

两份 common 脚本服务于不同页面，功能不完全相同，因此保留；旧后端、重复登录/答题页面、重复数据库整包、安装器、机器专用任务脚本和日志已移除。

## 数据与发布

根目录 `.env`、依赖目录、日志及 `quiz-api/content-store.json`、`quiz-api/wrong-notebook-state.json` 已加入 `.gitignore`。后两者运行时按需生成，保存内容编辑和错题状态，部署时应持久化并自行备份。

后端只对外提供页面资产和接口，不公开 `.env`、数据库脚本、后端源码和运行数据。密码使用带随机盐的 scrypt，令牌带签名；未填写 `TOKEN_SECRET` 时每次启动自动生成，重启后需重新登录。会话存放内存，因此该版本按单实例运行。

上传 GitHub 时上传本文件所在项目目录，不要混入原始备份、数据库导出或本机 `.env`。如需局域网访问，在 `.env` 设置 `HOST=0.0.0.0`；公网部署使用自己的 HTTPS 反向代理，并限制数据库账户权限。

## 验证记录

本次在 Node.js 24.14.1、MySQL 8.0.45 的隔离测试环境验证了首次初始化、重复初始化保护、管理员创建、所有页面文件响应、注册登录与权限、题库、收藏、答题记录、错题本、排行榜、留言审核，以及不填 Key 时的本地问答。DeepSeek 请求格式通过本地模拟服务验证，未调用任何真实账号或付费云接口。
