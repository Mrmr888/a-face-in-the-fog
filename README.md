# 雾中来客

一个由 DeepSeek 主持的民国剧情推理游戏。1926 年，军阀混战。你曾在青石岭濒死时被陌生人救下；数月后，在临江城澄江饭店的酒会上，你要从五位来宾中认出那位恩人。

五位来宾分别是随军医生沈砚舟、战地记者陆映棠、航运行商顾怀章、戏班歌者苏曼卿和电报译员周渡。每局随机确定救命人，同时重新分配其他人的证据特征；本局真相一经生成就固定。

## 开始游玩

需要 **Node.js 22 或更新版本**。项目零第三方依赖，无需执行 `npm install`。

先克隆仓库，再启动游戏（Windows、macOS、Linux 均可）：

```sh
git clone https://github.com/Mrmr888/a-face-in-the-fog.git
cd a-face-in-the-fog
npm start
```

也可以在 GitHub 点击 **Code → Download ZIP**，解压后在包含 `package.json` 的目录打开终端，运行 `npm start`。

打开 [http://127.0.0.1:3000](http://127.0.0.1:3000)，点击入席，在页面输入自己的 DeepSeek API Key 并选择模型，即可开始。密钥无需写进源码或配置文件。可以从 [DeepSeek 开放平台](https://platform.deepseek.com/api_keys) 获取；模型调用费用由自己的 DeepSeek 账户承担。

每位玩家在自己的电脑运行游戏、使用自己的 Key；不需要向仓库作者提供密钥。按 `Ctrl+C` 停止服务。

默认使用 **DeepSeek V4.1 Flash**（`deepseek-flash`），也可选择 **DeepSeek V4 Pro**（`deepseek-v4-pro`）。模型名称和接口已于 **2026-09-29** 对照 [官方模型列表](https://api-docs.deepseek.com/api/list-models/) 与 [Chat Completions 文档](https://api-docs.deepseek.com/api/create-chat-completion/) 核实；后续模型更新以官方文档为准。

服务仅监听本机 `127.0.0.1`。这是本地运行项目，未包含公网部署配置。

## 玩法

1. 与五位来宾交谈，询问他们在战事中的经历。**谈话不消耗记忆次数**，可以反复调查。
2. 点击“唤起一段记忆”。Agent 会根据调查进展选择一条尚未出现的真实线索，并写出回忆场景。
3. 对照记忆手账中的固定证据与人物回答，在“我的推断”里记录判断。
4. 选中你认定的人并确认指认。**五段可靠记忆以内认对即成功；认错即失败**，确认后本局结束。
5. 用完第五段记忆仍可继续谈话和指认。继续索取**第六段记忆**会产生一段从未发生的往事，并立即进入失败结局。

最终指认与第六次回忆都由本地规则判定。模型负责人物对白、回忆顺序和叙事，不能改变救命人、固定证据或胜负。模型请求失败或返回无效内容时，不扣除记忆次数。

## 会话与密钥

API Key 仅留在本机服务进程内存中，用于请求 DeepSeek，不写入文件或浏览器持久存储。浏览器使用不含密钥的随机会话标识，通过 `HttpOnly` Cookie 恢复进度。

会话从成功开局起有效 **两小时**，谈话不会延长有效期。刷新页面可以恢复有效会话中的游戏进度；“我的推断”只留在当前页面，刷新会丢失。确认离席或重新开始会清除旧会话；关闭服务也会清除进度与密钥。

## 开发与验证

```powershell
# 修改服务端代码后自动重启；重启会清空当前会话
npm run dev

# 检查 JavaScript 语法
npm run check

# 运行游戏规则、DeepSeek 适配和 HTTP 接口测试
npm test
```

测试通过注入模拟模型响应验证规则和接口，不需要真实密钥，也不产生 DeepSeek 费用。覆盖五位人物的答案唯一性、第五与第六次记忆边界、错误指认、无效响应不改变进度、会话隔离等行为。**目前尚未使用真实 DeepSeek API Key 完成在线联调。**

浏览器交互测试另有独立的离线服务：

```powershell
node tests/fixtures/browser-server.mjs
```

该服务使用 [http://localhost:3001](http://localhost:3001)，仅供界面验证；在输入框填写测试标识 `offline-ui-check`。它返回确定的模拟剧情，不调用 DeepSeek，也不会改变 `npm start` 的正式游戏行为。

若开发工具的受限环境报 `EACCES`、禁止外网连接或禁止本地监听，可在普通系统终端执行 `npm start`，或按开发工具提示批准所需权限。若提示端口被占用，先关闭自己之前启动的服务；也可在 PowerShell 中设置其他端口后启动：

```powershell
$env:PORT = '3002'
npm start
```

## 文件说明

| 文件 | 用途 |
| --- | --- |
| `server.mjs` | 本地 HTTP 服务、会话管理、API 路由和静态文件 |
| `src/game.mjs` | 人物与固定真相、随机证据配置、记忆计数和结局判定 |
| `src/deepseek.mjs` | DeepSeek 请求、角色上下文约束与响应校验 |
| `public/index.html` | 酒会页面、密钥输入和结局界面 |
| `public/styles.css` | 页面布局、配色和响应式样式 |
| `public/app.js` | 谈话、回忆、指认与会话恢复交互 |
| `public/art/*.svg` | 本地饭店场景、人物与标记插画 |
| `tests/*.test.mjs` | 游戏规则、模型适配和服务接口测试 |
| `tests/fixtures/browser-server.mjs` | 独立的离线浏览器测试服务 |
