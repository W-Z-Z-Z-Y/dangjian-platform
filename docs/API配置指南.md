# API 与密钥配置指南

本指南对应此项目源码，官方入口核对日期：2026-11-08。所有真实配置只填写在根目录 `.env`，不要写进 HTML、common 脚本或提交到 GitHub。

## 一、需要哪些配置

| 配置项 | 是否必须 | 用途与来源 |
|---|---|---|
| `DB_HOST`、`DB_PORT` | 必须 | 自己的 MySQL 主机和端口，本机通常为 `127.0.0.1`、`3306` |
| `DB_USER`、`DB_PASSWORD` | 必须配置正确 | 自己创建或已有的 MySQL 账号与密码；不是到 AI 平台申请的密钥 |
| `DB_NAME` | 必须 | 自己选择的数据库名称，首次初始化使用空库 |
| `DEEPSEEK_API_KEY` | 可选 | DeepSeek 开放平台创建的 API Key；留空使用本地知识库 |
| `DEEPSEEK_BASE_URL` | 云端问答使用 | 默认 `https://api.deepseek.com`，不要追加 `/chat/completions`，代码会自动追加 |
| `DEEPSEEK_MODEL` | 云端问答使用 | 默认 `deepseek-flash`，可改为自己有权限的模型 |
| `DEEPSEEK_TIMEOUT_MS` | 可选 | 默认模板为 `30000` 毫秒 |
| `TOKEN_SECRET` | 可选 | 自己生成的随机签名密钥，不向第三方申请；空值时自动生成临时值 |
| `ADMIN_USERNAME`、`ADMIN_PASSWORD` | 创建管理员时使用 | 自定义管理账号；密码留空则创建命令生成随机密码 |

云服务配置只由后端读取，浏览器不会获得 DeepSeek Key。

## 二、在哪里获取 DeepSeek Key

1. 打开 [DeepSeek 开放平台](https://platform.deepseek.com/)，登录自己的账号。
2. 在平台的 API keys 管理页面创建自己的 API Key，按平台提示保存。
3. 确认账号具备 API 调用权限、可用额度及目标模型权限。网页聊天产品的登录或会员状态不能代替 API Key。
4. 官方接入说明见 [首次调用文档](https://api-docs.deepseek.com/)。模型变更时以该文档和账号可用模型为准；[模型列表接口说明](https://api-docs.deepseek.com/api/list-models/) 提供查询方法。

当前默认模型使用官方文档中的 `deepseek-flash`，旧项目中的 `deepseek-chat` 不再作为默认值。[官方变更记录](https://api-docs.deepseek.com/updates/)

## 三、具体填写在哪里

先复制 `.env.example` 为 `.env`，再编辑以下字段。示例故意不填写任何真实密码或 Key：

```dotenv
DB_HOST=127.0.0.1
DB_PORT=3306
DB_USER=root
DB_PASSWORD=
DB_NAME=party_question_bank

DEEPSEEK_BASE_URL=https://api.deepseek.com
DEEPSEEK_API_KEY=
DEEPSEEK_MODEL=deepseek-flash
DEEPSEEK_TIMEOUT_MS=30000
```

将你自己的密码和 Key 填在等号右边。密码如果包含 `#` 或空格，用双引号包住整个值。修改后重启 `npm start`。

可运行以下命令在本机生成 `TOKEN_SECRET`，复制输出到 `.env`；不要将输出发给他人：

```sh
node -e "console.log(require('node:crypto').randomBytes(32).toString('hex'))"
```

## 四、如何确认

1. 执行 README 中的数据库初始化、管理员创建和启动步骤。
2. 打开页面，登录并进行题库操作。
3. Key 留空时，问答页面可用本地规则回答“党员义务”等已收录的问题，不等同于通用大模型。
4. 填写有效 Key 并重启后，`POST /api/chat` 的成功响应中 `data.provider` 为 `deepseek`；缺少 Key 或云调用失败时为 `local-fallback`，不显示真实 Key。

## 五、常见问题

| 情况 | 处理 |
|---|---|
| `ECONNREFUSED` | 检查 MySQL 是否启动、端口是否正确 |
| `Access denied` | 检查自己的数据库账户、密码和授权 |
| 初始化提示数据库非空 | 新建空库并修改 `DB_NAME`；命令不会删除已有数据 |
| 页面显示 API 失败 | 从 `npm start` 提供的地址打开，不能双击 HTML |
| AI 一直使用本地回答 | 检查 Key、模型、网络和额度；查看自己终端中的失败原因 |
| 修改 `.env` 无效 | 停止并重新启动 Node 服务 |

真实 Key 只存本机 `.env` 或部署平台的后端环境变量。即使仓库设为私有也不应提交它；如果曾公开过，去开放平台撤销并更换。
