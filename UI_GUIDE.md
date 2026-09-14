# UI Guide - Auto Test Workbench

## 1. Product Direction

Auto Test Workbench 是一个面向测试、自动化、DSL 生成、AI 执行计划和项目知识建模的专业工作台。

界面风格参考 Postman、JetBrains 工具、现代 API/Test Workbench，而不是传统后台管理系统或营销型 SaaS 页面。

核心体验是：

```txt
Workspace Navigation -> Collection / Case Tree -> Editor / Detail -> Run Result / AI Insight
```

产品应该给用户一种感觉：

- 这是一个可以高频操作的工作台。
- 信息密度适中，适合长时间使用。
- 操作入口清晰，执行状态明确。
- 页面有层级，不寡淡，不散乱。
- 视觉克制、专业、紧凑。

## 2. Tech And Component Rules

- 优先使用项目现有技术栈。
- 如果项目已使用 Ant Design，Button、Table、Form、Input、Select、Modal、Drawer、Tabs、Collapse、Tree、Tag、Tooltip、Dropdown、Segmented、Message、Notification 都优先使用 Ant Design。
- 当前项目未使用 Ant Design，前端是原生 HTML/CSS/JS，因此改造应复用现有 DOM/API，并抽象稳定工作台布局组件。
- 禁止重复手写基础 UI 组件库。
- 允许自定义页面布局、工作台面板、Sidebar、TopBar、CommandBar、InspectorPanel、状态标签业务封装、少量主题 token 和间距规则。
- 禁止混用多个大型 UI 库、随机引入无关动画库、为了好看增加无意义装饰。

## 3. Visual Style

风格关键词：

- Professional
- Compact
- Workbench
- Structured
- Calm
- Slightly technical
- Postman-inspired

不要：

- 营销型 Hero。
- 大面积渐变背景。
- 大圆角玻璃拟态。
- 到处都是漂浮卡片。
- 纯白大空白页面。
- 单一浅蓝色主题。
- emoji 当图标。
- 过度阴影。
- 过度装饰。

建议颜色：

```css
--color-bg-app: #f4f6f8;
--color-bg-panel: #ffffff;
--color-bg-sidebar: #111827;
--color-bg-sidebar-active: #1f2937;
--color-border: #d8dee8;
--color-border-subtle: #e5e7eb;

--color-text-primary: #111827;
--color-text-secondary: #4b5563;
--color-text-muted: #8a94a6;

--color-brand: #1f6feb;
--color-accent: #ff6c37;

--color-success: #16a34a;
--color-warning: #f59e0b;
--color-error: #dc2626;
--color-info: #2563eb;
```

Postman 橙色 `#ff6c37` 只用于强调操作、选中状态或关键按钮，不要大面积铺满。品牌蓝可以保留，但不要让全站变成浅蓝后台。

## 4. Layout System

全局页面结构：

```txt
+------------------------------------------------------+
| TopBar                                               |
+------------+-----------------------------------------+
| Sidebar    | Main Workspace                          |
|            |                                         |
|            |                                         |
+------------+-----------------------------------------+
```

推荐尺寸：

- Sidebar width: 220px
- TopBar height: 40px - 48px
- Panel radius: 6px - 8px
- Panel border: 1px solid var(--color-border)
- Main background: var(--color-bg-app)

优先使用多栏工作台结构：

```txt
+-------------+----------------------+----------------+
| Tree/List   | Main Detail/Editor   | Inspector/Run  |
+-------------+----------------------+----------------+
```

适合用例中心、项目知识地图、AI 助手上下文区域、执行结果查看。不要让页面只剩一个巨大空白区域。

## 5. Sidebar

Sidebar 是 Workspace 入口，不是普通菜单。

要求：

- 固定宽度。
- 品牌区明显。
- 当前菜单高亮清晰。
- 图标 + 文案。
- 分组展示核心模块和高级功能。
- 不要左侧大面积空白。

建议结构：

```txt
Auto Test
Workbench

Main
- AI 助手
- 用例中心
- 项目知识地图

Advanced
- 执行记录
- 环境配置
- DSL 管理
```

选中态：深色 Sidebar 中使用较亮背景，可用橙色或蓝色短条提示当前项。

## 6. TopBar

TopBar 用于表达当前上下文，而不是单纯占位。

应包含：

- 当前项目。
- 当前环境。
- 用户。
- 运行状态。
- 刷新/同步入口。
- 必要时显示当前页面 Tab。

示例：

```txt
Project: demo | Env: test | Status: idle | User
```

## 7. Page Patterns

### 7.1 AI Assistant Page

AI 助手页是产品核心入口，不能做成大空白聊天页。

推荐结构：

```txt
+-------------------+-----------------------------+----------------------+
| Recent Tasks      | Conversation / Plan Trace    | Context Panel        |
| Templates         |                             | Project / Env / Case |
+-------------------+-----------------------------+----------------------+
| Command Bar                                                               |
+---------------------------------------------------------------------------+
```

Command Bar 必须明显，包含需求输入框、当前项目选择、当前环境选择、快捷模板、生成计划、执行当前计划、清空/停止/重试。

空状态应该展示常用需求模板、最近任务、当前上下文和可执行操作。

禁止只在中间放一句“等待需求”、底部只有一个普通 textarea、按钮散落在输入区下方。

### 7.2 Case Center Page

用例中心应参考 Postman Collection。

推荐结构：

```txt
+--------------------------+-----------------------------------+
| Case List / Collection   | Case Inspector                    |
|                          | Header + Actions                  |
|                          | Tabs                              |
|                          | Runs / DSL / Assertions           |
+--------------------------+-----------------------------------+
```

Case List 显示用例名称、优先级、DSL 状态、最近执行状态、所属模块。

Case Detail 顶部显示用例标题、优先级 Tag、当前状态、项目、页面、DSL 版本。

操作按钮集中在详情区顶部工具栏：Run、Generate DSL、Regenerate、Save。

详情内容使用 Tabs：

- Overview
- Preconditions
- Steps
- Assertions
- Runs
- AI Notes

执行历史使用紧凑表格或时间线，不要用大量浅色边框块堆叠。失败记录要明显。

### 7.3 Project Knowledge Map Page

项目知识地图应该像“模块地图”，不是普通表单页。

推荐结构：

```txt
+----------------------+---------------------------------------+
| Module / Page Tree   | Selected Node Detail                  |
|                      | Metadata Bar                         |
|                      | Collapse / Tabs                      |
+----------------------+---------------------------------------+
```

顶部可以有 compact metric bar：Project、Nodes、Built、Partial、Updated At。

左侧 Tree 层级示例：

```txt
demo
- 资产中心
  - 现货账户
  - 资金流水
    - 合约流水
    - 理财流水
    - 现货流水
```

节点状态使用 Tag 表达：已建模、部分建模、未建模。

右侧详情使用 Tabs 或 Collapse：

- 页面功能描述
- 导航路径
- 页面能做什么
- 元素
- 动作 / 跳转
- 可用断言能力
- 建模备注

### 7.4 Account Profile Page

账号画像页用于展示项目、环境、账号在测试前置条件上的能力状态。它不是固定角色管理，也不是某项目账号后台。

页面必须由 `storage/account-profile-schemas/<project>.json` 驱动，不允许在前端写死项目专属字段。项目切换后，维度表按当前项目 schema 渲染。

推荐结构：

```txt
+----------------------+-----------------------------+----------------------+
| Project / Account    | Profile Dimension Table     | Dimension Inspector  |
|                      |                             | Evidence / Usage     |
+----------------------+-----------------------------+----------------------+
```

左侧展示项目、环境和账号列表。中间展示画像维度表，通用列为：维度、当前值、状态、来源、更新时间、过期时间、证据。右侧 Inspector 展示选中维度的采集策略、最近证据、被哪些用例或 DSL 需求引用。

DSL 生成进度、用例详情、执行历史和批量执行结果中的账号应可点击，跳转到账号画像页并定位到对应项目、环境和账号。

## 8. Components

Panel 用于工作区分栏，不是装饰卡片。

```css
.panel {
  background: var(--color-bg-panel);
  border: 1px solid var(--color-border);
  border-radius: 8px;
}
```

Panel 内部要有明确 Header、Body、Footer。

Toolbar 用于承载操作按钮。操作靠右或按工作流排列，主操作突出，次操作使用默认按钮，危险操作使用 danger，不要让按钮分散在页面各处。

StatusTag 状态必须统一：

- passed -> green
- failed -> red
- idle -> gray
- running -> blue
- executable -> green/blue
- draft -> gray

Status / Progress blocks：

- 普通状态提示使用浅色中性背景、浅边框和正文色。
- 深色状态条只能出现在深色 Sidebar 内，不得在主工作区、AI 助手、账号画像、用例中心和数据库页中作为提示条使用。
- 空状态提示没有内容时不应保留一条空框。
- 执行步骤、计划步骤和诊断卡片默认浅色；失败时用红色状态和自动展开关键诊断表达，不用黑色块制造强调。

空状态不能只写一句话，必须包含当前状态说明、1-3 个可执行动作、可选模板或示例。

## 9. Typography

- 页面标题：18-20px，600。
- 面板标题：14-16px，600。
- 正文：13-14px。
- 辅助文字：12px。
- 表格内容：12-13px。

不要使用过大的标题，不要使用负 letter-spacing，不要让文字撑破按钮、标签或卡片。

## 10. Spacing

推荐间距：

- 4px: 极小间距。
- 8px: 组件内部间距。
- 12px: 紧凑分组。
- 16px: 标准分组。
- 24px: 页面区块。

工作台页面应紧凑，不要用 40px 以上的大间距堆空白。

## 11. Interaction

必须提供清晰反馈：

- 点击执行后显示 running 状态。
- 成功/失败有明确 Tag。
- 生成 DSL 后展示版本或更新时间。
- 保存后有 message。
- 危险操作需要确认。
- 长任务需要 loading。
- 可折叠内容要有展开/收起状态。

## 12. Responsive

主要面向桌面端，优先保证 1440px 和 1920px 宽度体验。

最低要求：

- 1366px 宽度下不重叠。
- 文本不溢出。
- 表格可以横向滚动。
- 右侧 Inspector 在小屏可以变成下方区域。

## 13. Forbidden List

禁止以下设计：

- 大面积空白居中提示。
- 浅蓝边框到处堆叠。
- 所有模块都是白色卡片。
- 黑色小信息块过多。
- 按钮散落在页面四角。
- 表格没有工具栏。
- 详情没有 Tabs/Collapse。
- 执行状态不明显。
- 页面没有主操作。
- 随机使用渐变。
- 使用 emoji 做功能图标。
- 过大圆角。
- 过度阴影。
- 营销型 Hero。
- 纯装饰插画。
- 组件风格不一致。

## 14. Implementation Checklist

每次开发或修改 UI 前，必须检查：

- 是否复用了现有组件库？
- 是否符合工作台布局？
- 页面是否有明确主操作？
- 信息层级是否清楚？
- 状态是否可扫描？
- 是否避免了大面积空白？
- 是否避免了无意义卡片？
- 是否有 loading、empty、error 状态？
- 1366px 和 1920px 下是否不重叠？
- 是否通过 lint/build/typecheck？
