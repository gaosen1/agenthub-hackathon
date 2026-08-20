# AgentHub Design System — MASTER

> 本文件是 hub-web 全部新页面/组件的视觉与交互唯一真相（ui-ux-pro-max 产出）。
> 存量页面重构时同样迁入本系统。dials：variance 3 / motion 2 / density 7。
> 产品定位：**个人开发者的 Agent 运维控制台**——扫一眼知状态、一步完成操作。

## 0. 反 AI 味红线（本产品的"不要"清单）

- 不要渐变品牌色/渐变文字/渐变按钮（旧 `--grad` 靛紫渐变是首要清除对象）；
- 不要发光阴影（`box-shadow: 0 0 12px …`、neon glow）、不要玻璃拟态/模糊浮层；
- 不要手写体/圆体（Caveat、Quicksand 之类）与任何装饰性 display 字体；
- 不要 emoji 或 FontAwesome 字形当图标——新代码一律内联 SVG（Lucide 风格 1.5px 描边）；
- 不要居中 hero 三件套、不要等宽三卡 bento、不要为动效而动效；
- 不要假数据占位：无来源的数一律渲染「未配置」/「—」（沿用 S10/S11 铁律）。

## 1. 色彩（暗色唯一模式，扁平、无发光）

| 角色 | 值 | 变量 |
|---|---|---|
| 背景 | `#0f1216` | `--n-bg` |
| 面板 | `#14181e` | `--n-panel` |
| 抬升面 | `#1a2028` | `--n-raise` |
| 发丝线 | `#262c35` | `--n-line` |
| 强发丝线 | `#333b47` | `--n-line2` |
| 正文 | `#e8ebef` | `--n-tx` |
| 次级文本 | `#9aa4b2` | `--n-tx2` |
| 弱文本 | `#66707e` | `--n-tx3` |
| 主操作 | 实心 `#e8ebef` 面 + `#0f1216` 字（反白，无渐变） | `--n-cta` |
| 链接/焦点环 | `#58a6ff`（仅链接与 focus-visible） | `--n-focus` |
| 状态 ok / warn / err / run | `#3ecf8e` / `#f5b04d` / `#f0616d` / `#58a6ff` | `--n-ok` 等 |

状态色只用于状态语义（badge、dot、表格状态列），不作装饰。

## 2. 字体

- UI 文本：沿用系统 sans（含 PingFang SC）；13px 基准，行高 1.45。
- **数据一律等宽** `--mono`（id、commit、时间戳、字节数、key、token、表格数字列），12px。
- 层级靠字重/字号/letter-spacing：区块标题 11px uppercase `letter-spacing:.08em` `--n-tx3`；
  页标题 17px/700；不使用 >24px 的展示字号。

## 3. 形状与层级

- 圆角：容器/卡片 6px，控件 4px，chip/badge 保留 pill 但**扁平无发光**。
- 层级只靠背景阶（bg→panel→raise）+ 1px 发丝线；**无阴影**（除 modal 的 `0 8px 24px rgba(0,0,0,.35)`）。
- 间距 8px 网格；表格行高 36px；面板内边距 16/20。

## 4. 动效（motion 2）

- 仅状态变化用 120–160ms `opacity/transform`（hover 提亮、badge 切换、modal 进出）。
- 无环境动画、无扫描线、无闪烁光标；running 指示用 8px 状态点 + 文本，不用旋转图标长转。
- `@media (prefers-reduced-motion: reduce)` 全关。

## 5. 组件约定（新页面直接用）

- 表格优先于卡片墙：数据面板（OSS/Sandbox/Settings 列表）用 `DataTable`，数字列等宽右对齐。
- 空态/未配置/错误是一等公民：统一 `.empty` 块 = 图标 + 一句原因 + 可选操作按钮。
- 按钮三档：primary（反白实心）、ghost（发丝线）、danger（err 描边）；禁用态降 `--n-tx3`。
- 表单：label 12px `--n-tx2` 在上，控件全宽；密钥类输入默认掩码 + 「显示」切换。
- 所有可点元素 `cursor:pointer` + `:focus-visible` 2px `--n-focus` 环；触控目标 ≥36px（桌面工具）。

## 6. 迁移策略

- 新令牌以 `--n-*` 前缀并行引入 `styles.css`，新视图（OssView/SettingsView 重写、新组件）只用 `--n-*`；
- 存量 `--bg/--brand/--grad` 在 t20 重构期逐页替换，完成后删除旧令牌与 `--grad`。

## 7. 验收清单（每个新页面提交前）

- [ ] 无渐变/发光/玻璃/emoji 图标；层级仅靠背景阶与发丝线
- [ ] 数据列等宽；空态/加载/错误/禁用齐备；无假值
- [ ] 键盘可达、focus-visible 可见；375px 不横向溢出
- [ ] reduced-motion 下无动画；布局在异步内容到达时不跳动
