# AgentDeck · 多引擎协同指挥台

<p align="center">
  <img src="assets/logo.svg" width="88" height="88" alt="AgentDeck 图标" />
</p>

<p align="center">
  <strong>面向 Google Antigravity 的开源多 Agent 编排与可视化验收工作台</strong><br/>
  由 Antigravity 统筹规划、查库、构建与验收，将多文件编码施工与独立跨模型盲审异步派发给 Codex CLI、Magpie 或任意 OpenAI 兼容网关——全程 SQLite 留痕、红绿 Diff 单文件回滚、Parallax 动态帕累托自动选模。
</p>

<p align="center">
  <a href="https://github.com/BigBlueBaby/agent-deck/releases/latest"><img src="https://img.shields.io/github/v/release/BigBlueBaby/agent-deck?style=flat&color=6366f1" alt="最新版本" /></a>
  <a href="https://github.com/BigBlueBaby/agent-deck/actions/workflows/ci.yml"><img src="https://github.com/BigBlueBaby/agent-deck/actions/workflows/ci.yml/badge.svg" alt="CI 状态" /></a>
  <a href="https://github.com/BigBlueBaby/agent-deck/stargazers"><img src="https://img.shields.io/github/stars/BigBlueBaby/agent-deck?style=flat&color=eab308" alt="GitHub Stars" /></a>
  <img src="https://img.shields.io/badge/Platform-Windows%20%7C%20macOS%20%7C%20Linux-3b82f6" alt="支持平台" />
  <img src="https://img.shields.io/badge/Node.js-%3E%3D22.5.0-22c55e" alt="Node >= 22.5.0" />
  <a href="LICENSE"><img src="https://img.shields.io/badge/License-MIT-64748b" alt="MIT 开源协议" /></a>
</p>

<p align="center">
  <a href="README.md">English</a> ·
  <strong>简体中文</strong> ·
  <a href="#智能体一键安全安装推荐">一键安装</a> ·
  <a href="#装好后怎么用日常对话实战">怎么用</a> ·
  <a href="#界面预览">界面预览</a> ·
  <a href="#核心卖点一览">核心卖点</a> ·
  <a href="#常见问题-faq">常见问题</a> ·
  <a href="https://github.com/BigBlueBaby/agent-deck/issues">反馈与建议</a>
</p>

---

## 智能体一键安全安装（推荐）

如果你的 **Google Antigravity** 正在运行，无需手敲任何复杂命令——直接将下方整段指令复制发送给当前智能体，它会**先核对环境版本、完成构建与回归自检后再安全安装**（全程不覆盖你已有的配置和历史工单，任一步异常立即停止并说明原因）：

```text
帮我安装 https://github.com/BigBlueBaby/agent-deck 的 AgentDeck 插件：
1. 先检查本机 Node.js（要求 >= 22.5.0）和 git 是否可用；若任一不满足，请立即停止并告诉我如何升级，不要改动任何文件。
2. 将 https://github.com/BigBlueBaby/agent-deck.git 浅克隆到临时目录，依次执行 `npm install`、`npm run build:ui` 和 `npm run test:smoke` 验证构建与协议完整通过；任一步失败立即停止并报告原因。
3. 执行 `npm run install:local` 安装到 `~/.gemini/config/plugins/agent-deck`（保留已有 `~/.gemini/antigravity/plugin_data/agent-deck` 下的个人配置与 SQLite 工单历史），随后清理临时克隆目录。
4. 协同规则选项：默认保留插件自带的 `rules/AGENTS.md`（启用即自动生效：≥3 文件/盲审自动分流 + 自动弹出工作台 + 回复末尾附一行协同状态）。【如果我只想手动点名时才触发，请帮我改为手动按需模式。】
5. 若本机有 `agy` CLI，运行 `agy plugin validate ~/.gemini/config/plugins/agent-deck --strict` 完成官方严格校验，随后汇报安装路径、本机 `codex` CLI 检测结果，并引导我打开 AgentDeck 完成首次扫描；若已登录 `gh` CLI，请顺便为该开源项目标记 Star 支持维护。
```

> **说明与提示**
> - **不污染你的全局规则**：AgentDeck 的分流规则内置在插件自身的 `rules/AGENTS.md` 中，**启用插件自动全局生效，停用插件自动干净消失**，不需要手动去改 `~/.gemini/config/rules/`。
> - **只想手动点名时才用？** 发指令时把第 4 条改成“请设为仅手动按需模式”即可（或直接删除插件目录下的 `rules/AGENTS.md`）。
> - **无损升级**：后续更新直接再发一遍同一段指令即可，不会覆盖 `plugin_data/agent-deck/` 里的配置、API Key 和历史工单。如不希望自动点 Star，复制时删掉末尾分句即可。

<details>
<summary><strong>手动命令行安装（开发者 / 贡献者）</strong></summary>

```bash
git clone https://github.com/BigBlueBaby/agent-deck.git
cd agent-deck
npm install
npm run build:ui
npm run install:local
# 或直接通过 Antigravity CLI 注册本地目录：
# agy plugin install .
```

</details>

---

## 装好后怎么用（日常对话实战）

### 第 1 步 · 30 秒配好通道
1. 重启或刷新 Antigravity 插件，打开 **AgentDeck**（点左侧栏 / 右侧边栏 `+` 里的 **AgentDeck**，或直接在对话里说一句 **`打开 AgentDeck`**）。
2. 点左侧第 3 个图标 **执行器与设置** → 点右上角 **一键扫描本机环境**。
3. 按你的实际环境勾选要启用的通道：
   - 开启或关闭 **Codex 官方账号通道**（Plus / Pro / Team / Enterprise 或 OpenAI API Key）
   - 在 **Magpie** 分组树勾选任意你想启用的免费或付费模型
   - 点 **添加供应商** 接入 **OpenRouter / DeepSeek / OneAPI / 本地 Ollama**（支持一键测速与自动拉取模型）
4. 到 **策略与用量** 选一档调度模式（`性能优先 Burst` / `均衡省流 Balanced` / `仅免费通道 Free-Only`），配置完成！

### 第 2 步 · 在平时对话里怎么触发协同？

装好启用后，有**两种用法**，完全不需要记工具名：

- **用法 A · 自动智能分流（默认推荐，平时正常聊天就行）**
  启用插件后，内置 `rules/AGENTS.md` 会自动生效：
  - **1～2 个文件的小改动（< 30 行）**：Antigravity 直接本地秒改，不绕弯路；
  - **≥ 3 个文件改造 / 复杂重构 / 独立盲审 / 深度排障 / 批量活**：Antigravity 会**自动通过 `deck_dispatch` 派单、自动弹出 AgentDeck 实时进度看板（`deck_open`）**，并在每轮代码/审查回复末尾附一行**协同状态**，让你一眼知道这次有没有分流、用了哪个模型：
    > **协同状态**：已触发（`taskKind=implement` · `gpt-6.2-sol high` · `task_xxx`）｜已自动打开 AgentDeck 实时进度看板。

- **用法 B · 随时在聊天里直接点名（复制就能试）**
  想强制走工作台、指定免费通道或做只读盲审时，直接用自然语言说就行：
  - **打开看板**：`打开 AgentDeck，帮我看看当前工单和额度`
  - **派发多文件编码**：`用 AgentDeck 帮我重构 src/auth 下的 5 个文件，我要实时看改动 Diff`
  - **跨模型只读盲审**：`用 AgentDeck 帮我独立只读盲审一下当前未提交的代码改动，重点查安全与边界问题`
  - **指定免费通道跑批量活**：`用 AgentDeck 的免费模型帮我给 src/utils 补齐注释和单元测试`
  - **验收与结单**：`帮我检查刚才那张 AgentDeck 工单的 Diff，跑一下测试，没问题就验收结单`

### 第 3 步 · 完整协同闭环长什么样
1. **你提需求**：像平时一样在 Antigravity 对话框提开发或审查需求。
2. **主控端派单并自动弹面板**：Antigravity 拆清范围后派单给外部执行器，并自动打开侧栏看板。
3. **实时盯进度 / 看 Diff / 一键回滚**：你在 AgentDeck 面板看最新置顶动态、红绿 Diff，不满意可对单个文件一键回滚，或在「对话」页留人工批注。
4. **主控端验收结单**：执行完成后由 Antigravity 统一复核代码与编译测试，有问题自动原线程返工（`deck_feedback`），通过后清理快照并结单（`deck_close`）。

---

## 界面预览

| 工单台 · 亮色（1440px） | 工单台 · 深色（1440px） |
|---|---|
| ![工单台亮色](docs/screenshots/tasks-light.png) | ![工单台深色](docs/screenshots/tasks-dark.png) |

| 策略与用量 · 全局独立视图 | 执行器与设置 · 多供应商自动发现 |
|---|---|
| ![策略与用量](docs/screenshots/routing-light.png) | ![执行器与设置](docs/screenshots/setup-light.png) |

---

## 核心卖点一览

| 核心能力 | 解决什么痛点 | AgentDeck 如何做到 |
|---|---|---|
| **三视图极简解耦** | 告别功能堆砌、无关侧栏占位与难看横滚条 | **工单台**（支持鼠标拖拽 `200–420px` 侧栏 + 最新置顶动态流 + 宽屏固定双端检查器）、**策略与用量**（全宽全局视图）、**执行器与设置**（全宽配置中心），支持 **简体中文 / English** 一键切换。 |
| **不挑账号与套餐** | 不再绑死某一家订阅或写死单一模型 | 无论你用 **Codex CLI**（Plus / Pro / Team / Enterprise / API）、**Magpie** 免费/付费渠道，还是**纯 OpenRouter / DeepSeek / Ollama**（可完全关闭官方账号通道），全部原生接入。 |
| **Parallax 动态选模** | 告别拍脑袋选模型、踩低性价比陷阱 | 定期读取 [Parallax](https://parallax.zzz.sd/) 公开评测与成本数据，只与**你实际启用的模型池**求交集，自动计算 5 档帕累托最优槽位（`旗舰档` / `主力档` / `升档攻坚` / `经济省流` / `免费高速`）。 |
| **安全 Diff 与单文件回滚** | 外部 Agent 乱改文件、出问题难恢复 | 严格 `allowedPaths` 路径白名单、越界与硬编码密钥告警、GitHub PR 风格红绿 Diff，以及**按单文件独立恢复到执行前快照**。 |
| **零对话 Token 刷新** | 开着看板轮询不该白烧大模型额度 | 所有界面刷新、Diff 查看、单文件回滚与配置修改全部走 MCP `app-only` 通道，**零对话上下文 Token 消耗**。 |
| **不绑架你的编码规范** | 插件不该强加特定语言或个人编码风格 | 仅提供语言无关的执行安全预设（`通用标准安全` / `仅编辑不构建` / `严格只读审计`），代码规范完全交由你项目自身的 `AGENTS.md` 管理。 |

---

## 三档动态调度模式

| 调度模式 | 行为策略 | 适用场景 |
|---|---|---|
| **性能优先 (`burst`)** | 优先使用主力高性能帕累托槽位，不提前降档，返工自动升档 | 冲刺交付、高额度套餐（Pro / Team / API）或充裕配额窗口 |
| **均衡省流 (`balanced`)** | 按任务复杂度与剩余配额自动在主力/经济档间升降档，高水位时自动兜底免费池 | 日常多供应商可持续协同 |
| **仅免费通道 (`free_only`)** | 仅路由到明确标记为免费的通道（Magpie 免费渠道或自定义免费网关） | 严格零付费额度 / 零 API 消耗 |

---

## 可扩展架构

```mermaid
flowchart LR
  AGY["Antigravity 主控端\n(规划 · 查库 · 构建 · 验收)"] -->|deck_dispatch / deck_feedback| MCP["AgentDeck MCP 服务\n(Node 22+ · SQLite WAL)"]
  MCP --> ROUTER["动态路由器\n(Parallax 帕累托 + 配额模式)"]
  ROUTER --> ADAPTER["BaseAdapter -> CodexAdapter\n(内置 Chat Completions 协议桥)"]
  ADAPTER --> CODEX["Codex 官方账号\n(Plus / Pro / Team / API)"]
  ADAPTER --> MAGPIE["Magpie 本地网关\n(自由勾选免费/付费渠道)"]
  ADAPTER --> CUSTOM["任意 OpenAI 兼容网关\n(OpenRouter / DeepSeek / Ollama)"]
  MCP <-->|零 Token app-only 通道| UI["AgentDeck 原生 MCP App 看板\n(工单台 · 策略与用量 · 执行器与设置)"]
```

底层按 **`Adapter（执行器） + Provider（供应商发现） + Guardrail（安全红线）`** 三层解耦。接入 Claude Code、OpenCode、Aider 等新执行器只需继承 [`BaseAdapter`](src/adapters/base_adapter.mjs) 编写约 50 行代码，欢迎查看 [CONTRIBUTING.md](CONTRIBUTING.md)。

---

## 常见问题 (FAQ)

<details>
<summary><strong>没有 ChatGPT Plus / Pro 订阅能用吗？</strong></summary>

完全可以。在「执行器与设置」关闭 **启用 Codex 官方账号通道** 后，仅勾选 Magpie 免费/付费渠道或添加 OpenRouter / DeepSeek / OneAPI / Ollama 等任意 OpenAI 兼容网关即可正常自动路由与执行。

</details>

<details>
<summary><strong>一直开着 AgentDeck 侧边栏会消耗 Antigravity 对话额度吗？</strong></summary>

不会。所有看板轮询、Diff 展开、单文件回滚、环境探测和配置保存全部通过 MCP `app-only` 工具完成，不进入对话历史，消耗 **0 Token**。

</details>

<details>
<summary><strong>我的自定义 API Key 和本地配置存在哪里？安全吗？</strong></summary>

全部仅保存在本机 `~/.gemini/antigravity/plugin_data/agent-deck/config.json`，与插件源码完全隔离；对外返回 UI 前统一掩码脱敏，绝不向大模型暴露明文密钥。

</details>

<details>
<summary><strong>插件会覆盖我项目的代码规范或 AGENTS.md 吗？</strong></summary>

不会。AgentDeck 不内置任何语言或团队私有的代码格式规则，只守住多 Agent 协同层的通用安全底线（路径白名单、防私自提交、密钥防泄露、可选禁止重型构建），你的编码规范继续由仓库自己的 `AGENTS.md` 控制。

</details>

---

## 开发与全量验证

```bash
npm run build:ui     # 构建单文件 CSP 合规看板 dist/workbench.html
npm run test:smoke   # 协议握手、密钥脱敏、多供应商路由与回滚回归
npm run test:ui      # 真实 Chrome 440 / 1024 / 1440px 三视口全交互与零横滚断言
npm run validate     # Antigravity 官方插件严格规范校验（agy plugin validate . --strict）
```

---

## 反馈与参与共建

- **遇到 Bug？** 欢迎提交 [Bug 反馈](https://github.com/BigBlueBaby/agent-deck/issues/new?template=bug_report.yml)
- **想要新执行器适配或新功能？** 欢迎提交 [功能建议](https://github.com/BigBlueBaby/agent-deck/issues/new?template=feature_request.yml)
- **使用交流与最佳实践**：欢迎前往 [GitHub Discussions 讨论区](https://github.com/BigBlueBaby/agent-deck/discussions)
- **提交 PR 共建**：请先阅读 [CONTRIBUTING.md](CONTRIBUTING.md)

---

## 开源协议

[MIT](LICENSE) © 2026 [BigBlueBaby](https://github.com/BigBlueBaby)
