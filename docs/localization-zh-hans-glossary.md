# Simplified Chinese glossary for the Jouzu CLI catalog

The `zh-Hans` catalog is a Simplified Chinese draft and is not offered as an
interface language. Translate from the English source rather than converting
the Traditional Chinese (`zh-Hant`) catalog.

## Source

Use `packages/cli/locales/en/*.ftl` as the source and
`packages/cli/locales/catalog-status.json` for its recorded metadata. Run
`node scripts/catalog-digest.mjs` to inspect the catalog digests. Compare draft
wording with the source whenever the English messages change.

## Vocabulary

The right column is the form the catalog uses. The left column is the English
term in the source catalog.

| English | Simplified Chinese |
| --- | --- |
| session | 会话 |
| profile | 配置档案 |
| model catalog | 模型目录 |
| catalog source | 目录源 |
| offering | 提供项 |
| revision | 修订 |
| digest | 摘要 |
| quarantine | 隔离 |
| isolation | 隔离 |
| plan | 计划 |
| apply | 应用 |
| conflict | 冲突 |
| backup | 备份 |
| transaction | 事务 |
| keybinding | 按键绑定 |
| default | 默认 |
| policy | 策略 |
| diagnostics | 诊断 |
| field | 字段 |
| problem | 问题 |
| warning | 警告 |
| state lock | 锁 |
| stale | 残留 |
| self-update | 自我更新 |
| install channel | 安装方式 |
| restart | 重启 |
| recovery | 恢复 |
| resume | 恢复 |
| rollback | 回滚 |
| flow control | 流控制 |
| hold | 保留 |
| subagent | 子代理 |
| workflow | 工作流 |
| scheduled | 定时 |
| notification | 通知 |
| runtime | 运行时 |
| credential | 凭据 |
| bearer token | bearer 令牌 |
| surface | 表面 |
| source text | 原文 |
| protected value | 保护值 |
| unreviewed | 未审核 |

Two pairs share a form: `quarantine` and `isolation` both read `隔离`, and
`recovery` and `resume` both read `恢复`. Check each use against its context;
the shared forms must not obscure distinct actions.

## Protected names

These stay as written in every locale. A translator never renders them in
Chinese. The shared record is
[`localization-glossary.md`](localization-glossary.md); this section names the
groups the `zh-Hans` catalog relies on and points to that page for the full set.

- Product and command names: `Jouzu`, `jouzu`, `jz`, `Pi`, `pi`, `Shisa`,
  `TextGuard`, `Camoufox`, `Jouzu Palette`, `Palette`, `Session UI`,
  `Jouzu Help`, `Workflow`, `Settings`, `Catalogs`, `Models`, `About`,
  `Dashboard`, `Parent Context`, `Subagent`, `Fetch URL`, `Search web`.
- Tool names and identifiers: `tff-fetch_url`, `tff-search_web`, and every
  model, provider, source, and offering ID.
- Command names and flags: `jouzu --help`, `jouzu pi --help`, `jz doctor`,
  `jz doctor --json`, `jz catalog status`, `jz keybindings plan`,
  `jz keybindings apply`, `jz profile plan`, `jz profile apply`,
  `jz update --extensions`, `/login shisa`, `/logout shisa`, `/reload`,
  `/textguard`, `/voice`, `/flow`, `/images`, `/subagents`, `/workflow`, `/labels`,
  `/model`, `--jouzu-home`, `--jouzu-profile`, `--jouzu-ui-locale`, `--json`,
  `--profile`, `--yes`, and the `auto-restart`, `notify`, and `off` policy
  values.
- Settings keys and file names: `schemaVersion`, `uiLocale`,
  `responseLanguage`, `artifactPolicy`, `maxContextTokens`, `settings.json`,
  `keybindings.json`, `localization.json`, `localization.lock`,
  `catalog.lock.json`, `catalog-status.json`, `models.json`, `auth.json`,
  `agents.json`.
- Locale tags and language values: `auto`, `en`, `ja`, `zh-Hans`, `zh-Hant`,
  `core`.
- The authentication scheme: `bearer` in prose and `Bearer` in the settings
  label. It is a protocol name, so it stays Latin.
- Environment variables: `JOUZU_NO_CLEAR`, `JOUZU_UI_LOCALE`, `SHISA_API_KEY`,
  `NO_COLOR`, `TERM`, `LC_ALL`, `LC_MESSAGES`, `LANG`.
- Paths, URLs, HTTP status codes, exit codes, digests, and version strings.
- Key names: `Ctrl+L`, `Ctrl+C`, `Tab`, `Shift+Tab`, `Enter`, `Control+Up`,
  `ctrl+enter`, and the `Kitty` and `modifyOtherKeys` protocol names.

## Forbidden words

The catalog is Simplified Chinese, so Traditional-only forms do not belong in it.
Use the right-hand form.

| Avoid | Use |
| --- | --- |
| 軟體 | 软件 |
| 網路 | 网络 |
| 資訊 | 信息 |
| 影片 | 视频 |
| 使用者 | 用户 |
| 預設 | 默认 |
| 設定 | 设置 |
| 資料 | 数据 |
| 專案 | 项目 |
| 支援 | 支持 |
| 登入 | 登录 |
| 登出 | 退出 |
| 伺服器 | 服务器 |
| 用戶端 | 客户端 |
| 列印 | 打印 |
| 快取 | 缓存 |
| 處理程序 | 进程 |
| 執行緒 | 线程 |
| 記憶體 | 内存 |
| 滑鼠 | 鼠标 |
| 電子郵件 | 邮件 |
| 授權 | 许可证 |
| 陣列 | 数组 |
| 物件 | 对象 |
| 字串 | 字符串 |
| 布林 | 布尔 |
| 函式 | 函数 |
| 變數 | 变量 |
| 載入 | 加载 |
| 建立 | 创建 |
| 刪除 | 删除 |
| 重新整理 | 刷新 |
| 當機 | 崩溃 |
| 品質 | 质量 |
| 視訊會議 | 视频会议 |

Wording rules:

- No bare praise such as `简单`, `轻松`, `强大`, `无缝`.
- No vague time words such as `目前`, `最近`, `最新`, `即将`.
- No bare `发生错误` without a cause and a next step.
- No stacked hedging, no transliteration of a protected name, and no full-width
  alphanumerics.

## Style

- A command or identifier inside a sentence uses ASCII double quotes
  (`"jouzu keybindings apply"`). The `ja` and `zh-Hant` catalogs use ASCII
  backticks. Preserve the exact command bytes inside the punctuation.
- A label ends with the full-width `：`, where `zh-Hant` uses an ASCII colon.
  Punctuation only; no protected value changes.
- Values use full-width CJK punctuation (`，` `。` `：` `；` `（）`) and single
  ASCII spaces, with no hard wrap. The renderer owns line breaking.
- A sentence keeps its placeholders (`{ $name }`) and select variants exactly as
  the English source has them.
