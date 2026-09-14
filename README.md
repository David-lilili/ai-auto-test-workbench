# Auto Test Workbench

Auto Test Workbench 是一个多项目 AI 自动化测试工作台：把自然语言测试任务转换为可解释、可执行、可诊断的 DSL 执行链路，并围绕执行结果沉淀可复用的测试知识。

```
用户自然语言
  -> AI 意图理解
  -> 本地按项目检索 Page Model / Operation Manual 知识
  -> 本地 Validator / Planner 校验并物化 DSL
  -> Executor 执行
  -> 断言归因 / FailurePackage / Observation Package
  -> proposal / review / knowledge writeback
```

## 特性

- **自然语言到 DSL**：AI 理解意图后，由本地规则引擎物化为结构化的 DSL 执行计划，不直接执行自由文本。
- **Page Model 知识库**：以页面/区域/元素/locator/状态为粒度的执行知识，AI 生成 DSL 只能引用已知 ID，杜绝幻觉选择器。
- **Operation Manual**：页面业务操作说明（页面在哪、能做什么、需要什么数据），与 locator 解耦。
- **受控执行与证据包**：失败自动归因（意图/检索/DSL/执行/断言/环境/数据分层），输出 FailurePackage 与 Observation Package。
- **知识沉淀闭环**：执行结果不能直接污染正式知识，必须先生成 proposal，经 review 后才写回知识库。
- **多项目隔离**：每个项目独立的环境配置、知识存储、账号画像与用例资产。
- **账号画像匹配**：按用例对账号安全状态/资产/持仓/历史数据的结构化要求选择账号，AI 不能自行选号。
- **MCP 接入**：通过 stdio 向 Claude / Cursor / Codex 等 MCP 客户端暴露只读工具集。

## 快速开始

```bash
npm install
cp .env.example .env   # 配置 AI Provider，见 .env.example 内注释
npm run workbench      # 启动 Web 工作台，默认 http://127.0.0.1:54319
```

MCP 客户端接入：

```bash
npm run mcp
```

### 配置 AI Provider

AI Provider 由项目根目录 `.env` 环境变量配置，支持 DeepSeek（默认）、GLM、OpenAI 兼容协议。示例：

```ini
AI_PROVIDER=deepseek
DEEPSEEK_API_KEY=sk-your-key
DEEPSEEK_MODEL=deepseek-chat
DEEPSEEK_BASE_URL=https://api.deepseek.com
```

**不要提交真实 API Key、token、验证码、账号密码或 provider secret**。`.env` 已在 .gitignore，`storage/ai-settings.json`（服务器启动时的 provider 配置文件）同样不要提交真实 Key。

## 核心概念

| 概念 | 说明 |
|------|------|
| Page Model | 页面执行知识：页面、区域、元素、组件、locator、状态和可观察断言能力 |
| Operation Manual | 页面业务操作说明，不保存 locator |
| DSL | 平台执行计划，只能引用当前项目知识库中的已知 ID |
| Case Asset | 用例资产：业务步骤和期望断言，不保存 DSL 与执行历史 |
| Account Profile | 账号画像：安全状态、资产、持仓、历史数据与账号定位 |
| Account Factory | 执行前准备测试账号和前置条件的 adapter 边界 |
| FailurePackage / BlockPackage / Observation Package | 失败证据包 / 业务或环境阻断证据 / 执行观测产物 |
| Proposal | 知识更新建议，经审核后写回正式知识 |

## 目录结构

```
src/
  adapters/        项目接入适配与意图路由
  capture/         页面采集框架
  core/            页面模型、DSL 构建、执行规划、断言归因等核心逻辑
  exploration/     探索式采集与覆盖度分析
  historical/      历史知识存储
  memory/          账号与运行态存储
  test-assets/     用例资产与 DSL 物化
  workbench/       Web 工作台服务与 API
  workspace/       工作区命令适配
tests/             单元测试
scripts/           命令行工具入口
web/               Web 工作台前端
configs/           全局配置
```

## 验证

```bash
npm run verify
```

`npm run verify` 为提交前统一自测入口，依次执行项目能力索引校验、TypeScript 类型检查、编码检查、JSON 资产校验和单元测试。

## 许可证

[MIT](LICENSE)
