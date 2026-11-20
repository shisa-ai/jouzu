# Traditional Chinese glossary for the Jouzu CLI catalog

The `zh-Hant` catalog is a Traditional Chinese draft and is not offered as an
interface language. Translate from the English source rather than converting
the Simplified Chinese (`zh-Hans`) catalog.

## Source

Use `packages/cli/locales/en/*.ftl` as the source and
`packages/cli/locales/catalog-status.json` for its recorded metadata. Run
`node scripts/catalog-digest.mjs` to inspect the catalog digests. Compare draft
wording with the source whenever the English messages change.

## Vocabulary

The right column is the preferred form. The left column is the English term in
the source catalog.

| English | Traditional Chinese |
| --- | --- |
| error | 錯誤 |
| warning | 警告 |
| recovery | 復原 |
| profile | 設定檔 |
| settings | 設定 |
| catalog | 目錄 |
| offering | 供應項目 |
| source | 來源 |
| endpoint | 端點 |
| token | 權杖 |
| bearer | bearer |
| credential | 認證資訊 |
| authentication | 驗證 |
| authorization | 授權 |
| provider | 供應商 |
| model | 模型 |
| session | 工作階段 |
| workspace | 工作區 |
| keybinding | 按鍵綁定 |
| context | 內容 |
| content | 內容 |
| compaction | 壓縮 |
| agent | 代理程式 |
| subagent | 子代理 |
| run | 執行 |
| task | 工作 |
| job | 作業 |
| loop | 迴圈 |
| goal | 目標 |
| flow control | 流程控制 |
| receipt | 收據 |
| attachment | 附加項目 |
| deferred | 延後 |
| update | 更新 |
| self-update | 自我更新 |
| rollback | 復原 |
| backup | 備份 |
| stale | 過期 |
| fallback | 備援 |
| quarantine | 隔離 |
| lock | 鎖定 |
| file | 檔案 |
| directory | 目錄 |
| string | 字串 |
| object | 物件 |
| array | 陣列 |
| boolean | 布林 |
| integer | 整數 |
| cache | 快取 |
| process | 處理程序 |
| default | 預設 |
| user | 使用者 |
| enable | 啟用 |
| disable | 停用 |
| refresh | 重新整理 |
| save | 儲存 |
| load | 載入 |
| remove | 移除 |
| delete | 刪除 |
| create | 建立 |
| sign in | 登入 |
| sign out | 登出 |
| retry | 重試 |
| crash | 當機 |
| microphone | 麥克風 |
| screenshot | 螢幕擷取畫面 |
| terminal | 終端機 |

## Protected names

These stay in their original form in every locale. A translator must never
render them in Chinese. The shared record is
[`localization-glossary.md`](localization-glossary.md); this list names the
entries the `zh-Hant` catalog uses and points to that page for the full set.

- Product and command names: `Jouzu`, `jouzu`, `jz`, `Pi`, `pi`, `Shisa`,
  `TextGuard`, `Camoufox`, `Jouzu Palette`, `Palette`, `Session UI`,
  `Jouzu Help`, `Workflow`, `Settings`, `Catalogs`, `Models`, `About`,
  `Dashboard`, `Parent Context`, `Subagent`, `Fetch URL`, `Search web`.
- Tool names and identifiers: `tff-fetch_url`, `tff-search_web`, and every
  model, provider, and source ID.
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
  `catalog.lock.json`, `models.json`, `auth.json`, `agents.json`.
- Locale tags and language values: `auto`, `en`, `ja`, `zh-Hans`, `zh-Hant`,
  `core`.
- The authentication scheme: `bearer` in prose and `Bearer` in the settings
  label. It is a protocol name, not a vocabulary word, so it stays Latin.
- Environment variables: `JOUZU_NO_CLEAR`, `SHISA_API_KEY`, `NO_COLOR`,
  `TERM`, `LC_ALL`, `LC_MESSAGES`, `LANG`.
- Paths, URLs, HTTP status codes, exit codes, digests, and version strings.
- Key names: `Ctrl+L`, `Ctrl+C`, `Tab`, `Shift+Tab`, `Enter`, `Control+Up`,
  `ctrl+enter`, and the `Kitty` and `modifyOtherKeys` protocol names.

## Forbidden words

Use the right-hand form. The left-hand forms are Simplified Chinese or
mainland-only usage and do not belong in this catalog.

| Avoid | Use |
| --- | --- |
| 软件 | 軟體 |
| 网络 | 網路 |
| 信息 | 資訊 |
| 视频 | 影片 |
| 用户 | 使用者 |
| 默认 | 預設 |
| 设置 | 設定 |
| 数据 | 資料 |
| 项目 | 專案 |
| 支持 | 支援 |
| 登录 | 登入 |
| 退出 | 登出 |
| 服务器 | 伺服器 |
| 客户端 | 用戶端 |
| 打印 | 列印 |
| 缓存 | 快取 |
| 进程 | 處理程序 |
| 线程 | 執行緒 |
| 内存 | 記憶體 |
| 鼠标 | 滑鼠 |
| 邮件 | 電子郵件 |
| 许可证 | 授權 |
| 数组 | 陣列 |
| 对象 | 物件 |
| 字符串 | 字串 |
| 布尔 | 布林 |
| 函数 | 函式 |
| 变量 | 變數 |
| 加载 | 載入 |
| 创建 | 建立 |
| 删除 | 刪除 |
| 刷新 | 重新整理 |
| 崩溃 | 當機 |
| 质量 | 品質 |
| 视频会议 | 視訊會議 |

## Style

- A command or identifier inside a sentence is wrapped in ASCII backticks, the
  same convention the Japanese catalog uses, so the protected value is not
  confused with prose.
- Values use full-width CJK punctuation (`，` `。` `:` `；` `（）`) and single
  ASCII spaces, with no hard wrap. The renderer owns line breaking.
- A sentence keeps its placeholders (`{ $name }`) and select variants exactly as
  the English source has them.
