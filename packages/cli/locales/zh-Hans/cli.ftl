# Simplified Chinese (zh-Hans) catalog for the Jouzu CLI.
#
# Same message IDs, arguments, and types as `en/cli.ftl`. Terminology follows the
# Simplified Chinese glossary for this locale, and protected values follow the
# shared four-locale record in docs/localization-glossary.md.
#
# Draft, not reviewed. This is a first-pass translation. The safety,
# authentication, billing, privacy, destructive-operation, recovery, and
# accessibility text is not approved for user-facing use until a person reviews
# it, so the support stage stays English and Japanese. See docs/localization.md
# for the review requirements before offering an additional interface language.
#
# This catalog was written as Simplified Chinese. It was not produced by
# converting the zh-Hant catalog, and it must not be converted into it.
#
jouzu-cli-error-piImport = Jouzu Pi 导入失败：{ $message }
jouzu-cli-error-keybindingConflict = { $plan }
jouzu-cli-error-keybindingConflict-recovery = 请先解决上述冲突，然后再次运行 "jouzu keybindings apply"。
jouzu-cli-error-keybindingConfig = Jouzu 按键绑定失败：{ $message }
jouzu-cli-error-profileState = 无法读取 Jouzu 配置档案状态：{ $message }
jouzu-cli-error-profileState-recovery = 恢复：修复或删除配置档案状态文件，然后再次运行 "jouzu profile plan" 和 "jouzu profile apply"。
jouzu-cli-error-profileConflict = { $plan }
jouzu-cli-error-profileConflict-recovery = 请先解决上述冲突，然后再次运行 "jouzu profile apply"。
jouzu-cli-error-usage = 错误：{ $message }
jouzu-cli-error-usage-hint = 运行 "jouzu --help" 查看 Jouzu 用法，或运行 "jouzu pi --help" 查看 Pi 用法。
jouzu-cli-error-generic = Jouzu 执行失败：{ $message }
jouzu-cli-error-update = Jouzu 更新失败：{ $message }
jouzu-cli-args-optionValueRequired = { $option } 需要一个值
jouzu-cli-args-internalParserError = { $option } 的内部解析器错误
jouzu-cli-args-catalogOperationRequired = catalog 需要 "status"、"refresh"、"accept"、"validate" 或 "conformance" 之一
jouzu-cli-args-catalogAcceptOptionsRequireValues = catalog accept 的选项需要值
jouzu-cli-args-catalogUnknownAcceptOption = 未知的 catalog accept 选项：{ $option }
jouzu-cli-args-catalogAcceptUsage = catalog accept 需要 <revision> --digest <sha256> [--source <source-id>]
jouzu-cli-args-catalogFileRequired = catalog { $operation } 需要一个文件路径以及可选的 --json
jouzu-cli-args-catalogUnknownOption = 未知的 catalog { $operation } 选项：{ $token }
jouzu-cli-args-selfUpdateOperationRequired = self-update 需要 "status"、"check"、"apply" 或 "policy" 之一
jouzu-cli-args-selfUpdatePolicyRequired = self-update 策略必须是 auto-restart、notify 或 off 之一
jouzu-cli-args-selfUpdatePolicySingleValue = self-update 策略只接受一个值
jouzu-cli-args-selfUpdateUnknownOption = 未知的 self-update { $operation } 选项：{ $token }
jouzu-cli-args-keybindingsOperationRequired = keybindings 需要 "status"、"plan"、"apply" 或 "reset" 之一
jouzu-cli-args-keybindingsUnknownOption = 未知的 keybindings { $operation } 选项：{ $token }
jouzu-cli-args-profileMixedSelection = 请使用 profile --profile <core|ja>，不要与 --jouzu-profile 混用
jouzu-cli-args-profileOperationRequired = profile 需要 "plan" 或 "apply"
jouzu-cli-args-profileRepeatedOption = --profile 只能指定一次
jouzu-cli-args-profileInvalidId = --profile 必须是以下之一：{ $values }
jouzu-cli-args-profileRepeatedJson = --json 只能指定一次
jouzu-cli-args-profileUnknownOption = 未知的 profile { $operation } 选项：{ $token }
jouzu-cli-args-homeRepeated = --jouzu-home 只能指定一次
jouzu-cli-args-launchProfileRepeated = --jouzu-profile 只能指定一次
jouzu-cli-args-launchProfileInvalidId = --jouzu-profile 必须是以下之一：{ $values }
jouzu-cli-args-uiLocaleRepeated = --jouzu-ui-locale 只能指定一次
jouzu-cli-args-uiLocaleInvalid = --jouzu-ui-locale 必须是以下之一：{ $values }
jouzu-cli-args-textguardRepeated = { $option } 只能指定一次
jouzu-cli-args-unknownJouzuOption = 未知的 Jouzu 选项：{ $token }
jouzu-cli-args-textguardOffStrict = --jouzu-textguard-off 与 --jouzu-textguard-strict 不能同时使用
jouzu-cli-args-textguardOffFiles = --jouzu-textguard-off 与 --jouzu-textguard-files 不能同时使用
jouzu-cli-args-doctorUnexpectedToken = doctor 不接受 { $token }
jouzu-cli-args-versionHelpArguments = { $command } 不接受参数；Pi 请使用 "jouzu pi { $command }"

# Pre-launch help, version, doctor, and report text.
# Help messages are complete semantic units. The renderer owns wrapping and
# alignment; command and key arguments stay intact.

jouzu-cli-help-title = Jouzu 智能体式 AI 环境
jouzu-cli-help-usageHeading = 用法：
jouzu-cli-help-commandsHeading = 命令：
jouzu-cli-acp-model = 模型
jouzu-cli-acp-reject = 拒绝
jouzu-cli-acp-formUnavailable = 此 ACP 主机不支持表单输入，已取消对话框。
jouzu-cli-help-command-acp = 通过标准输入输出提供 Agent Client Protocol 服务
jouzu-cli-help-command-doctor = 显示不修改任何内容的运行时与隔离诊断
jouzu-cli-help-command-catalog = 检查可选的目录设置，或验证目录文件
jouzu-cli-help-command-profilePlan = 在不写入的情况下预览 Core/JA 配置档案的安全更改
jouzu-cli-help-command-profileApply = 应用所选配置档案，并处理冲突和备份
jouzu-cli-help-command-keybindings = 检查、应用或重置 Jouzu 的 Pi 兼容默认按键
jouzu-cli-help-command-selfUpdate = 检查、确认、应用或配置 Jouzu 的 npm 更新
jouzu-cli-help-command-pi = 将所有剩余参数显式传递给固定的 Pi
jouzu-cli-help-textguard-scanning = 默认情况下，TextGuard 在本地扫描技能和网页内容。
jouzu-cli-help-textguard-handling = 被标记的网页结果会以不可信数据的标记送达模型；被标记的技能会一直保留，直到你批准它们。
jouzu-cli-help-textguard-controls = 在交互式会话中使用 "{ $reviewCommand }" 查看检测结果，并使用 "{ $onCommand }"、"{ $strictCommand }" 或 "{ $offCommand }" 更改该会话的扫描。
jouzu-cli-help-option-textguardStrict = 保留所有被标记的输入，直到获得批准
jouzu-cli-help-option-textguardOff = 启动时关闭扫描
jouzu-cli-help-option-textguardFiles = 同时扫描普通读取工具的内容
jouzu-cli-help-option-uiLocale = UI 语言；auto 跟随操作系统区域设置
jouzu-cli-help-footer-alias = "{ $alias }" 命令的行为与 "{ $command }" 完全相同。
jouzu-cli-help-footer-resume = 使用退出时显示的 "{ $command }" 命令恢复会话；Jouzu 会解析自己独立的会话根目录。
jouzu-cli-help-footer-profile = 首次交互式启动会在启用可选的 JA 配置档案前询问；Core 是回退选项。
jouzu-cli-help-footer-startup = 交互式启动会清空视口并显示 Jouzu 页眉；设置 "{ $setting }" 可保留现有屏幕。
jouzu-cli-help-footer-palette = 通过 "{ $command }" 或 { $key } 打开 Jouzu Palette。
jouzu-cli-help-footer-catalogs = "{ $command }" 直接打开 Settings / Catalogs。
jouzu-cli-help-footer-sections = 在浏览模式下，{ $nextKey } 或 { $previousKey } 切换 Palette 分区。
jouzu-cli-help-footer-pi = Pi CLI 帮助请使用 "{ $command }"。

jouzu-cli-version-jouzu = jouzu { $version }
jouzu-cli-version-pi = pi { $version }
jouzu-cli-version-profileSchema = 配置档案架构 { $version }
jouzu-cli-localization-future = Jouzu 本地化设置使用 schemaVersion { $version }，此版本无法识别；将使用英文并保持文件不变。
jouzu-cli-localization-invalid = 无法使用 Jouzu 本地化设置（{ $reason }）；将使用英文并保持文件不变。

# Localization and context-policy diagnostics.
# A damaged or hand-edited settings file reaches these. The settings keys, the
# schema version, the byte limits, and the token bounds stay protected values;
# the numeric ones are passed as strings so Fluent never adds grouping
# separators.

jouzu-cli-localization-config-notInspected = 无法检查本地化设置
jouzu-cli-localization-config-notRegularFile = 本地化设置必须是常规文件
jouzu-cli-localization-config-tooLarge = 本地化设置超过 { $maxBytes } 字节
jouzu-cli-localization-config-invalidJson = 本地化设置不是有效的 JSON：{ $message }
jouzu-cli-localization-config-notObject = 本地化设置必须是对象
jouzu-cli-localization-config-unknownFields = 本地化设置包含未知字段
jouzu-cli-localization-config-schemaVersionInvalid = 本地化设置的 schemaVersion 无效
jouzu-cli-localization-config-localizationNotObject = 本地化设置必须包含 localization 对象
jouzu-cli-localization-config-unknownLocalizationFields = 本地化设置包含未知的 localization 字段
jouzu-cli-localization-uiLocaleNotString = localization.uiLocale 必须是字符串
jouzu-cli-localization-uiLocaleUnsupported = localization.uiLocale 不是受支持的 UI 区域设置：{ $value }
jouzu-cli-localization-osCandidateUnsupported = 不支持的操作系统区域设置候选：{ $candidate }
jouzu-cli-localization-lockNotRegularFile = localization.lock 不是常规锁文件
jouzu-cli-localization-lockBusy = 另一个本地化设置保存正在进行中
jouzu-cli-localization-responseLanguageNotString = localization.responseLanguage 必须是字符串
jouzu-cli-localization-responseLanguageUnsupported = localization.responseLanguage 不是受支持的响应语言：{ $value }
jouzu-cli-localization-artifactPolicyNotObject = localization.artifactPolicy 必须是对象
jouzu-cli-localization-artifactPolicyFieldInvalid = localization.artifactPolicy.{ $field } 不是受支持的成果物语言：{ $value }

# The trusted project policy is read from `<repository root>/.jouzu/localization.json`.
# A repository whose trust cannot be established is never read, so these reasons
# only appear for a repository the runtime reported as trusted.

jouzu-cli-projectPolicy-notInspected = 无法检查项目语言策略
jouzu-cli-projectPolicy-notRegularFile = 项目语言策略必须是常规文件
jouzu-cli-projectPolicy-tooLarge = 项目语言策略超过 { $maxBytes } 字节
jouzu-cli-projectPolicy-invalidJson = 项目语言策略不是有效的 JSON：{ $message }
jouzu-cli-projectPolicy-notObject = 项目语言策略必须是对象
jouzu-cli-projectPolicy-artifactPolicyNotObject = 项目语言策略的 localization.artifactPolicy 必须是对象

jouzu-cli-context-policy-notBoundedFile = 上下文策略必须是有大小限制的常规文件
jouzu-cli-context-policy-notObject = 上下文策略必须是对象
jouzu-cli-context-policy-unknownKeys = 上下文策略包含未知键：{ $keys }
jouzu-cli-context-policy-schemaVersionRequired = 上下文策略需要 schemaVersion { $version }
jouzu-cli-context-policy-maxTokensRange = 上下文策略的 maxContextTokens 必须是 { $min } 到 { $max } 之间的整数

jouzu-cli-report-problem = 问题
jouzu-cli-report-problems = 问题
jouzu-cli-report-warning = 警告
jouzu-cli-report-warnings = 警告

jouzu-cli-doctor-title = Jouzu 诊断
jouzu-cli-doctor-notes = 说明
jouzu-cli-doctor-hint = 运行 "jz doctor --json" 可获得相同报告的 JSON 版本，或运行 "jz catalog status" 查看目录详情。
jouzu-cli-doctor-upstreamConstraint = 上游文本约束：固定的 Pi 和第三方捆绑扩展渲染自己的英文，Jouzu 不翻译也不替换；Jouzu 自有的浏览器适配器则从 Jouzu 目录渲染其工具标签。无法检查的表面保持未验证状态，不计为已翻译。当 Pi 固定版本或某个扩展版本变化时需重新检查。
jouzu-cli-doctor-section-runtime = 运行时
jouzu-cli-doctor-section-catalog = 模型目录
jouzu-cli-doctor-section-platform = 平台
jouzu-cli-doctor-section-localization = 本地化
jouzu-cli-doctor-section-upstream = 上游边界
jouzu-cli-doctor-section-roots = 根目录
jouzu-cli-doctor-section-profile = 配置档案
jouzu-cli-doctor-field-jouzu-version = Jouzu 版本
jouzu-cli-doctor-field-pi-runtime = Pi 运行时
jouzu-cli-doctor-field-pi-upstream = Pi 上游
jouzu-cli-doctor-field-pi-packageSource = Pi 包来源
jouzu-cli-doctor-field-pi-qualification = Pi 资格
jouzu-cli-doctor-field-profile-schema = 配置档案架构
jouzu-cli-doctor-field-extensions-releaseOwned = 发布方拥有的扩展
jouzu-cli-doctor-field-skills-packageOwned = 包拥有的技能
jouzu-cli-doctor-field-extensions-compatibilityDependencies = 兼容性依赖
jouzu-cli-doctor-field-camoufox-runtime = 可选的 Camoufox 运行时
jouzu-cli-doctor-field-update-installChannel = 安装方式
jouzu-cli-doctor-field-update-policy = 自我更新策略
jouzu-cli-doctor-field-update-channel = 自我更新渠道
jouzu-cli-doctor-field-update-startupEligible = 启动时自动更新
jouzu-cli-doctor-field-update-lastCheckedAt = 上次更新检查
jouzu-cli-doctor-field-update-latestVersion = 最近观察到的 Jouzu
jouzu-cli-doctor-field-keybindings-status = 按键绑定默认值
jouzu-cli-doctor-field-keybindings-policy = 按键绑定策略
jouzu-cli-doctor-field-keybindings-followUpKey = Jouzu 默认后续键
jouzu-cli-doctor-field-keybindings-dequeueKey = Jouzu 默认出队键
jouzu-cli-doctor-field-keybindings-configPath = 按键绑定配置
jouzu-cli-doctor-field-executable = 可执行文件
jouzu-cli-doctor-field-catalog-sources = 活动目录
jouzu-cli-doctor-field-catalog-offerings = 提供项
jouzu-cli-doctor-field-catalog-registration = 模型注册
jouzu-cli-doctor-field-catalog-thinkingLevels = 思考级别
jouzu-cli-doctor-field-platform = 平台
jouzu-cli-doctor-field-node = Node
jouzu-cli-doctor-field-locale = 区域设置
jouzu-cli-doctor-field-git = Git
jouzu-cli-doctor-field-bash = Bash
jouzu-cli-doctor-field-npm = npm
jouzu-cli-doctor-field-proxy = 已配置代理
jouzu-cli-doctor-field-extraCaCerts = 已配置额外 CA
jouzu-cli-doctor-field-localization-requested = 请求的 UI 区域设置
jouzu-cli-doctor-field-localization-effective = 生效的 UI 区域设置
jouzu-cli-doctor-field-localization-source = UI 区域设置来源
jouzu-cli-doctor-field-localization-fallback = UI 区域设置回退原因
jouzu-cli-doctor-field-localization-catalogVersion = UI 目录版本
jouzu-cli-doctor-field-localization-catalogDigest = UI 目录摘要
jouzu-cli-doctor-field-localization-catalogFallback = UI 目录回退原因
jouzu-cli-doctor-field-localization-catalogState = UI 目录支持状态
jouzu-cli-doctor-field-localization-supportStates = 已记录的 UI 目录状态
jouzu-cli-doctor-field-language-responseLanguage-requested = 请求的响应语言
jouzu-cli-doctor-field-language-responseLanguage-effective = 生效的响应语言
jouzu-cli-doctor-field-language-responseLanguage-source = 响应语言来源
jouzu-cli-doctor-field-language-artifactPolicy-requested = 请求的成果物策略
jouzu-cli-doctor-field-language-artifactPolicy-effective = 生效的成果物策略
jouzu-cli-doctor-field-language-artifactPolicy-source = 成果物策略来源
jouzu-cli-doctor-field-language-projectPolicy = 项目语言策略
jouzu-cli-doctor-field-upstream-surfaces-total = 记录的表面
jouzu-cli-doctor-field-upstream-surfaces-translated = 已翻译的表面
jouzu-cli-doctor-field-upstream-surfaces-upstreamOwned = 上游拥有的表面
jouzu-cli-doctor-field-upstream-surfaces-notInspected = 未检查的表面
jouzu-cli-doctor-field-upstream-surfaces-outOfScope = 范围外的表面
jouzu-cli-doctor-field-upstream-supportStage = 支持阶段
jouzu-cli-doctor-field-paths-agentDir = 代理/配置根目录
jouzu-cli-doctor-field-paths-stateDir = 状态根目录
jouzu-cli-doctor-field-paths-sessionDir = 会话根目录
jouzu-cli-doctor-field-paths-cacheDir = 缓存根目录
jouzu-cli-doctor-field-modelPicker-state = 模型选择器状态
jouzu-cli-doctor-field-isolation-piAgentDir = 已替换的 Pi 代理根目录
jouzu-cli-doctor-field-isolation-piSessionDir = 已替换的 Pi 会话根目录
jouzu-cli-doctor-field-skills-shared = 跨 harness 共享技能
jouzu-cli-doctor-field-profile-selected = 所选配置档案
jouzu-cli-doctor-field-profile-bundledManifest = 捆绑的配置档案清单
jouzu-cli-doctor-field-profile-appliedManifest = 已应用的配置档案清单
jouzu-cli-doctor-field-packages-count = 已配置的 Pi 包
jouzu-cli-doctor-field-provider-authFile = 提供方认证文件
jouzu-cli-doctor-field-provider-modelsFile = 自定义模型文件
jouzu-cli-doctor-field-provider-environment = 提供方环境
jouzu-cli-doctor-field-lock-profile = 配置档案锁
jouzu-cli-doctor-field-lock-piImport = Pi 导入锁
jouzu-cli-doctor-field-lock-keybindings = 按键绑定锁
jouzu-cli-doctor-field-lock-modelPicker = 模型选择器锁
jouzu-cli-doctor-field-lock-update = 更新锁
jouzu-cli-doctor-field-lock-camoufoxRuntime = Camoufox 运行时安装锁

# Doctor diagnoses. Each message is rebuilt from its ID at render time so
# the `doctor --json` report keeps the English machine text it has always had.
# Values such as counts, source IDs, diagnostics, and command names are passed
# as arguments and stay protected.
jouzu-cli-doctor-warning-providerUnconfigured = 未找到明确的提供方凭据或自定义模型配置；请使用 /login 或提供方环境变量
jouzu-cli-doctor-warning-profileNotApplied = 所选配置档案尚未应用；请运行 "jouzu profile apply"
jouzu-cli-doctor-warning-profileDrift = 已应用的配置档案与捆绑清单不同；请运行 "jouzu profile plan"
jouzu-cli-doctor-warning-packagesNotArray = settings.json 的 packages 不是数组
jouzu-cli-doctor-warning-packagesUnparseable = 无法解析 settings.json
jouzu-cli-doctor-warning-updateLastFailed = 上次 Jouzu 更新操作失败（{ $code }）
jouzu-cli-doctor-warning-updateStatusUnavailable = 自我更新状态不可用：{ $diagnostic }
jouzu-cli-doctor-warning-keybindingsConflict = Jouzu 按键绑定默认值与用户绑定冲突；请运行 "jouzu keybindings plan"
jouzu-cli-doctor-warning-keybindingsStatusUnavailable = 按键绑定状态不可用：{ $diagnostic }
jouzu-cli-doctor-warning-catalogStatusUnavailable = 目录状态不可用：{ $diagnostic }
jouzu-cli-doctor-warning-catalogRegistration = { $total } 个提供项中有 { $complete } 个带有新模型所需的字段（{ $gaps }）。{ $effect } 运行 "jz catalog status { $sourceId }" 查看列表。
jouzu-cli-doctor-warning-catalogThinkingLevels = { $total } 个提供项中有 { $count } 个未声明思考级别，因此 Jouzu 无法控制其推理投入。运行 "jz catalog status { $sourceId }" 查看列表。
jouzu-cli-doctor-warning-modelPickerUnreadable = 模型选择器状态无法读取：{ $message }

# Doctor problems. Same render-time mechanism as the warnings, so the
# `doctor --json` report keeps its English machine text while the human text
# localizes. Values such as a version, a lock status, a diagnostic, an error
# list, and a path are passed as arguments and stay protected.
jouzu-cli-doctor-problem-nodeUnsupported = Node { $version } 不受支持；Jouzu 需要 >=22.19.0
jouzu-cli-doctor-problem-gitMissing = 在 PATH 上未找到 Git
jouzu-cli-doctor-problem-bashMissing = 未找到 Bash；请安装 Bash 或 Git Bash
jouzu-cli-doctor-problem-npmMissing = 在 PATH 上未找到 npm；Jouzu 更新需要 npm
jouzu-cli-doctor-problem-piVersionMismatch = 固定的 Pi { $pinned } 与已加载的运行时 { $loaded } 不匹配
jouzu-cli-doctor-problem-piRuntimeUnavailable = 无法加载 Pi 运行时：{ $diagnostic }
jouzu-cli-doctor-problem-piLockUnqualified = Pi 锁状态为 { $status }，未通过资格检查
jouzu-cli-doctor-problem-extensionsUnavailable = 必需的发布扩展不可用：{ $errors }
jouzu-cli-doctor-problem-extensionsOptionalUnavailable = 可选的发布扩展不可用：{ $failures }。请修正报告的平台或包错误，然后重新运行 `jz doctor`。
jouzu-cli-doctor-problem-extensionsDisabledTools = ；已禁用的工具：{ $tools }
jouzu-cli-doctor-problem-extensionsManifestInvalid = 发布扩展清单不可用：{ $diagnostic }
jouzu-cli-doctor-problem-camoufoxRuntimeInvalid = 可选的 Camoufox 运行时在 { $path } 处无效；请删除该目录，然后重试浏览器工具
jouzu-cli-doctor-problem-lockUnreadable = 无法检查某个状态锁：{ $path }
jouzu-cli-doctor-problem-lockStale = 残留的状态锁阻止了 Jouzu 操作：{ $path }（{ $status }）

jouzu-cli-catalog-title = Jouzu 模型目录
jouzu-cli-catalog-title-plural = Jouzu 模型目录
jouzu-cli-catalog-sourcesActive = { $configured } 个源中有 { $active } 个活动
jouzu-cli-catalog-notes = 说明
jouzu-cli-catalog-hint = 运行 "jz catalog status <source-id>" 查看单个源，或加上 --json 查看存储的记录。
jouzu-cli-catalog-unconfigured = 未配置模型目录端点。Jouzu 继续使用 Pi 和本地模型配置。
jouzu-cli-catalog-state-unconfigured = 未配置
jouzu-cli-catalog-state-empty = 空
jouzu-cli-catalog-state-active = 活动
jouzu-cli-catalog-state-stale = 残留
jouzu-cli-catalog-state-degraded = 降级
jouzu-cli-catalog-problem = 问题
jouzu-cli-catalog-problems = 问题
jouzu-cli-catalog-warning = 警告
jouzu-cli-catalog-warnings = 警告
jouzu-cli-catalog-field-endpoint = 端点
jouzu-cli-catalog-field-catalog = 目录
jouzu-cli-catalog-field-models = 模型
jouzu-cli-catalog-field-registration = 注册
jouzu-cli-catalog-field-thinkingLevels = 思考级别
jouzu-cli-catalog-field-revision = 修订
jouzu-cli-catalog-field-sequence = 序号
jouzu-cli-catalog-field-validated = 已验证
jouzu-cli-catalog-field-credential = 凭据
jouzu-cli-catalog-field-quarantined = 已隔离的候选
jouzu-cli-catalog-field-lastError = 上次错误
jouzu-cli-catalog-valid = 模型目录有效。
jouzu-cli-catalog-invalid = 模型目录无效：{ $message }
jouzu-cli-catalog-note-tokenMissing = 令牌变量 { $name } 未设置，且此源未保存令牌；在可用之前会跳过刷新。
jouzu-cli-catalog-note-registrationGaps = { $total } 个提供项中有 { $complete } 个带有新模型所需的字段（{ $gaps }）。{ $effect }
jouzu-cli-catalog-note-thinkingLevels = { $total } 个提供项中有 { $count } 个未声明级别，因此 Jouzu 无法控制其推理投入。
jouzu-cli-catalog-note-quarantined = { $count } 个候选修订已隔离。
jouzu-cli-catalog-field-registrationValue = { $total } 个提供项中有 { $complete } 个带有新模型所需的字段
jouzu-cli-catalog-field-thinkingLevelsValue = { $total } 个提供项中有 { $count } 个未声明级别
jouzu-cli-catalog-credential-environmentSet = 环境变量 { $name }（已设置）
jouzu-cli-catalog-credential-savedToken = 已保存的令牌（环境变量 { $name } 未设置）
jouzu-cli-catalog-credential-environmentNotSet = 环境变量 { $name }（未设置）
jouzu-cli-catalog-status-disabled = 已禁用
jouzu-cli-catalog-sourceNotFound = 未找到目录源：{ $id }
jouzu-cli-catalog-tokenMissing = 目录令牌变量 { $name } 未在此 Jouzu 进程中设置。请在启动 Jouzu 前导出它，或在 Settings / Catalogs 中保存令牌，然后重试。
jouzu-cli-catalog-tokenMissingWithSaved = 目录令牌变量 { $name } 未在此 Jouzu 进程中设置，且此源未保存令牌。请在启动 Jouzu 前导出它，或在 Settings / Catalogs 中保存令牌，然后重试。
jouzu-cli-catalog-attempt-http = HTTP { $status }
jouzu-cli-catalog-attempt-timedOut = 已超时
jouzu-cli-catalog-discovery-authFailed = 目录认证失败（HTTP { $status }）。如果此目录需要，请配置 bearer 令牌认证。
jouzu-cli-catalog-discovery-accessDenied = 目录访问被拒绝（HTTP { $status }）。如果此目录需要，请配置 bearer 令牌认证。
jouzu-cli-catalog-discovery-authFailedBearer = 目录认证失败（HTTP { $status }）。请检查 { $name } 或此源保存的令牌是否包含目录接受的 bearer 令牌。
jouzu-cli-catalog-discovery-accessDeniedBearer = 目录访问被拒绝（HTTP { $status }）。请检查 { $name } 或此源保存的令牌是否包含目录接受的 bearer 令牌。
jouzu-cli-catalog-insecureTransport = 此目录使用 HTTP，因此其 bearer 令牌以明文发送，可能被网络上的他人读取。如果目录支持，请使用 HTTPS。
jouzu-cli-catalog-registrationEffect = Pi 尚未提供的模型的提供项会被丢弃，因此该模型永远不会出现在模型列表中。
jouzu-cli-catalog-registrationGap-field = 无 { $field }
jouzu-cli-catalog-registrationGap-count = { $count } 个无 { $field }
jouzu-cli-catalog-registrationGap-detail = { $model } — { $gap }
jouzu-cli-catalog-registrationField-textModality = 文本输入
jouzu-cli-catalog-registrationField-contextWindow = 上下文窗口
jouzu-cli-catalog-registrationField-maxOutputTokens = 最大输出令牌数
jouzu-cli-catalog-listSeparator = ,{" "}

# Catalog source configuration validation, endpoint discovery, and sync
# failure text. A source id, a field name, an index, a URL, a media type, and an
# HTTP status are protected values passed as arguments; the sentence around them
# resolves from the session bundle. The English values are byte-identical to the
# literals they replace.

jouzu-cli-catalogSource-context-source = 目录源 { $index }
jouzu-cli-catalogSource-context-sourceAuth = 目录源 { $index }.auth
jouzu-cli-catalogSource-context-sourceLabel = 目录源 { $index } 标签
jouzu-cli-catalogSource-context-sourceLabelBare = 目录源标签
jouzu-cli-catalogSource-context-override = 目录源覆盖 { $id }
jouzu-cli-catalogSource-context-registry = 目录源注册表
jouzu-cli-catalogSource-context-overrides = 目录源覆盖
jouzu-cli-catalogSource-context-credentials = 目录凭据
jouzu-cli-catalogSource-context-url = 目录源 URL
jouzu-cli-catalogSource-context-token = 目录令牌
jouzu-cli-catalogSource-context-tokenFor = { $id } 的目录令牌
jouzu-cli-catalogSource-unknownField = { $context } 包含未知字段：{ $field }
jouzu-cli-catalogSource-notObject = { $context } 必须是对象
jouzu-cli-catalogSource-notBoundedText = { $context } 必须非空、有大小限制且不含控制字符
jouzu-cli-catalogSource-invalidSourceId = 目录源 id 必须使用 1-64 个小写字母、数字、点、短横线或下划线
jouzu-cli-catalogSource-urlAbsolute = 目录源 URL 必须是绝对 HTTP(S) URL 或主机
jouzu-cli-catalogSource-urlCredentials = 目录源 URL 不得包含凭据
jouzu-cli-catalogSource-urlQueryOrFragment = 目录源 URL 不得包含查询或片段
jouzu-cli-catalogSource-urlScheme = 目录源 URL 必须使用 HTTP 或 HTTPS
jouzu-cli-catalogSource-authBearerCredentialRef = { $context } 的 bearer 认证需要环境凭据引用
jouzu-cli-catalogSource-authInvalidCredentialRef = { $context } 的环境凭据引用无效
jouzu-cli-catalogSource-authType = { $context }.type 必须是 none 或 bearer
jouzu-cli-catalogSource-sourceNotObject = 目录源 { $index } 必须是对象
jouzu-cli-catalogSource-sourceRequiresFields = 目录源 { $index } 需要 id、label 和 url 字符串
jouzu-cli-catalogSource-sourceEnabledBoolean = 目录源 { $index }.enabled 必须是布尔值
jouzu-cli-catalogSource-registryNotObject = 目录源注册表必须是对象
jouzu-cli-catalogSource-registrySchema = 目录源注册表需要 schemaVersion 1 和 sources 数组
jouzu-cli-catalogSource-registryNotRegularFile = 目录源注册表必须是有大小限制的常规文件
jouzu-cli-catalogSource-duplicateId = 重复的目录源 id：{ $id }
jouzu-cli-catalogSource-duplicateUrl = 重复的目录源 URL：{ $url }
jouzu-cli-catalogSource-overrideNotObject = 目录源覆盖 { $id } 必须是对象
jouzu-cli-catalogSource-overrideEnabledBoolean = 目录源覆盖 { $id }.enabled 必须是布尔值
jouzu-cli-catalogSource-overridesNotObject = 目录源覆盖必须是对象
jouzu-cli-catalogSource-overridesSchema = 目录源覆盖需要 schemaVersion 1 和 overrides 对象
jouzu-cli-catalogSource-overridesNotRegularFile = 目录源覆盖必须是有大小限制的常规文件
jouzu-cli-catalogSource-credentialsNotObject = 目录凭据必须是对象
jouzu-cli-catalogSource-credentialsSchema = 目录凭据需要 schemaVersion 1 和 tokens 对象
jouzu-cli-catalogSource-credentialsNotRegularFile = 目录凭据必须是有大小限制的常规文件
jouzu-cli-catalogSource-tokenNotString = { $id } 的目录令牌必须是字符串
jouzu-cli-catalogSource-builtinImmutableEdit = 无法编辑内置的 { $label } 目录源；它只能被启用或禁用
jouzu-cli-catalogSource-builtinImmutableRemove = 无法移除内置的 { $label } 目录源；它只能被启用或禁用
jouzu-cli-catalogSource-reservedId = 源 id "{ $id }" 为内置的 Shisa API 目录保留（{ $url }，env:{ $env }）；此条目指向别处，因此内置源保持非活动状态
jouzu-cli-catalogSource-signedOut = 已退出 Shisa。运行 /login shisa 重新连接。
jouzu-cli-catalogSource-discoveryCanceled = 目录端点发现已取消。
jouzu-cli-catalogSource-unsupportedContentType = 不支持的 Content-Type { $mediaType }
jouzu-cli-catalogSource-mediaTypeMissing = 缺失
jouzu-cli-catalogSource-attemptValid = 有效
jouzu-cli-catalogSource-responseTooLarge = 目录响应超过 16 MiB
jouzu-cli-catalogSource-noCatalogFound = 未找到 Jouzu 目录。尝试：{ $attempts }

# Catalog sync failure text. A state-lock status word and an HTTP status
# are protected values passed as arguments.
jouzu-cli-catalog-sync-refreshBusy = 模型目录刷新正忙（{ $status }）
jouzu-cli-catalog-sync-operationBusy = 模型目录操作正忙（{ $status }）
jouzu-cli-catalog-sync-authFailed = 目录认证失败（HTTP 401）。请重新登录，或更新此源保存的令牌或环境凭据。
jouzu-cli-catalog-sync-accessDenied = 目录访问被拒绝（HTTP 403）。请与服务运营方核对此账户的目录访问权限。
jouzu-cli-catalog-sync-proxyAuth = 代理要求认证（HTTP 407）。请检查你的代理凭据和配置。
jouzu-cli-catalog-sync-httpError = 目录端点返回 HTTP { $status }
jouzu-cli-catalog-sync-noActiveAccount = 没有活动的目录账户

# The interactive Pi configuration import prompt and its output. A file
# name, a path, and an error detail are protected values passed as arguments.
jouzu-cli-piImport-questionModels = 在 { $path } 找到现有的 Pi 自定义模型。{"\u000A"}要将 models.json 复制到 Jouzu 的隔离配置吗？Pi 源不会被更改。[y/N]{" "}
jouzu-cli-piImport-questionAuth = 在 { $path } 找到已保存的 Pi 提供方凭据。{"\u000A"}要将 auth.json 复制到 Jouzu 的私有配置吗？Pi 源不会被更改。[y/N]{" "}
jouzu-cli-piImport-invalidSource = 未导入现有的 Pi { $filename }，因为它不是常规 JSON 对象。
jouzu-cli-piImport-imported = 已将 { $filename } 导入 Jouzu。
jouzu-cli-piImport-skipped = 已跳过 { $filename }，因为 Jouzu 已有一个。
jouzu-cli-piImport-importFailed = 无法导入 { $filename }：{ $detail }
jouzu-cli-piImport-lockBusy = 另一个 Pi 导入决策正在进行中

# Catalog failure explanations and locale-selection fallback reasons.
# The failure code stays the identity of a refresh result; only the
# explanation is catalog text, so a resolved catalog renders it in the active
# locale while `--json` and the stored record keep the English value.
jouzu-cli-catalog-failure-dnsHostname = 无法解析目录主机名。请检查端点、DNS 和 VPN 连接。
jouzu-cli-catalog-failure-dnsLookup = 目录 DNS 查找暂时失败。请检查网络连接并重试。
jouzu-cli-catalog-failure-connectionRefused = 目录连接被拒绝。请检查端点和代理地址。
jouzu-cli-catalog-failure-connectionReset = 目录连接被重置。请检查连接以及任何代理或安全软件。
jouzu-cli-catalog-failure-connectionClosed = 目录连接意外关闭。请检查连接和代理配置。
jouzu-cli-catalog-failure-networkUnreachable = 目录网络不可达。请检查网络、VPN 和代理配置。
jouzu-cli-catalog-failure-hostUnreachable = 目录主机不可达。请检查网络、VPN 和代理配置。
jouzu-cli-catalog-failure-timeout = 目录请求超时。请检查连接和代理配置，然后重试。
jouzu-cli-catalog-failure-connectTimeout = 连接目录超时。请检查连接和代理配置。
jouzu-cli-catalog-failure-headersTimeout = 目录未及时发送响应头。请重试或检查目录服务。
jouzu-cli-catalog-failure-bodyTimeout = 目录响应停滞。请重试或检查目录服务。
jouzu-cli-catalog-failure-networkPermission = 连接目录的权限被拒绝。请检查本机的出站网络策略。
jouzu-cli-catalog-failure-redirectBlocked = 目录重定向了该请求。请使用其最终端点 URL；Jouzu 不会跨重定向转发目录凭据。
jouzu-cli-catalog-failure-filesystem = Jouzu 无法读写其本地目录数据（{ $code }）。请检查 Jouzu 数据文件夹的权限、可用空间，以及是否有其他程序正在使用它。
jouzu-cli-catalog-failure-certificate = 目录证书验证失败（{ $code }）。请检查系统时钟和受信任证书，包括任何组织代理证书。不要禁用证书验证。
jouzu-cli-catalog-failure-network = 目录请求失败。请检查端点、网络连接、代理环境变量和受信任证书。
jouzu-cli-catalog-failure-cache = Jouzu 无法访问其本地目录数据。请检查 Jouzu 数据文件夹并重试。
jouzu-cli-catalog-sourceNotFoundOrDisabled = 未找到目录源或已禁用：{ $id }
jouzu-cli-catalog-fallback-noCatalog = "{ $requested }" 没有目录（规范区域设置 "{ $canonical }"）；将使用英文
jouzu-cli-catalog-fallback-unsupported = 不支持的区域设置 "{ $requested }"；将使用英文
jouzu-cli-catalog-fallback-canonical = "{ $requested }" 没有精确目录；将使用规范区域设置 "{ $canonical }"

jouzu-cli-keybindings-title = Jouzu 按键绑定计划
jouzu-cli-keybindings-notes = 说明
jouzu-cli-keybindings-plan = 计划
jouzu-cli-keybindings-desired = 期望的绑定
jouzu-cli-keybindings-actions = 操作
jouzu-cli-keybindings-field-policy = 策略
jouzu-cli-keybindings-field-config = 配置
jouzu-cli-keybindings-noChanges = 无需更改按键绑定。
jouzu-cli-keybindings-applied = 已应用按键绑定事务：{ $id }
jouzu-cli-keybindings-reset = 已重置按键绑定事务：{ $id }
jouzu-cli-keybindings-alreadyConverged = 按键绑定默认值已收敛。
jouzu-cli-keybindings-alreadyDisabled = 按键绑定默认值已禁用。
jouzu-cli-keybindings-backup = 备份：{ $path }

# Keybindings.json and keybindings-state.json validation. The file names,
# an action id, and a JSON error detail are protected values or arguments.
jouzu-cli-keybindings-config-notRegularFile = keybindings.json 必须是常规文件
jouzu-cli-keybindings-config-invalidJson = keybindings.json 不是有效的 JSON：{ $detail }
jouzu-cli-keybindings-config-notObject = keybindings.json 必须是对象
jouzu-cli-keybindings-config-bindingInvalid = keybindings.json 中 { $action } 的绑定必须是按键或按键数组
jouzu-cli-keybindings-state-notRegularFile = 按键绑定状态必须是常规文件
jouzu-cli-keybindings-state-invalidJson = 按键绑定状态不是有效的 JSON：{ $detail }
jouzu-cli-keybindings-state-notObject = 按键绑定状态必须是对象
jouzu-cli-keybindings-state-fieldsInvalid = 按键绑定状态字段无效
jouzu-cli-keybindings-state-insertedNotObject = 按键绑定状态中插入的绑定必须是对象
jouzu-cli-keybindings-state-insertedInvalid = 按键绑定状态中插入的绑定无效或重复

jouzu-cli-profile-title = Jouzu 配置档案计划
jouzu-cli-profile-section = 配置档案
jouzu-cli-profile-actions = 操作
jouzu-cli-profile-field-manifest = 清单
jouzu-cli-profile-field-agentRoot = 代理根目录
jouzu-cli-profile-noChanges = 无需更改配置档案。
jouzu-cli-profile-applied = 已应用事务：{ $id }
jouzu-cli-profile-alreadyConverged = 配置档案已收敛
jouzu-cli-profile-backups = 备份：{ $path }

# Profile-state and saved-profile-choice validation. A path and a JSON
# error detail are protected values passed as arguments.
jouzu-cli-profile-state-notRegularFile = 配置档案状态必须是常规文件：{ $path }
jouzu-cli-profile-state-invalidJson = { $path } 处的配置档案状态不是有效的 JSON：{ $detail }
jouzu-cli-profile-state-notObject = 配置档案状态必须是对象
jouzu-cli-profile-state-unknownFields = 配置档案状态包含未知字段
jouzu-cli-profile-state-fieldsInvalid = { $path } 处的配置档案状态字段无效
jouzu-cli-profile-state-targetNotObject = 配置档案状态中受管理的目标必须是对象
jouzu-cli-profile-state-targetInvalid = 配置档案状态中受管理的目标无效或重复
jouzu-cli-profile-choice-notRegularFile = 配置档案选择必须是常规文件
jouzu-cli-profile-choice-invalidJson = 配置档案选择不是有效的 JSON：{ $detail }
jouzu-cli-profile-choice-notObject = 配置档案选择必须是对象
jouzu-cli-profile-choice-unknownFields = 配置档案选择包含未知字段
jouzu-cli-profile-choice-fieldsInvalid = 配置档案选择字段无效
jouzu-cli-profile-japaneseEnabled = 已启用日语支持。
jouzu-cli-profile-coreFallback = 继续使用 Core 配置档案。

jouzu-cli-selfUpdate-title = Jouzu 自我更新状态
jouzu-cli-selfUpdate-policy = 策略：{ $value }
jouzu-cli-selfUpdate-installChannel = 安装方式：{ $value }
jouzu-cli-selfUpdate-automatic = 启动时自动更新：{ $value }
jouzu-cli-selfUpdate-installed = 已安装版本：{ $version }
jouzu-cli-selfUpdate-latest = 最近观察到的版本：{ $value }
jouzu-cli-selfUpdate-lastResult = 上次结果：{ $value }
jouzu-cli-selfUpdate-lastChecked = 上次检查：{ $value }
jouzu-cli-selfUpdate-nextCheck = 下次检查：{ $value }
jouzu-cli-selfUpdate-lastUpdated = 上次更新：{ $value }
jouzu-cli-selfUpdate-previous = 上一个版本：{ $value }
jouzu-cli-selfUpdate-lastError = 上次错误：{ $value }
jouzu-cli-selfUpdate-value-eligible = 符合条件
jouzu-cli-selfUpdate-value-notEligible = 不符合条件
jouzu-cli-selfUpdate-value-notChecked = 未检查
jouzu-cli-selfUpdate-value-never = 从未
jouzu-cli-selfUpdate-value-due = 到期
jouzu-cli-selfUpdate-value-none = 无
jouzu-cli-selfUpdate-available = Jouzu { $version } 可用（已安装 { $installed }）
jouzu-cli-selfUpdate-current = Jouzu { $installed } 已是最新（最新 { $latest }）
jouzu-cli-selfUpdate-applied = 已将 Jouzu 更新到 { $version }。重启 Jouzu 以使用新版本。
jouzu-cli-selfUpdate-alreadyCurrent = Jouzu { $version } 已是最新。
jouzu-cli-selfUpdate-policySet = Jouzu 自我更新策略：{ $policy }
jouzu-cli-selfUpdate-restarting = 已将 Jouzu 从 { $from } 更新到 { $to }；正在重启…

# Self-update failure and recovery text. An npm command name, an exit
# status or error code, a version, and an npm error message are protected values
# passed as arguments.
jouzu-cli-selfUpdate-unsupportedChannel = 自动安装仅适用于真正的全局 npm 安装；请通过各自的安装方式更新此源码、本地或 npx 调用
jouzu-cli-selfUpdate-npmCommandFailed = { $operation } 失败（{ $code }）
jouzu-cli-selfUpdate-npmCommandExit = { $operation } 失败（npm 退出码 { $status }）
jouzu-cli-selfUpdate-integrityMismatch = 下载的更新未通过 SHA-512 验证
jouzu-cli-selfUpdate-updateRolledBack = Jouzu { $version } 未通过验证，已恢复 { $current }
jouzu-cli-selfUpdate-updateNotInstalled = 未安装 Jouzu { $version }；{ $current } 仍保持验证通过
jouzu-cli-selfUpdate-rollbackFailed = Jouzu 更新和自动回滚均失败；请使用 npm 重新安装上一个 Jouzu 版本
jouzu-cli-selfUpdate-restartFailed = 更新后的 Jouzu 无法重启：{ $message }
jouzu-cli-selfUpdate-invalidPolicy = 未知的更新策略：{ $policy }
jouzu-cli-selfUpdate-updateFailed = Jouzu 更新失败
jouzu-cli-selfUpdate-checkFailed = 更新检查失败

# Jouzu renderer startup notice, banner labels, help overlay, and the
# first-run profile prompt. A banner hint holds only the label because the
# renderer joins the hints with its own separator; an overlay value keeps the
# two-space alignment as a `{" "}` literal, so the catalog value itself has no
# run of spaces. The startup notice is the same message whether the model
# catalog refresh succeeds or fails; a damaged locale catalog falls back to
# this English text through `resolveCatalog`.

jouzu-cli-presentation-startupNotice = 正在获取模型目录…
jouzu-cli-presentation-bannerHint-model = { $command } 选择
jouzu-cli-presentation-bannerHint-hotkeys = { $command } 快捷键
jouzu-cli-presentation-bannerHint-status = { $command } 会话

jouzu-cli-help-overlay-title = Jouzu Help
jouzu-cli-help-overlay-models = { $key }{" "} 模型
jouzu-cli-help-overlay-cycleFavorites = { $key }{" "} 循环收藏
jouzu-cli-help-overlay-help = { $key }{" "} 帮助
jouzu-cli-help-overlay-allShortcuts = { $command }{" "} 所有快捷键
jouzu-cli-help-overlay-sessionDetails = { $command }{" "} 会话详情
jouzu-cli-help-overlay-runtimeBuilds = { $command }{" "} 运行时与已安装构建
jouzu-cli-help-overlay-agentsRuns = { $command }{" "} 代理与运行
jouzu-cli-help-overlay-childDashboard = { $command }{" "} 子运行仪表板
jouzu-cli-help-overlay-close = { $key } 关闭
jouzu-cli-help-overlay-shortcutSeparator = {" "}或{" "}
jouzu-cli-help-overlay-shortcutDescription = 打开 Jouzu 帮助

jouzu-cli-profile-choice-intro = Jouzu 可以添加一个可选的日语支持配置档案，包含面向日语的指令和技能。
jouzu-cli-profile-choice-conflict = 在 Jouzu 写入任何内容之前，会先检查现有配置档案文件是否存在冲突。
jouzu-cli-profile-choice-question = 启用日语支持？ / 日本語サポートを有効にしますか？ [y/N]

# The remaining pre-launch literals. The doctor field values are status
# and channel words a user reads, so they are text; the report keeps the English
# value and the human renderer resolves the same ID in the active locale. The
# `--json` fields stay English in every locale.

jouzu-cli-doctor-note-isolation = 隔离：不会导入 Pi 的库存全局配置、认证、包和会话。项目资源和 ~/.agents/skills 仍作为共享的 Pi 兼容表面保留。
jouzu-cli-doctor-value-unavailable = 不可用
jouzu-cli-doctor-value-upstreamSupportStage = Jouzu 自有的 UI 提供英语和日语，Jouzu 自有的浏览器适配器从 Jouzu 目录渲染其工具标签。固定的 Pi 和第三方捆绑扩展渲染自己的英文。
jouzu-cli-doctor-value-other = 其他
jouzu-cli-doctor-value-globalNpmInstall = 全局 npm 安装
jouzu-cli-doctor-value-localNpmInstall = 本地 npm 安装
jouzu-cli-doctor-value-npxInstall = npx 安装
jouzu-cli-doctor-value-sourceCheckout = 源码检出
jouzu-cli-doctor-value-complete = 完整
jouzu-cli-doctor-value-noActiveCatalog = 无活动目录
jouzu-cli-doctor-value-camoufoxNotInstalled = 未安装；首次使用浏览器工具时安装
jouzu-cli-doctor-value-ready = 就绪
jouzu-cli-doctor-value-invalid = 无效
jouzu-cli-doctor-value-notFound = 未找到
jouzu-cli-doctor-value-notSet = 未设置
jouzu-cli-doctor-value-notDetected = 未检测到
jouzu-cli-doctor-value-notApplied = 未应用
jouzu-cli-doctor-value-never = 从未
jouzu-cli-doctor-value-notChecked = 未检查
jouzu-cli-doctor-value-eligible = 符合条件
jouzu-cli-doctor-value-notEligible = 不符合条件
jouzu-cli-doctor-value-none = 无
jouzu-cli-doctor-value-unreadable = 无法读取
jouzu-cli-doctor-value-absent = 不存在
jouzu-cli-doctor-value-present = 存在
jouzu-cli-doctor-value-yes = 是
jouzu-cli-doctor-value-no = 否
jouzu-cli-doctor-value-lockFree = 空闲
jouzu-cli-doctor-value-lockHeldLive = 被活动进程持有（{ $age }）
jouzu-cli-doctor-value-lockHeldDead = 由已终止的进程遗留（{ $age }；{ $recover } 后可恢复）
jouzu-cli-doctor-value-lockOwnerUnknown = 所有者未知（{ $age }；{ $recover } 后可恢复）
jouzu-cli-doctor-value-lockUnreadable = 无法读取（锁检查失败）
jouzu-cli-doctor-value-lockInvalid = 无效（不是常规锁文件）
jouzu-cli-doctor-value-nodeSupported = { $version }（受支持）
jouzu-cli-doctor-value-nodeUnsupported = { $version }（不受支持）
jouzu-cli-doctor-value-extensionsReleaseOwned = 已选 { $selected }；就绪 { $ready }；可选不可用 { $optional }
jouzu-cli-doctor-value-extensionsReleaseOwnedRequired = 已选 { $selected }；就绪 { $ready }；可选不可用 { $optional }；必需项不可用
jouzu-cli-doctor-value-skillsPackageOwned = 已选 { $selected }；就绪 { $ready }
jouzu-cli-doctor-value-compatibilityDependencies = 已选 { $selected }
jouzu-cli-doctor-value-catalogRegistration = { $total } 个提供项中有 { $complete } 个可以添加模型
jouzu-cli-doctor-value-catalogThinkingLevels = { $total } 个提供项中有 { $count } 个未声明级别
jouzu-cli-doctor-value-catalogSource = { $offerings } 个提供项 · { $complete } 个可以添加模型 · { $levels } 个无思考级别
jouzu-cli-doctor-value-modelPicker = { $defaults } 个项目默认；{ $favorites } 个收藏；{ $recents } 个全局最近；{ $scopes } 个项目范围
jouzu-cli-doctor-value-skillsSharedPresent = { $path }（存在）
jouzu-cli-doctor-value-skillsSharedAbsent = { $path }（不存在）

jouzu-cli-keybindings-portability-ctrlEnter = ctrl+enter 需要终端通过 Kitty 键盘协议或 modifyOtherKeys 报告带修饰的 Enter 键
jouzu-cli-keybindings-portability-ctrlUp = ctrl+up 需要终端报告带修饰的方向键；tmux 用户应启用 extended-keys 并设置 extended-keys-format csi-u
jouzu-cli-keybindings-portability-macMissionControl = 在更改系统快捷键之前，macOS 可能会将 Control+Up 保留给 Mission Control
jouzu-cli-keybindings-portability-termDumb = TERM=dumb 无法提供可靠的交互式按键事件
jouzu-cli-keybindings-status-uninitialized = 未初始化
jouzu-cli-keybindings-status-converged = 已收敛
jouzu-cli-keybindings-status-customized = 已自定义
jouzu-cli-keybindings-policy-applied = 已应用
jouzu-cli-keybindings-policy-disabled = 已禁用
jouzu-cli-keybindings-policy-unset = 未设置
jouzu-cli-keybindings-binding-piDefault = Pi 默认或未绑定
jouzu-cli-keybindings-binding-unbound = 未绑定
jouzu-cli-keybindings-upgradeRemoved = Jouzu 移除了 { $action } 之前的 { $previous } 绑定，因为 { $desired } 已分配给 { $conflictingAction }；请运行 `jz keybindings plan`。
jouzu-cli-keybindings-bootstrapFailed = 未应用 Jouzu 按键绑定默认值：{ $message }

jouzu-cli-selfUpdate-report-downloading = 正在下载 Jouzu { $version }…
jouzu-cli-selfUpdate-report-installing = 正在安装 Jouzu { $version }…
jouzu-cli-selfUpdate-report-restoring = Jouzu { $version } 未通过验证；正在恢复 { $current }…
jouzu-cli-selfUpdate-report-statusUnrecorded = Jouzu 已更新并通过验证，但无法记录其更新状态。
jouzu-cli-selfUpdate-startup-skipped = 已跳过自动更新：{ $message }
jouzu-cli-selfUpdate-startup-checkFailed = Jouzu 更新检查失败；继续使用 { $current }（{ $code }）
jouzu-cli-selfUpdate-startup-available = Jouzu { $version } 可用；请运行 "jouzu self-update apply"
jouzu-cli-selfUpdate-startup-failed = Jouzu 更新失败；继续使用 { $current }（{ $code }）

jouzu-cli-selfUpdate-policyValue-autoRestart = auto-restart
jouzu-cli-selfUpdate-policyValue-notify = notify
jouzu-cli-selfUpdate-policyValue-off = off
jouzu-cli-selfUpdate-channelValue-globalNpm = global-npm
jouzu-cli-selfUpdate-channelValue-localNpm = local-npm
jouzu-cli-selfUpdate-channelValue-ephemeralNpx = ephemeral-npx
jouzu-cli-selfUpdate-channelValue-source = source
jouzu-cli-selfUpdate-channelValue-other = other

jouzu-cli-usage-pinnedPiSelfUpdate = Jouzu 固定了其 Pi 运行时，无法运行 Pi 自我更新。请改为升级 Jouzu；`jz update --extensions` 等仅更新包的操作仍然可用。
jouzu-cli-usage-catalogAcceptRevisionDigest = catalog accept 需要确切的修订和摘要
jouzu-cli-usage-catalogFileRequired = catalog { $operation } 需要一个文件路径
jouzu-cli-usage-selfUpdatePolicyValue = self-update 策略需要一个值

jouzu-cli-runtime-piLoadFailed = Jouzu 无法加载其固定的 Pi 运行时：{ $diagnostic }
jouzu-cli-runtime-piLoadFailedUnavailable = Jouzu 无法加载其固定的 Pi 运行时：不可用
jouzu-cli-runtime-piPinMismatch = 已加载的 Pi { $loaded } 与 Jouzu 的精确固定版本 { $pinned } 不匹配

jouzu-cli-catalog-fileNotFound = 目录文件不存在：{ $path }
jouzu-cli-catalog-fileNotRegular = 目录路径必须是常规文件：{ $path }

jouzu-cli-work-withheldRequest = 已保留的请求
jouzu-cli-work-outcomeUnknown = 结果未知
jouzu-cli-work-jobExit = 退出码 { $code }

# Palette key-bar actions and shared view labels. The key itself is a resolved
# binding injected at render time; only the action label is catalog text.
jouzu-cli-palette-value-unknown = 未知
jouzu-cli-palette-action-refresh = 刷新
jouzu-cli-palette-action-favorite = 收藏
jouzu-cli-palette-action-compactAndSwitch = 压缩并切换
jouzu-cli-palette-action-cancel = 取消
jouzu-cli-palette-action-selectAndSaveForProject = 选择并为项目保存
jouzu-cli-palette-action-cursor = 光标
jouzu-cli-palette-action-move = 移动
jouzu-cli-palette-action-section = 分区
jouzu-cli-palette-action-browse = 浏览
jouzu-cli-palette-action-search = 搜索
jouzu-cli-palette-action-close = 关闭
jouzu-cli-palette-action-view = 视图
jouzu-cli-palette-action-edit = 编辑
jouzu-cli-palette-action-change = 更改
jouzu-cli-palette-action-toggle = 切换
jouzu-cli-palette-action-back = 返回
jouzu-cli-palette-action-next = 下一个
jouzu-cli-palette-action-previous = 上一个
jouzu-cli-palette-action-confirm = 确认
jouzu-cli-palette-action-newline = 换行
jouzu-cli-palette-action-returnToForm = 返回表单

# The Models view.
jouzu-cli-modelPicker-refreshingCatalog = 正在刷新模型目录…
jouzu-cli-modelPicker-filterNotSaved = 筛选选择未保存：{ $message }
jouzu-cli-modelPicker-modelUnavailable = 此模型不可用。请检查其提供方或目录凭据。
jouzu-cli-modelPicker-compactAndSwitch = 压缩活动上下文并切换到 { $model }？
jouzu-cli-modelPicker-statePreserved = 无法读取的模型选择器状态已保留在 { $path }
jouzu-cli-modelPicker-filter-recent = 最近
jouzu-cli-modelPicker-filter-favorite = 收藏
jouzu-cli-modelPicker-filter-all = 全部
jouzu-cli-modelPicker-section-current = 当前
jouzu-cli-modelPicker-section-previous = 上一个
jouzu-cli-modelPicker-section-favorite = 收藏
jouzu-cli-modelPicker-section-project = 项目
jouzu-cli-modelPicker-section-recent = 最近
jouzu-cli-modelPicker-section-all = 全部
jouzu-cli-modelPicker-title-confirm = 确认
jouzu-cli-modelPicker-title-search = 搜索
jouzu-cli-modelPicker-detail = { $name } · 上下文 { $context } · 最大 { $max }{ $default }
jouzu-cli-modelPicker-projectDefault = 项目默认
jouzu-cli-modelPicker-refreshTimeout = 模型刷新超时；正在显示缓存的模型。
jouzu-cli-modelPicker-refreshFailed = 模型刷新失败；正在显示缓存的模型：{ $detail }
jouzu-cli-modelPicker-catalogRefreshed = 模型目录已刷新。
jouzu-cli-modelPicker-catalogRefreshTimeout = 模型目录刷新超时；正在显示缓存的模型。
jouzu-cli-modelPicker-catalogRefreshFailed = 模型目录刷新失败；正在显示缓存的模型：{ $detail }
jouzu-cli-modelPicker-compacting = 正在压缩，然后切换到 { $model }…
jouzu-cli-modelPicker-selecting = 正在选择 { $model }…
jouzu-cli-modelPicker-favoriteAdded = 已将 { $model } 添加到收藏。
jouzu-cli-modelPicker-favoriteRemoved = 已从收藏中移除 { $model }。
jouzu-cli-modelPicker-catalogsNotRefreshed = 未刷新目录：{ $sources }。缓存的目录数据仍然可用。打开 Catalogs 以重试。
jouzu-cli-modelPicker-catalogsWereNotRefreshed = 未刷新目录：{ $message } 缓存的目录数据仍然可用。打开 Catalogs 以重试。
jouzu-cli-modelPicker-modelAvailabilityNotRefreshed = 未刷新模型可用性：{ $message } 请运行 /reload。
jouzu-cli-modelPicker-switchQueued = 模型切换已排队，将在下一次模型调用时生效：{ $model }。
jouzu-cli-modelPicker-thinkingLevelNotApplied = 未应用已保存的思考级别：{ $message }
jouzu-cli-modelPicker-catalogSettingsRequireTui = 目录设置需要交互式 TUI 模式。
jouzu-cli-modelPicker-modelsNotRefreshed = 未刷新模型：{ $message } 打开 Models 以重试。
jouzu-cli-modelPicker-providersNotRefreshed = 未刷新模型提供方：{ $providers }。打开 Models 以重试。
jouzu-cli-modelPicker-startup-projectDefault = 项目默认
jouzu-cli-modelPicker-startup-lastUsed = 上次使用的模型
jouzu-cli-modelPicker-startup-unavailable = { $label } 不可用：{ $model }
jouzu-cli-modelPicker-startup-notAuthenticated = { $label } 未认证：{ $model }
jouzu-cli-modelPicker-startup-notApplied = 未应用 { $label }：{ $message }
jouzu-cli-modelPicker-thinkingLevelNotSaved = 未保存思考级别：{ $message }
jouzu-cli-modelPicker-recencyNotSaved = 未保存模型最近使用记录：{ $message }
jouzu-cli-modelPicker-switchedTo = 已切换到 { $model }。
jouzu-cli-modelPicker-queuedSwitchFailed = 排队的模型切换失败：{ $message }
jouzu-cli-modelPicker-modelSelectBinding = 模型选择绑定
jouzu-cli-modelPicker-favoriteSwitchInProgress = 收藏模型切换已在进行中。
jouzu-cli-modelPicker-noFavoriteModelsAdd = 没有收藏模型。使用 { $key } 打开 Models，在某个模型上按 { $toggle } 添加。
jouzu-cli-modelPicker-noFavoriteModelsAvailable = 当前模型范围内没有可用的收藏模型。
jouzu-cli-modelPicker-noFavoriteFits = 没有收藏模型能放入活动上下文。使用 { $key } 打开 Models 以压缩并切换。
jouzu-cli-modelPicker-onlyOneFavorite = 只有一个收藏模型可用。
jouzu-cli-modelPicker-favoriteUnavailable = 收藏模型不可用：{ $model }
jouzu-cli-modelPicker-noAuthentication = { $model } 没有认证
jouzu-cli-modelPicker-favoriteSwitchFailed = 收藏模型切换失败：{ $message }
jouzu-cli-modelPicker-favoritesUsage = Jouzu 使用 Favorites 进行快速切换。使用 { $key } 打开 Models，在某个模型上按 { $toggle } 将其加入收藏。
# The Models row markers and the picker's empty state, plus the three error
# sentences a `catch` passes to `ctx.ui.notify(…, "error")`. The leading space of
# a row marker is part of the value, written as a `{" "}` literal; a
# provider/model identifier arrives as a protected argument.
jouzu-cli-modelPicker-row-unavailable = {" "}不可用
jouzu-cli-modelPicker-row-contextSmall = {" "}上下文过小
jouzu-cli-modelPicker-empty = 没有匹配的模型
jouzu-cli-modelPicker-catalogDisabled = 所选模型目录已禁用或不可用。打开 Models 选择一个模型。
jouzu-cli-modelPicker-modelUnavailableDetail = 模型不可用：{ $model }
jouzu-cli-modelPicker-noAuthenticationCredential = { $model } 没有认证。打开 Catalogs 检查其凭据。
# The Models view's remaining failure text. A selection callback throws the first
# sentence to the picker's message area, and a refresh callback throws the last
# two as the `{ $detail }` of a refresh failure. Provider/model identifiers are
# protected arguments.
jouzu-cli-modelPicker-waitForActiveCall = 等待活动的模型调用结束，然后压缩并切换。
jouzu-cli-modelPicker-refreshUnavailable = 模型刷新不可用
jouzu-cli-modelPicker-refreshAborted = 模型刷新已中止
jouzu-cli-modelPicker-refreshFailedProviders = 无法刷新 { $providers }
jouzu-cli-modelPicker-modelsNotRefreshedDetail = 未刷新模型：{ $message }
jouzu-cli-modelPicker-providersNotRefreshedDetail = 未刷新模型提供方：{ $providers }
jouzu-cli-modelPicker-catalogsNotRefreshedDetail = 未刷新目录：{ $message }
jouzu-cli-modelPicker-catalogIgnored = 已忽略缓存的模型目录：{ $message }
jouzu-cli-modelPicker-runtimeDiagnosticsUnavailable = 运行时诊断不可用。

# The Workflow view's rows and confirmations.
jouzu-cli-workflow-row-subagents = 子代理
jouzu-cli-workflow-row-concurrency = 并发
jouzu-cli-workflow-row-childWriters = 子写入者
jouzu-cli-workflow-row-addAgent = + 添加代理
jouzu-cli-workflow-row-roleId = 角色 ID
jouzu-cli-workflow-row-description = 描述
jouzu-cli-workflow-row-model = 模型
jouzu-cli-workflow-row-placement = 放置
jouzu-cli-workflow-row-reviewOnly = 仅审查
jouzu-cli-workflow-row-childTools = 子工具
jouzu-cli-workflow-row-thinking = 思考
jouzu-cli-workflow-row-timeoutSeconds = 超时（秒）
jouzu-cli-workflow-row-maximumTurns = 最大轮数
jouzu-cli-workflow-row-instructions = 指令
jouzu-cli-workflow-row-save = 保存
jouzu-cli-workflow-row-useInMainSession = 在主会话中使用
jouzu-cli-workflow-row-launchAgent = 启动代理…
jouzu-cli-workflow-row-duplicateAsNewAgent = 复制为新代理
jouzu-cli-workflow-row-deleteDefinition = 删除定义…
jouzu-cli-workflow-row-deleteConfirm = 删除 { $agent }？现有运行会保留。
jouzu-cli-workflow-row-cancel = 取消
jouzu-cli-workflow-row-sameAsThisSession = 与此会话相同
jouzu-cli-workflow-row-assignment = 任务分配
jouzu-cli-workflow-row-workspace = 工作区
jouzu-cli-workflow-row-readOutput = 读取输出
jouzu-cli-workflow-row-sendMessage = 发送消息…
jouzu-cli-workflow-row-stopAgent = 停止代理…
jouzu-cli-workflow-row-stopConfirm = 停止 { $agent }？已做出的更改会保留。
jouzu-cli-workflow-row-resumeWithTask = 带任务恢复…
jouzu-cli-workflow-row-backToRuns = 返回运行列表
jouzu-cli-workflow-confirm-disableSubagents = 禁用子代理并停止此会话中所有排队和运行中的子代理？已做出的更改会保留。

# The rest of the Workflow view's display: the stage suffixes, the section and
# group headings, the field values, and the panel's status and error text. The
# mode and section values (`browse`, `agents`, `runs`, `parallel`) are internal
# identities that stay in code; only the display word is catalog text. Counts
# and resolved bindings are passed as arguments.
jouzu-cli-workflow-stage-editAgent = 编辑代理
jouzu-cli-workflow-stage-chooseModel = 选择模型
jouzu-cli-workflow-stage-run = 运行
jouzu-cli-workflow-stage-output = 输出
jouzu-cli-workflow-stage-confirm = 确认
jouzu-cli-workflow-stage-editAssignment = 编辑任务分配
jouzu-cli-workflow-stage-editInstructions = 编辑指令
jouzu-cli-workflow-label-agents = 代理
jouzu-cli-workflow-label-runs = 运行
jouzu-cli-workflow-label-definition = 定义
jouzu-cli-workflow-label-setting = 设置
jouzu-cli-workflow-label-actions = 操作
jouzu-cli-workflow-label-models = 模型
jouzu-cli-workflow-label-task = 任务
jouzu-cli-workflow-value-on = 开
jouzu-cli-workflow-value-off = 关
jouzu-cli-workflow-value-yes = 是
jouzu-cli-workflow-value-no = 否
jouzu-cli-workflow-value-inParallel = 并行
jouzu-cli-workflow-value-oneAtATime = 一次一个
jouzu-cli-workflow-value-characters = { $count } 个字符
jouzu-cli-workflow-value-writeTask = 编写任务
jouzu-cli-workflow-value-unavailableSubagentsOff = 不可用：子代理已关闭
jouzu-cli-workflow-value-costUnknown = 成本未知
jouzu-cli-workflow-meta-thisSession = 此会话
jouzu-cli-workflow-meta-inSession = 在会话中
jouzu-cli-workflow-headingMeta-defined = 已定义 { $count } 个
jouzu-cli-workflow-headingMeta-runs = { $active ->
    [0] 会话中 { $count } 个
   *[other] { $active } 个运行中 · 会话中 { $count } 个
}
jouzu-cli-workflow-headingMeta-followsSessionModel = 跟随会话模型
jouzu-cli-workflow-headingMeta-more = 更多
jouzu-cli-workflow-action-enablingSubagents = 正在启用子代理
jouzu-cli-workflow-action-disablingSubagents = 正在禁用子代理
jouzu-cli-workflow-action-launchAgent = 启动代理
jouzu-cli-workflow-action-sendMessage = 发送消息
jouzu-cli-workflow-action-resumeAgent = 恢复代理
jouzu-cli-workflow-message-operationFailed = 操作失败。
jouzu-cli-workflow-message-operationFailedRetry = 操作失败。请重试。
jouzu-cli-workflow-message-couldNotLoad = 无法加载 Workflow。
jouzu-cli-workflow-message-childWritersParallel = 子写入者可能共享工作区；对同一文件的并发编辑可能冲突。
jouzu-cli-workflow-message-childWritersSerial = 子写入者按工作区一次运行一个。
jouzu-cli-workflow-hint-editAgent = 编辑代理
jouzu-cli-workflow-hint-inspectRun = 检查运行
jouzu-cli-workflow-empty-noMatchingModels = 没有匹配的模型。请修改搜索。
jouzu-cli-workflow-empty-noChildRuns = 此会话中没有子运行。

# The Workflow text that issue #53 moved off the `perform`, `openText`, and
# `detail` APIs. Those parameters take a catalog ID, so a literal sentence no
# longer type-checks at the call site. The run status and the context mode are
# protected values passed as arguments.
jouzu-cli-workflow-error-formUnavailable = Workflow 表单不可用。请取消并重新打开。
jouzu-cli-workflow-error-saveOrCancelEdits = 在使用此定义之前，请先保存或取消你的编辑。
jouzu-cli-workflow-error-subagentsOff = 子代理已关闭。在分配工作之前，请在 Workflow 中启用它们。
jouzu-cli-workflow-error-runNotFound = 未找到代理运行。
jouzu-cli-workflow-error-writeAssignment = 发送前请先编写任务分配。
jouzu-cli-workflow-message-running = { $label }…
jouzu-cli-workflow-message-complete = { $label } 完成。
jouzu-cli-workflow-message-saved = 已保存 { $agent }。
jouzu-cli-workflow-message-concurrencySet = 并发已设置为 { $value }。
jouzu-cli-workflow-title = · Workflow{ $stage }
jouzu-cli-workflow-title-busy = · 忙碌
jouzu-cli-workflow-hint-saveInForm = 只有在表单中点击 Save 才会保存更改。
jouzu-cli-workflow-stage-editWorkspace = 编辑工作区
jouzu-cli-workflow-action-applyingAgent = 正在应用代理
jouzu-cli-workflow-action-sendingTask = 正在发送任务
jouzu-cli-workflow-action-stoppingAgent = 正在停止代理
jouzu-cli-workflow-field-agent = 代理
jouzu-cli-workflow-field-model = 模型
jouzu-cli-workflow-field-workspace = 工作区
jouzu-cli-workflow-field-context = 上下文
jouzu-cli-workflow-field-context-lookupOn = { $mode } · 父级查找开
jouzu-cli-workflow-field-context-lookupOff = { $mode } · 父级查找关
jouzu-cli-workflow-field-modelId = 模型 ID
jouzu-cli-workflow-field-usage = 用量
jouzu-cli-workflow-field-result = 结果

# The TextGuard review view's other-list hints. The command name is a protected
# value passed as an argument, not catalog text.
jouzu-cli-textguard-otherView-decisions = 个项目需要决策 · { $command }
jouzu-cli-textguard-otherView-reports = 个检测结果未阻止任何内容 · { $command }
# The rest of the TextGuard review overlay: the decision actions, the mode
# confirmations, the severity and verdict lines, and the notification and
# approval sentences. The `/textguard` command, the finding kinds, and the
# severity values are protected values passed as arguments, never catalog text.
jouzu-cli-textguard-action-allowSession = 允许用于此会话
jouzu-cli-textguard-action-allowAlways = 始终允许此确切内容
jouzu-cli-textguard-action-dismiss = 关闭报告
jouzu-cli-textguard-action-enable = 重新开启扫描
jouzu-cli-textguard-action-back = 返回
jouzu-cli-textguard-mode-guarded = TextGuard 再次扫描。被标记的网页结果会以不可信数据的标记送达模型；被标记的技能会一直保留，直到你批准它们。
jouzu-cli-textguard-mode-strict = 现在 TextGuard 会保留所有被标记的输入，直到你用 { $command } 批准它。
jouzu-cli-textguard-mode-off = TextGuard 已为此会话关闭。在你运行 { $command } 之前，内容会未经扫描即被接受。
jouzu-cli-textguard-banner-strict = strict 模式 — 所有被标记的输入都会被保留
jouzu-cli-textguard-banner-off = 此会话已关闭扫描
jouzu-cli-textguard-severity-error = 错误（阻止此内容）
jouzu-cli-textguard-severity-warn = 警告
jouzu-cli-textguard-severity-info = 信息
jouzu-cli-textguard-finding-line = { $severity }：{ $name }{ $codepoint }。
jouzu-cli-textguard-finding-locatedLine = { $severity }：{ $name }{ $codepoint }，位于 { $location }。
jouzu-cli-textguard-counts-noErrors = 无错误
jouzu-cli-textguard-counts-blocking = { $count ->
    [one] { $count } 个错误，在你批准之前会阻止此内容
   *[other] { $count } 个错误，在你批准之前会阻止此内容
}
jouzu-cli-textguard-counts-delivered = { $count ->
    [one] { $count } 个错误级检测结果；内容已以不可信数据的标记送达模型
   *[other] { $count } 个错误级检测结果；内容已以不可信数据的标记送达模型
}
jouzu-cli-textguard-counts-warning = { $count ->
    [one] { $count } 个警告
   *[other] { $count } 个警告
}
jouzu-cli-textguard-counts-informational = { $count ->
    [one] { $count } 个信息级检测结果
   *[other] { $count } 个信息级检测结果
}
jouzu-cli-textguard-counts-nonBlockingBoth = { $blocking }；{ $warnings } 和 { $notes } 不会阻止它。
jouzu-cli-textguard-counts-nonBlockingWarnings = { $blocking }；{ $warnings } 不会阻止它。
jouzu-cli-textguard-counts-nonBlockingNotes = { $blocking }；{ $notes } 不会阻止它。
jouzu-cli-textguard-evidence-withheld = 除非你批准，否则此内容会一直保留。
jouzu-cli-textguard-evidence-delivered = 内容已以不可信数据的标记送达模型。
# The reason an incomplete check did not finish. The user reads these in the
# review overlay and the alert detail; the model reads a separate fixed English
# copy in the withheld-result tool result, so this block is the user-facing half.
jouzu-cli-textguard-unavailable-inputLimit = 内容大于 TextGuard 能扫描的范围
jouzu-cli-textguard-unavailable-unsupportedContent = 内容的一部分是扫描器无法检查的东西，例如图片
jouzu-cli-textguard-unavailable-findingLimit = 检测结果太多，无法完整报告
jouzu-cli-textguard-unavailable-decodeLimit = 内容包含过多编码层，无法完全解码
jouzu-cli-textguard-unavailable-outputLimit = 扫描器产生了过多输出
jouzu-cli-textguard-unavailable-scanner = 扫描器无法运行
jouzu-cli-textguard-unavailable-timeout = 扫描时间已用尽
jouzu-cli-textguard-unavailable-process = 扫描器意外停止
jouzu-cli-textguard-unavailable-version = 已安装的扫描器版本不受支持
jouzu-cli-textguard-unavailable-protocol = 扫描器返回了无法读取的结果
jouzu-cli-textguard-unavailable-busy = 扫描器正忙于其他工作
jouzu-cli-textguard-unavailable-closed = 审查会话已结束
jouzu-cli-textguard-unavailable-file = 内容无法读取
jouzu-cli-textguard-unavailable-budget = 为扫描预留的时间已用尽
jouzu-cli-textguard-evidence-unavailable = 检查未完成：{ $reason }。
# The alert detail a user reads: the same summary the model banner carries, but
# resolved from the catalog so it can localize.
jouzu-cli-textguard-detail-errors = { $count ->
    [one] { $count } 个错误级检测结果
   *[other] { $count } 个错误级检测结果
}
jouzu-cli-textguard-detail-errorsWithKinds = { $count ->
    [one] { $count } 个错误级检测结果（{ $kinds }）
   *[other] { $count } 个错误级检测结果（{ $kinds }）
}
jouzu-cli-textguard-detail-warnings = { $count ->
    [one] { $count } 个警告
   *[other] { $count } 个警告
}
jouzu-cli-textguard-detail-none = 无检测结果
jouzu-cli-textguard-detail-unavailable = 检查未完成：{ $reason }
jouzu-cli-textguard-detail-withheld = TextGuard 审查 — 已保留的内容
jouzu-cli-textguard-detail-delivered = TextGuard 审查 — 带检测结果送达
jouzu-cli-textguard-detail-report = TextGuard 审查 — 扫描报告
jouzu-cli-textguard-alert-advisoryReport = ；{ $command } 显示报告
jouzu-cli-textguard-alert-approveInteractive = 运行 { $command } 查看并批准它。
jouzu-cli-textguard-alert-approveNonInteractive = 在交互式会话中用 { $command } 批准它。
jouzu-cli-textguard-alert-notApprovable = 此内容无法批准；请重试请求。
jouzu-cli-textguard-review-pending = 使用 { $command } 查看。
jouzu-cli-textguard-review-pendingNonInteractive = 内容会一直保留。在交互式会话中用 { $command } 查看。
jouzu-cli-textguard-review-nothing = TextGuard 没有等待决策的项目。{ $extra }
jouzu-cli-textguard-review-incomplete = TextGuard 无法识别完整内容。请重试请求；此内容无法批准。{ $extra }
jouzu-cli-textguard-review-blockedNothing = { $count ->
    [one] { $count } 个检测结果未阻止任何内容；请参阅 { $command }。
   *[other] { $count } 个检测结果未阻止任何内容；请参阅 { $command }。
}
jouzu-cli-textguard-approved-persisted = 内容已批准。今后的会话会接受这些确切的字节；任何更改都需要重新审查。资源将重新加载。
jouzu-cli-textguard-approved-session = 内容已批准用于此会话。资源重新加载后请重试请求。
# The TextGuard notification sentences the local `notify` helper shows. The
# `/textguard` and `/reload` command names and the mode values are protected
# values, so they stay as written; the finding source and the already-resolved
# report or approval sentence arrive as arguments.
jouzu-cli-textguard-commandUsage = 使用 /textguard 查看检测结果，使用 /textguard reports 查看未阻止任何内容的检测结果，或使用 /textguard on、strict、off 设置扫描。
jouzu-cli-textguard-mode-alreadySet = TextGuard 已设置为 { $mode }。
jouzu-cli-textguard-review-pendingSummary = TextGuard：{ $count } { $count ->
    [one] 个项目
   *[other] 个项目
} 等待你的审查。{ $advice }
jouzu-cli-textguard-review-requiresTerminal = TextGuard 审查需要交互式终端。内容会一直保留。
jouzu-cli-textguard-review-requiresSize = TextGuard 审查至少需要 48 列和 24 行。请调整终端大小，然后重试 /textguard。
jouzu-cli-textguard-review-unavailable = 此会话无法使用 TextGuard 审查。内容会一直保留。
jouzu-cli-textguard-reports-empty = TextGuard 没有可显示的、未阻止任何内容的检测结果。
jouzu-cli-textguard-terminalResized = 终端大小已更改。内容会一直保留；请调整大小并重试 /textguard。
jouzu-cli-textguard-review-expired = 此 TextGuard 审查已过期。请再次运行 /textguard。
jouzu-cli-textguard-reloadFailed = TextGuard 已更改，但资源无法重新加载。重试前请运行 /reload。
jouzu-cli-textguard-approved-reloadFailed = 内容已批准，但资源无法重新加载。重试前请运行 /reload。
# The two alert frames a local helper returns. The source, the evidence detail,
# and the resolved report or approval sentence are protected values passed as
# arguments. A helper's returned template is not a detector position, so this
# prose moves onto the catalog without a shape reporting it.
jouzu-cli-textguard-alert-flagged = TextGuard 标记了 { $source }：{ $detail }。内容已以不可信数据的标记送达模型{ $report }。
jouzu-cli-textguard-alert-withheld = TextGuard 保留了 { $source }：{ $detail }。{ $next }
# The finding kinds and their explanations the review overlay renders. The kind
# identifier (`bidi_control`, a `yara:` rule, or another scanner token) is a
# protected value passed as an argument; these names and explanations are the
# human text the review view shows.
jouzu-cli-textguard-kind-bidiControl = 双向控制字符
jouzu-cli-textguard-kind-bidiControl-explanation = 此字符可以颠倒文本显示的顺序，因此你读到的内容可能与实际处理的内容不同。
jouzu-cli-textguard-kind-ansiEscape = 终端转义序列
jouzu-cli-textguard-kind-ansiEscape-explanation = 此序列可以更改终端颜色或在屏幕上隐藏文本。
jouzu-cli-textguard-kind-invisibleChar = 不可见字符
jouzu-cli-textguard-kind-invisibleChar-explanation = 此字符在不显示于屏幕的情况下更改文本。
jouzu-cli-textguard-kind-combiningAbuse = 堆叠的组合标记
jouzu-cli-textguard-kind-combiningAbuse-explanation = 堆叠的重音字符可以伪装字母的真实面目。
jouzu-cli-textguard-kind-softHyphen = 软连字符
jouzu-cli-textguard-kind-softHyphen-explanation = 此不可见字符可以拆分单词以规避精确匹配。
jouzu-cli-textguard-kind-tagCharacter = Unicode 标签字符
jouzu-cli-textguard-kind-tagCharacter-explanation = 标签字符可以在看似普通的内容中隐藏额外文本。
jouzu-cli-textguard-kind-variationSelector = 变体选择符
jouzu-cli-textguard-kind-variationSelector-explanation = 此不可见字符可以改变相邻字符的呈现方式。
jouzu-cli-textguard-kind-splitToken = 被拆分的关键词
jouzu-cli-textguard-kind-splitToken-explanation = 像 "system" 或 "instructions" 这样的受保护关键词被分隔符拆开，这是隐藏提示注入的常见手法。
jouzu-cli-textguard-kind-decoded = 已编码的文本
jouzu-cli-textguard-kind-decoded-explanation = 内容的一部分以编码形式存储，并在扫描前被解码。
jouzu-cli-textguard-kind-normalized = 规范化更改
jouzu-cli-textguard-kind-normalized-explanation = 内容的一部分在扫描前的规范化过程中被改写。
jouzu-cli-textguard-kind-stripped = 已移除的字符
jouzu-cli-textguard-kind-stripped-explanation = 内容的一部分在扫描前的规范化过程中被移除。
jouzu-cli-textguard-kind-bundledRule = 捆绑检测规则（{ $rule }）匹配
jouzu-cli-textguard-kind-bundledRule-explanation = 一条捆绑检测规则匹配了与攻击相关的模式；该规则并不知道此内容是否恶意。
jouzu-cli-textguard-kind-flaggedPattern = 被标记的模式 { $kind }
jouzu-cli-textguard-kind-flaggedPattern-explanation = 扫描器匹配了它认为可疑的模式。
# A finding location. The offset, line, and column are protected numbers passed
# as arguments.
jouzu-cli-textguard-location-character = 内容的第 { $offset } 个字符（从 0 开始计数）
jouzu-cli-textguard-location-line = 第 { $line } 行，第 { $column } 列
# The review body lines: the source label, the content fingerprint, the heading
# over the escaped body, and the closing risk notice. The source and the digest
# are protected values passed as arguments.
jouzu-cli-textguard-review-source = 来源：{ $source }
jouzu-cli-textguard-review-fingerprint = 内容指纹（SHA-256）：{ $digest }
jouzu-cli-textguard-review-notRetained = 被标记的内容本身不会保留以供在此查看。
jouzu-cli-textguard-review-flaggedHeading = 被标记的内容（控制字符和不可见字符以转义形式显示）：
jouzu-cli-textguard-review-riskNotice = 扫描可以降低风险，但无法证明内容安全。是否允许由你决定。
jouzu-cli-textguard-review-findingsTruncated = 显示 { $total } 个检测结果中的前 { $shown } 个。
# The simple counts verdict when nothing else needs naming; the blocking clause
# is a resolved catalog value, and the trailing period is part of this message
# so the Japanese sentence can end with its own punctuation.
jouzu-cli-textguard-counts-line = { $blocking }。
# The review overlay chrome. The resolved keybinding hints and the view counts
# arrive as arguments; the status words are padded to a fixed width by the
# renderer, not in the catalog value.
jouzu-cli-textguard-off-title = TextGuard — 此会话已关闭扫描
jouzu-cli-textguard-off-body = 内容未经扫描即被接受。技能和网页结果不会被检查。
jouzu-cli-textguard-hint-select = { $keys } 选择
jouzu-cli-textguard-hint-open = { $keys } 打开
jouzu-cli-textguard-hint-close = { $keys } 关闭
jouzu-cli-textguard-hint-action = { $keys } 操作
jouzu-cli-textguard-hint-scroll = { $keys } 滚动
jouzu-cli-textguard-hint-back = { $keys } 返回
jouzu-cli-textguard-list-header = TextGuard 审查
jouzu-cli-textguard-list-summary = { $withheld } 个已保留 · { $delivered } 个已送达
jouzu-cli-textguard-status-withheld = 已保留
jouzu-cli-textguard-status-delivered = 已送达
jouzu-cli-textguard-status-report = 报告
jouzu-cli-textguard-list-progress = （{ $current }/{ $total }）
jouzu-cli-textguard-list-notices = { $count ->
    [one] { $count } 次检查无法识别完整内容；该内容无法批准。
   *[other] { $count } 次检查无法识别完整内容；该内容无法批准。
}
jouzu-cli-textguard-detail-progress = （第 { $start }-{ $end } 行，共 { $total } 行）
# The `/textguard` command description the host shows in its command list.
jouzu-cli-textguard-commandDescription = 查看 TextGuard 检测结果，或将扫描设置为 on、strict 或 off

# Settings view. A key-hint label is a short word in a narrow column; a row
# label is the identity column; a message is the panel's status or confirmation
# text. Resolved keybindings and key names arrive as arguments.
jouzu-cli-settings-hint-save = 保存
jouzu-cli-settings-hint-field = 字段
jouzu-cli-settings-hint-changeAuthentication = 更改认证
jouzu-cli-settings-hint-cancel = 取消
jouzu-cli-settings-hint-remove = 移除
jouzu-cli-settings-hint-signOut = 退出登录
jouzu-cli-settings-hint-move = 移动
jouzu-cli-settings-hint-dashboard = 仪表板
jouzu-cli-settings-hint-section = 分区
jouzu-cli-settings-hint-close = 关闭
jouzu-cli-settings-hint-connect = 连接
jouzu-cli-settings-hint-changeView = 更改视图
jouzu-cli-settings-hint-view = 视图
jouzu-cli-settings-hint-autoLabels = 自动标签
jouzu-cli-settings-hint-displayMode = 显示模式
jouzu-cli-settings-hint-contextLimit = 上下文上限
jouzu-cli-settings-hint-edit = 编辑
jouzu-cli-settings-hint-add = 添加
jouzu-cli-settings-hint-refresh = 刷新
jouzu-cli-settings-hint-enable = 启用
jouzu-cli-settings-hint-models = 模型

jouzu-cli-settings-label-account = Shisa AI
jouzu-cli-settings-label-contextLimit = 最大上下文
jouzu-cli-settings-label-dashboard = 仪表板
jouzu-cli-settings-label-autoLabels = 自动标签
jouzu-cli-settings-label-view = 视图
jouzu-cli-settings-offeringRow = { $provider }/{ $model }

jouzu-cli-settings-loadFailed = 无法加载目录设置：{ $message }
jouzu-cli-settings-savedTokensUnreadable = 无法读取已保存的令牌：{ $message }
jouzu-cli-settings-saving = 正在保存目录…
jouzu-cli-settings-savedWithNotes = { $base }{ $notes }
jouzu-cli-settings-saveCanceled = 目录保存已取消。
jouzu-cli-settings-refreshing = 正在刷新 { $label }…
jouzu-cli-settings-contextLimitNotApplied = 未应用上下文上限：{ $message }。模型使用其声明的窗口。
jouzu-cli-settings-contextLimitNotSaved = 未保存上下文上限：{ $message }
jouzu-cli-settings-autoLabelsSaved = 已保存全局自动标签：{ $state ->
    [on] 开
   *[off] 关
}。会话关闭和窗格固定仍然有效。
jouzu-cli-settings-autoLabelsNotSaved = 未保存自动标签：{ $message }
jouzu-cli-settings-dashboardSaved = 已保存仪表板显示：{ $mode }。
jouzu-cli-settings-dashboardNotSaved = 未保存仪表板显示：{ $message }
jouzu-cli-settings-signOutConfirm = 按 { $confirm } 在此设备上退出 Shisa；{ $cancel } 取消。已保存的目录和语音将停止使用此账户。
jouzu-cli-settings-removed = 已移除 { $label }。
jouzu-cli-settings-builtInSource = { $label } 是内置的 Jouzu 目录源。{ $key } 可启用或禁用它；其端点和凭据引用保持受管理。
jouzu-cli-settings-builtInCannotRemove = { $label } 是内置的，无法移除。{ $key } 可禁用它。
jouzu-cli-settings-removeConfirm = 按 { $confirm } 移除此目录源；{ $cancel } 取消。
jouzu-cli-settings-sourceToggled = { $label } { $state ->
    [enabled] 已启用
   *[disabled] 已禁用
}。
jouzu-cli-settings-loginHint = 运行 /login shisa 连接此账户。
jouzu-cli-settings-signOutFailed = Shisa 退出登录未能完成。请等待任何登录或退出登录结束后重试。
jouzu-cli-settings-field-label = 标签
jouzu-cli-settings-field-url = URL 或主机
jouzu-cli-settings-field-auth = 认证
jouzu-cli-settings-auth-none = 无
jouzu-cli-settings-auth-bearer = Bearer 令牌
jouzu-cli-settings-field-credential = 令牌变量
jouzu-cli-settings-field-token = 令牌
jouzu-cli-settings-refresh-upToDate = 目录已是最新。
jouzu-cli-settings-refresh-status = 目录 { $status }。
jouzu-cli-settings-hint-scroll = 滚动

# Settings panel text that a conditional expression used to hold. The state
# words (credential, auto labels) are select variants keyed by an internal
# value; the view names stay English as Palette product nouns, by the owner
# decision.
jouzu-cli-settings-warning = 警告：{ $message }
jouzu-cli-settings-savedQuarantined = 已保存 { $label }。目录修订已隔离：{ $reasons }。
jouzu-cli-settings-savedWithCount = { $count ->
    [one] 已保存 { $label }，包含 { $count } 个模型。
   *[other] 已保存 { $label }，包含 { $count } 个模型。
}
jouzu-cli-settings-modelCount = { $count ->
    [one] { $count } 个模型
   *[other] { $count } 个模型
}
jouzu-cli-settings-savedWithoutCheck = 已保存 { $label }，未检查目录。
jouzu-cli-settings-contextLimitOff = 上下文上限已关闭。模型使用其声明的窗口。
jouzu-cli-settings-contextLimitSet = 上下文上限为 { $limit } 个令牌。超过它的模型会报告 { $limit } 并更早压缩。
jouzu-cli-settings-dashboardOpened = 已打开 Shisa 仪表板：{ $url }
jouzu-cli-settings-dashboardAddress = Shisa 仪表板：{ $url }
jouzu-cli-settings-form-addHeading = 添加目录
jouzu-cli-settings-form-editHeading = 编辑 { $label }
jouzu-cli-settings-credential-availability = { $name } { $state ->
    [set] 已在此 Jouzu 进程中设置。
    [saved] 未设置；将在此 Jouzu 进程中使用已保存的令牌。
   *[unset] 未在此 Jouzu 进程中设置。
}
jouzu-cli-settings-credential-login = · 正在使用 Shisa 登录
jouzu-cli-settings-credential-state = · { $name } { $state ->
    [set] 已设置
    [stored] 未设置，正在使用已保存的令牌
   *[unset] 未设置
}
jouzu-cli-settings-account-connectedDetail = 已连接 · { $detail }
jouzu-cli-settings-account-connected = 已连接
jouzu-cli-settings-account-connectMeta = { $key } 连接
jouzu-cli-settings-signIn-couldNotComplete = Shisa 登录未能完成。请从此行重试，或运行 /login shisa。
jouzu-cli-settings-autoLabelsState = { $state ->
    [error] 关（设置错误）
    [on] 开
   *[off] 关
}
jouzu-cli-settings-view-about = About
jouzu-cli-settings-view-catalogs = Catalogs
# Settings Language view. Three items show the effective value and the source
# that supplied it. A source token (cli, env, config, os, session, project,
# task, builtin) and a preview marker arrive as arguments or protected values.
jouzu-cli-settings-view-language = 语言
jouzu-cli-settings-heading-language = 语言
jouzu-cli-settings-label-displayLanguage = 显示语言
jouzu-cli-settings-label-responseLanguage = 响应语言
jouzu-cli-settings-label-artifactPolicy = 成果物策略
jouzu-cli-settings-hint-language = 更改
jouzu-cli-settings-hint-cancelPreview = 取消预览
jouzu-cli-settings-language-sourcePreview = 预览
jouzu-cli-settings-language-previewNotice = 预览 · 未保存。{ $cancel } 取消。
jouzu-cli-settings-language-previewCanceled = 预览已取消。未保存任何内容。
# The first-run language choice. Each language is listed by its own name so a
# user who picked the wrong language can find the way back. The self-names are
# the same in every catalog on purpose.
jouzu-cli-language-self-en = English
jouzu-cli-language-self-ja = 日本語
jouzu-cli-language-self-zhHans = 简体中文
jouzu-cli-language-self-zhHant = 繁體中文
jouzu-cli-language-auto = 自动
jouzu-cli-language-choice-intro = 选择 Jouzu 的界面语言。每种语言都以其自身的名称列出。
jouzu-cli-language-choice-unavailable = 此构建中不可用
jouzu-cli-language-choice-suggested = 建议
jouzu-cli-language-choice-question = 界面语言（编号、名称，或按 Enter 跳过）
jouzu-cli-language-choice-responseIntro = 选择 Jouzu 撰写回复时使用的语言。它可以与界面语言不同。
jouzu-cli-language-choice-responseQuestion = 响应语言（编号、名称，或按 Enter 接受界面语言）
jouzu-cli-language-choice-invalid = 不在列表中的语言：{ $value }
jouzu-cli-language-choice-notShipped = 此构建中界面不支持 { $language }。
jouzu-cli-language-choice-saveFailed = 无法保存语言选择：{ $message }
jouzu-cli-language-choice-skipped = 未选择语言。Jouzu 下次会再次询问。

# The reversible Japanese-profile migration. The plan's profile,
# source, response-language, and asset values, the diff lines, and the backup
# path are protected values passed as arguments; the sentences live here.
jouzu-cli-profileMigration-title = Jouzu 配置档案迁移计划
jouzu-cli-profileMigration-section = 迁移
jouzu-cli-profileMigration-field-from = 从
jouzu-cli-profileMigration-field-to = 到
jouzu-cli-profileMigration-fromValue = { $profile }（{ $source }）
jouzu-cli-profileMigration-toValue = 响应语言 { $responseLanguage }；显示语言 { $uiLocale }
jouzu-cli-profileMigration-assets = 资源
jouzu-cli-profileMigration-conflicts = 冲突
jouzu-cli-profileMigration-assetDeduplicate = 移除重复的语言指令，因为响应语言现在已提供它
jouzu-cli-profileMigration-assetPreserve = 保留已编辑的文件并检查重复的行
jouzu-cli-profileMigration-assetReplace = 移除由发行版管理的语言指令
jouzu-cli-profileMigration-diffKind = { $kind ->
    [remove] 移除
   *[keep] 保留
}
jouzu-cli-profileMigration-resolution-keepEdits = 自行移除重复的行来解决重复，或重新应用配置档案。
jouzu-cli-profileMigration-resolution-reapplyProfile = 重新应用配置档案以恢复由发行版管理的文件。
jouzu-cli-profileMigration-temporary = 配置档案选择是临时的；用户级设置不会被更改。
jouzu-cli-profileMigration-conflict = 配置档案迁移计划包含冲突

# The Settings text that issue #53 moved off the plain-`string` seams: the
# token warning and save notes, the account row, the section heading, the empty
# states, the title, and the sign-in reports. The sign-in `report` closure takes
# a catalog ID, so a literal sentence no longer type-checks there.
jouzu-cli-settings-warning-tokenNotSet = 警告：令牌变量 { $name } 未设置，且此源未保存令牌。请设置它或保存令牌，然后刷新。
jouzu-cli-settings-note-tokenNotSet = 令牌变量 { $name } 未设置且未保存令牌；请设置它或保存令牌，然后按 R 刷新。
jouzu-cli-settings-note-tokenPrecedence = { $name } 已在此 Jouzu 进程中设置，优先于已保存的令牌。
jouzu-cli-settings-account-notConnected = 未连接
jouzu-cli-settings-heading-modelCatalogs = 模型目录
jouzu-cli-settings-empty-noSources = 未配置目录源。
jouzu-cli-settings-empty-noOfferings = 没有缓存的模型提供项。
jouzu-cli-settings-title = · Settings / { $view }
jouzu-cli-settings-signIn-requestingCode = 正在请求 Shisa 设备代码。{ $cancel } 取消。
jouzu-cli-settings-signIn-deviceCode = 打开 { $uri } 并输入代码 { $code } 以批准此设备。{ $cancel } 取消。
jouzu-cli-settings-signIn-unexpectedPrompt = 意外的 Shisa 登录提示。
jouzu-cli-settings-signIn-connected = 已连接到 Shisa AI。

# The voice surface. The recording widget's state word and key hint, the
# microphone picker, the command notices, and the reviewed capture and transport
# diagnostics. The internal voice state values, the `/voice` subcommand names,
# and the `[garbled]` marker are protected values, never catalog text; the state
# word is a select variant keyed by the internal value.
jouzu-cli-voice-label = 语音
jouzu-cli-voice-state-connecting = 语音：正在连接…
jouzu-cli-voice-state-recording = 语音：正在录音
jouzu-cli-voice-state-finishing = 语音：正在完成转写…
jouzu-cli-voice-hint-recording = /voice stop 插入 · /voice cancel 丢弃
jouzu-cli-voice-hint-idle = /voice cancel 丢弃
jouzu-cli-voice-segment-final = 最终
jouzu-cli-voice-segment-pending = 待处理
jouzu-cli-voice-segment-live = 实时
jouzu-cli-voice-segment-failed = 失败
jouzu-cli-voice-segment-progress = { $finalized } 个已完成 · { $pending } 个等待最终 · { $failed } 个失败
jouzu-cli-voice-segment-retained = 保留了 { $count } 个较早的片段
jouzu-cli-voice-status = 语音：{ $state ->
   *[starting] 正在启动
    [recording] 正在录音
    [finishing] 正在完成
}
jouzu-cli-voice-devices-default = 默认麦克风
jouzu-cli-voice-devices-title = 语音麦克风（此机器）
jouzu-cli-voice-inserted-garbled = 语音文本已插入，缺失的语音用 [garbled] 表示。请编辑提示词，然后按 Enter 发送。
jouzu-cli-voice-inserted = 语音文本已插入。请检查，然后按 Enter 发送。
jouzu-cli-voice-noSpeech = 未转写任何语音。你的提示词未更改。
jouzu-cli-voice-finishFailed = 语音未能完成。你的提示词未更改；请尝试重新录音。
jouzu-cli-voice-stillFinishing = 语音仍在准备或完成中。使用 /voice cancel 丢弃它。
jouzu-cli-voice-alreadyActive = 语音已处于活动状态。请先停止或取消它。
jouzu-cli-voice-signedOut = 已退出 Shisa。使用 /voice 前请运行 /login shisa。
jouzu-cli-voice-requiresLogin = 语音需要 Shisa 登录或 SHISA_API_KEY。请运行 /login shisa 或设置 SHISA_API_KEY。
jouzu-cli-voice-endpointInvalid = 已保存的 Shisa 语音端点无效。请再次运行 /login shisa。
jouzu-cli-voice-startFailed = 语音无法启动。请检查你的麦克风、网络和 Shisa 访问权限。
jouzu-cli-voice-nonInteractive = 语音输入需要带有麦克风的机器上的交互式终端。
jouzu-cli-voice-cancelled = 语音已取消。你的提示词未更改。
jouzu-cli-voice-devicesBusy = 选择麦克风前请先停止或取消语音。
jouzu-cli-voice-devicesFailed = 无法列出麦克风。请检查音频设备和平台支持。
jouzu-cli-voice-languageBusy = 更改语言前请先停止或取消语音。
jouzu-cli-voice-languageSet = 语音语言：{ $language }。
jouzu-cli-voice-usage = 使用 /voice [start|stop|cancel|devices|language auto|language ja|language en|language zh]。
jouzu-cli-voice-captureFailed = 麦克风采集失败。请检查你的输入设备、麦克风权限和平台支持。
jouzu-cli-voice-captureStartTimeout = 麦克风启动超时。请检查你的音频设备。
jouzu-cli-voice-captureStopTimeout = 麦克风未响应停止。录音已取消。
jouzu-cli-voice-uploadSlow = 语音网络上传太慢。请检查连接并重试。
jouzu-cli-voice-uploadFailed = 语音网络上传失败。请检查连接并重试。
jouzu-cli-voice-authFailed = 语音认证失败。请再次运行 /login shisa 或检查 SHISA_API_KEY。
jouzu-cli-voice-accessDenied = 语音访问被拒绝。你的 Shisa 密钥需要 shisa/asr-realtime 访问权限。
jouzu-cli-voice-connectionRejected = 语音连接被拒绝。请检查服务可用性并重试。
jouzu-cli-voice-connectionFailed = 语音连接失败。请检查你的网络和 Shisa 访问权限。
jouzu-cli-voice-transcriptionFailed = 语音转写失败。请检查 Shisa 服务访问权限并重试。
jouzu-cli-voice-transcriptInvalid = 语音返回了无效或过大的转写。请尝试更短的录音。
jouzu-cli-voice-connectionEnded = 语音连接在转写完成前结束。请尝试重新录音。
jouzu-cli-voice-connectionStartFailed = 语音连接无法启动。请重试。
jouzu-cli-voice-transcriptInvalidIdentifier = 语音返回了无效的片段标识符。
jouzu-cli-voice-transcriptInvalidAudioRange = 语音返回了无效的音频范围。
jouzu-cli-voice-transcriptInvalidReplacementRange = 语音返回了无效的替换范围。
jouzu-cli-voice-transcriptTooLarge = 语音转写达到其文本或片段上限。请录制更短的一段。
jouzu-cli-voice-commandDescription = 向提示词口述；启动、停止、取消或配置语音
jouzu-cli-voice-shortcutDescription = 启动或停止语音口述
# The shisa-link authentication onboarding, device-flow, and logout surface.
# Command names (`/login shisa`, `/logout shisa`, `/reload`), the account
# identifiers, the verification URL, and the device code are protected values
# passed as arguments; the English values below are the default output.

jouzu-cli-shisa-onboarding-pointConnect = 连接到 Shisa AI 以使用托管模型和语音输入。
jouzu-cli-shisa-onboarding-pointCredits = 查看可用优惠及适用条件：https://platform.shisa.ai/jouzu
jouzu-cli-shisa-onboarding-question = 现在连接？[y/N]
jouzu-cli-shisa-onboarding-hint = （或稍后用 /login shisa）
jouzu-cli-shisa-onboarding-later = 你可以稍后用 /login shisa 连接。
jouzu-cli-shisa-onboarding-setupChoiceFailed = 无法保存 Shisa 设置选择。请检查 Jouzu 的存储权限。
jouzu-cli-shisa-onboarding-openLink = 打开下面的链接，在浏览器中批准此设备。按 Ctrl+C 取消登录。
jouzu-cli-shisa-onboarding-deviceCode = 设备代码：{ $code }
jouzu-cli-shisa-onboarding-signedIn = 已登录 Shisa AI。
jouzu-cli-shisa-onboarding-cancelled = Shisa 登录已取消。
jouzu-cli-shisa-onboarding-couldNotComplete = Shisa 登录未能完成。

jouzu-cli-shisa-signIn-confirmFailed = Shisa 登录已保存，但确认失败。请再次登录，以免超过确认期限后失去访问权限。
jouzu-cli-shisa-signIn-confirmInterrupted = Shisa 登录已保存，但确认被中断。请再次登录，以免超过确认期限后失去访问权限。
jouzu-cli-shisa-signIn-unexpectedResponse = Shisa 登录返回了意外的响应。请重新开始登录。
jouzu-cli-shisa-signIn-expired = 登录请求已过期。请重新开始登录。
jouzu-cli-shisa-signIn-declined = 登录请求在浏览器中被拒绝。请重新开始登录以重试。
jouzu-cli-shisa-signIn-notRecognized = 登录请求未被识别。请重新开始登录。
jouzu-cli-shisa-signIn-alreadyDelivered = 此登录已交付其 API 密钥。请开始新的登录以关联此设备。
jouzu-cli-shisa-signIn-httpFailed = Shisa 登录失败（HTTP { $status }）。请重新开始登录。
jouzu-cli-shisa-signIn-storageFailed = 无法保存 Shisa 登录。请检查 Jouzu 的存储权限并再次登录。
jouzu-cli-shisa-signIn-platformUnreachable = 无法访问 Shisa 平台：{ $message }
jouzu-cli-shisa-signIn-startFailed = Shisa 平台无法启动登录请求（HTTP { $status }）。
jouzu-cli-shisa-signIn-unexpectedStart = Shisa 平台返回了意外的登录响应。请重试。
jouzu-cli-shisa-signIn-timedOut = 登录在请求被批准前超时。请重新开始登录。
jouzu-cli-shisa-signIn-cancelled = 登录已取消

jouzu-cli-shisa-logout-busy = Shisa 登录或退出登录已在运行。请等待其结束。
jouzu-cli-shisa-logout-couldNotRemove = 无法移除已保存的 Shisa 凭据。请检查 Jouzu 的存储权限并重试 /logout shisa。
jouzu-cli-shisa-logout-signedOutLocally = 已在本地退出登录。请在 Shisa 仪表板中断开此设备以撤销其密钥。
jouzu-cli-shisa-logout-signedOut = 已退出 Shisa。
jouzu-cli-shisa-logout-serverUnconfirmed = 服务器端撤销未确认。请在 Shisa 仪表板中断开此设备以撤销其密钥。
jouzu-cli-shisa-logout-envKeyRemains = { $message } SHISA_API_KEY 仍处于设置状态，但 Jouzu 在你再次登录前不会在此进程中使用 Shisa。要保持在退出登录状态，请在重启前取消设置该变量。

jouzu-cli-shisa-refreshFailed = 无法刷新 Shisa 模型可用性。请运行 /reload。
jouzu-cli-shisa-signOutFailed = Shisa 退出登录未能完成。请等待任何登录或退出登录结束后重试 /logout shisa。
jouzu-cli-shisa-signedOutReconnect = 已退出 Shisa。运行 /login shisa 重新连接。
# The subagent result renderer. The status table maps an internal run state to
# a display word; the state value is the table key and never changes. Run IDs,
# paths, model IDs, tool names, counts, and offsets are passed as arguments.
jouzu-cli-subagent-status-queued = 已排队
jouzu-cli-subagent-status-starting = 正在启动
jouzu-cli-subagent-status-running = 运行中
jouzu-cli-subagent-status-completed = 已完成
jouzu-cli-subagent-status-failed = 失败
jouzu-cli-subagent-status-cancelled = 已取消
jouzu-cli-subagent-status-interrupted = 已中断
jouzu-cli-subagent-status-unknown = 未知
jouzu-cli-subagent-roleFallback = 代理
jouzu-cli-subagent-runLabel = 运行 { $id }
jouzu-cli-subagent-workspaceLabel = 工作区：
jouzu-cli-subagent-elapsed = 已用 { $minutes }m { $seconds }s（含排队）
jouzu-cli-subagent-modelIdLabel = 模型 ID：
jouzu-cli-subagent-tokensLabel = 令牌：
jouzu-cli-subagent-cost = 成本：{ $amount }
jouzu-cli-subagent-costUnknown = 成本：未知
jouzu-cli-subagent-candidateIdentityLabel = 候选身份：
jouzu-cli-subagent-candidateHeadLabel = 候选 HEAD：
jouzu-cli-subagent-identityStability = 身份稳定性不代表审查批准。
jouzu-cli-subagent-moreRuns = 还有 { $count } 个运行；请展开或使用 list
jouzu-cli-subagent-noChildRuns = 没有子运行。
jouzu-cli-subagent-nextOffset = 下一个偏移：{ $offset }
jouzu-cli-subagent-enabled-on = 子代理开
jouzu-cli-subagent-enabled-off = 子代理关
jouzu-cli-subagent-placementLabel = 放置：
jouzu-cli-subagent-toolsLabel = 工具：
jouzu-cli-subagent-moreRoles = 还有 { $count } 个角色；请展开查看
jouzu-cli-subagent-outputPage = 输出页
jouzu-cli-subagent-eventOnPage = { $heading } · 此页 1 个事件
jouzu-cli-subagent-eventsOnPage = { $heading } · 此页 { $count } 个事件
jouzu-cli-subagent-resultLabel = 结果：
jouzu-cli-subagent-assistantLabel = 助手：
jouzu-cli-subagent-messageFallback = 消息
jouzu-cli-subagent-outputReceived = { $role } · 已收到输出
jouzu-cli-subagent-result = 结果
jouzu-cli-subagent-toolLabel = 工具：{ $tool }
jouzu-cli-subagent-childSessionReady = 子会话已就绪
jouzu-cli-subagent-messageLabel = 消息：{ $status }
jouzu-cli-subagent-runEnded = 运行已结束
jouzu-cli-subagent-assignmentLabel = 任务分配：
jouzu-cli-subagent-event = 事件：{ $type }
jouzu-cli-subagent-earlierEvents = 此页还有 { $count } 个较早的事件
jouzu-cli-subagent-noOutputYet = 暂无输出。
jouzu-cli-subagent-partialRecords = 预览中省略了部分记录。
jouzu-cli-subagent-moreOutput = 还有更多输出可用。
jouzu-cli-subagent-nextByteOffset = 下一个字节偏移：{ $offset }
jouzu-cli-subagent-endOfOutput = 可用输出结束。
jouzu-cli-subagent-messageAccepted = 消息已被控制器接受
jouzu-cli-subagent-deliveryUnconfirmed = 到子代理的送达尚未确认。
jouzu-cli-subagent-receiptLabel = 回执：
jouzu-cli-subagent-cancellationRequested = 已请求取消子代理
jouzu-cli-subagent-noResult = 无结果
jouzu-cli-subagent-operationFailed = 子代理操作失败

# The Session UI: the session identity line, the status bar, the Palette
# shortcut hint, and the work dashboard. Provider display names, model IDs,
# paths, and URLs are protected values passed as arguments, never catalog
# text. The dashboard's section and attention keys are internal identities;
# only the resolved words live here.
jouzu-cli-session-line-noModel = 无模型
jouzu-cli-session-line-attention = 需注意
jouzu-cli-session-status-health = ! 状态
jouzu-cli-session-status-contextUnknown = ctx ?
jouzu-cli-session-status-detached = 已分离
jouzu-cli-session-hint-paletteShortcuts = { $select } 模型 · { $cycle } 收藏 · { $help } 帮助
jouzu-cli-session-dashboard-section-agent = 代理
jouzu-cli-session-dashboard-section-job = 作业
jouzu-cli-session-dashboard-section-task = 任务
jouzu-cli-session-dashboard-section-loop = 循环
jouzu-cli-session-dashboard-section-goal = 目标
jouzu-cli-session-dashboard-section-prompt = 定时
jouzu-cli-session-dashboard-section-flow = 流
jouzu-cli-session-dashboard-attention-result = 未读结果
jouzu-cli-session-dashboard-attention-input = 需要输入
jouzu-cli-session-dashboard-attention-recovery = 需要恢复
jouzu-cli-session-dashboard-attention-authority = 需要决策
jouzu-cli-session-dashboard-stale = { $status } [残留]
jouzu-cli-session-dashboard-elapsed-seconds = { $count }s
jouzu-cli-session-dashboard-elapsed-minutes = { $count }m
jouzu-cli-session-dashboard-elapsed-hours = { $count }h
jouzu-cli-session-dashboard-elapsed-hoursMinutes = { $hours }h { $minutes }m
# The subagent command, workflow, and dashboard notifications. Command names,
# option words, JSON operation snippets, run IDs, paths, and counts are passed
# as arguments; only the sentence lives here.
jouzu-cli-subagent-commandHint = 使用 /subagents、/subagents show 或 /subagents hide。
jouzu-cli-subagent-dashboardRestored = 仪表板已恢复到其保存的显示模式。
jouzu-cli-subagent-dashboardHidden = 已为此会话隐藏仪表板。使用 /subagents show 恢复它。
jouzu-cli-subagent-paneEnabled = 子代理窗格已启用；当此会话有子运行时它会显示。
jouzu-cli-subagent-paneHidden = 子代理窗格已隐藏。使用 /subagents show 显示它。
jouzu-cli-subagent-enabledNotice = 此会话已开启子代理。
jouzu-cli-subagent-disabledNotice = 此会话已关闭子代理。排队和运行中的子代理已停止；现有更改会保留。
jouzu-cli-subagent-workflowCommandHint = 使用 /workflow、/workflow on、/workflow off 或 /workflow toggle。
jouzu-cli-subagent-settingChangeFailed = 无法更改子代理设置。
jouzu-cli-subagent-workflowStorageUnavailable = Workflow 存储不可用。
jouzu-cli-subagent-workflowAgentsUnreadable = Workflow：无法加载 agents.json。请在启动代理前修正配置。
jouzu-cli-subagent-notificationDeliveryFailed = 代理通知送达失败。使用 subagent list/read 读取保留的结果；空闲时重新加载以重试。
jouzu-cli-subagent-rolesDisabledReason = 用户已为此会话禁用子代理。请直接工作；只有用户才能重新启用它们。
jouzu-cli-subagent-fieldRequired = subagent { $op } 需要非空的 { $field }。{ $hint } 省略无关字段；仅当接口要求时才使用 null。
jouzu-cli-subagent-fieldHint-role = 调用 { $command } 并使用返回的可作为子代理的角色。
jouzu-cli-subagent-fieldHint-runId = 调用 { $command } 并使用返回的运行 ID。
jouzu-cli-subagent-fieldHint-batchId = 使用本次运行中送达的完成批次的 batchId。
jouzu-cli-subagent-fieldHint-task = 在 task 中提供任务分配或后续指令。
jouzu-cli-subagent-dashboardMore = · +{ $count } 个更多
jouzu-cli-subagent-batchSummary = 代理：{ $total } 个已结束 — 完成 { $completed }，失败 { $failed }，取消 { $cancelled }，中断 { $interrupted }。
jouzu-cli-subagent-batchOmitted = 省略 { $count } 个；使用 subagent list 查看 ID，使用 subagent read 查看输出。
jouzu-cli-subagent-reviewCandidateWarning = 审查候选 { $status }；此结果并不确立最终工作区状态。
jouzu-cli-subagent-workspaceError = 工作区：{ $path } { $reason }。请选择 Jouzu 可访问的现有目录；无需重启。
jouzu-cli-subagent-workspaceMissing = 不存在
jouzu-cli-subagent-workspaceInaccessible = 不可访问
jouzu-cli-subagent-workspaceNotDirectory = 不是可访问的目录
jouzu-cli-subagent-modelUnavailable = 模型：{ $selector } 不可用。请在 Workflow 中选择一个可用的模型。
jouzu-cli-subagent-modelAmbiguous = 模型：{ $selector } 匹配 { $count } 个提供方：{ $providers }。请使用完整的 provider/model 重试。
jouzu-cli-subagent-modelAmbiguousMore = ，以及另外 { $count } 个
jouzu-cli-subagent-validationLength = 验证：{ $label } 必须是 1–{ $max } 个字符。
jouzu-cli-subagent-validationLengthMax = 验证：{ $label } 最多 { $max } 个字符。
# The subagent launch, resume, read, and trace failure and recovery sentences the
# direct-string detector cannot reach, plus the command descriptions and the
# call preview. A model, a provider, a role, a workspace, a run ID, a byte
# offset, and a JSON operation snippet are passed as arguments; only the
# sentence lives here.
jouzu-cli-subagent-workflowRequiresSession = Workflow 需要活动会话。
jouzu-cli-subagent-sameModelNoSession = 模型：角色模型为 "{ $model }"，但此会话未选择模型。请选择模型，或为该角色指定明确的 provider/model。
jouzu-cli-subagent-agentDefinitionNotFound = 未找到代理定义。
jouzu-cli-subagent-disabledForSession = 此会话已关闭子代理。用户可以在 Workflow 中或使用 /workflow on 启用它们。
jouzu-cli-subagent-providerInProcess = 模型：此提供方使用进程内扩展。请为子代理选择带有内置 API 的提供方。
jouzu-cli-subagent-sessionChangedBeforeStart = 会话在代理能够启动前发生了变化。请在此会话中重试。
jouzu-cli-subagent-settingChangedBeforeLaunch = 子代理设置在启动前发生了变化。请重试任务分配。
jouzu-cli-subagent-authenticationSignIn = 认证：请登录所选的代理提供方并重试。
jouzu-cli-subagent-authenticationApiKeyProvider = 认证：请为子代理选择 API 密钥或令牌提供方。
jouzu-cli-subagent-cacheWarmingSettingsUnreadable = 无法读取子代理的缓存预热设置。请在重试前检查 settings.json。
jouzu-cli-subagent-settingChangeInProgress = 请等待子代理设置更改完成。
jouzu-cli-subagent-parentTranscriptUnavailable = 追踪：父会话尚无保存的记录。
jouzu-cli-subagent-mainPlacementRequired = 请选择允许在主会话中使用的定义。
jouzu-cli-subagent-mainRoleIdleRequired = 更改主代理角色前请等待主代理结束。
jouzu-cli-subagent-roleAuthenticationUnavailable = 模型：此角色的认证不可用。
jouzu-cli-subagent-modelArgumentUserOnly = 只有用户才能在 Workflow 中更改子代理模型。请省略 model 参数。
jouzu-cli-subagent-resumeContextOmit = 恢复会保留其原始上下文。请省略仅用于启动的字段 context、entryIds 和 parentContext（或使用 null）。
jouzu-cli-subagent-resumeWorkspaceKeep = 恢复会保留原始工作区。要使用其他目录，请启动新的代理。
jouzu-cli-subagent-offsetNonnegative = 偏移必须是非负整数。
jouzu-cli-subagent-operationUnsupported = 请选择受支持的子代理操作。
jouzu-cli-subagent-commandDescription = 打开子运行；使用 show 或 hide 控制仪表板
jouzu-cli-subagent-workflowCommandDescription = 打开代理和运行；on/off/toggle 控制此会话的子代理
jouzu-cli-subagent-callLabel = 子代理 · { $operation }
jouzu-cli-subagent-callPreparing = 正在准备
jouzu-cli-subagent-agentNotRunning = 代理已不再运行。
jouzu-cli-subagent-storageRecordUnreadable = 存储：无法读取某个代理记录。请在重试前检查已保存的会话。
jouzu-cli-subagent-sessionClosed = 此代理会话已关闭。
jouzu-cli-subagent-agentsOwnedByAnotherProcess = 此会话的代理由另一个 Jouzu 进程控制。在开始更多工作前请关闭它。
jouzu-cli-subagent-invalidRunDirectory = 存储：无效的运行目录。
jouzu-cli-subagent-invalidEventFile = 存储：无效的代理事件文件。
jouzu-cli-subagent-runNotFoundInSession = 在此父会话中未找到代理运行。
jouzu-cli-subagent-completionRecordNotFound = 未找到代理完成记录。
jouzu-cli-subagent-readBounds = 读取：请使用非负的字节偏移和 1–32000 字节的上限。
jouzu-cli-subagent-readPastEnd = 读取偏移已超过代理输出的末尾。
jouzu-cli-subagent-readCharacterBoundary = 读取偏移必须从 UTF-8 字符边界开始。请使用上一页的 nextOffset。
jouzu-cli-subagent-childSessionUnavailable = 追踪：保存的子会话不可用。
jouzu-cli-subagent-taskLength = 任务：请输入 1–32000 个字符。
jouzu-cli-subagent-childPlacementRequired = 请选择可作为子代理运行的角色。
jouzu-cli-subagent-queueFull = 代理队列已满。请等待工作结束。
jouzu-cli-subagent-resumeParentContextKeep = 恢复会保留原始父上下文。要更改它，请启动新的代理。
jouzu-cli-subagent-resumeActiveRun = 恢复此代理前请先停止或结束它。
jouzu-cli-subagent-resumeIdentityRequired = 恢复需要原始工作区、角色修订和明确选择的模型。
jouzu-cli-subagent-parentContextUnavailable = 保存的父上下文不可用。
jouzu-cli-subagent-childFollowUpActive = 此子会话已有活动的后续指令。
jouzu-cli-subagent-childSessionMissing = 保存的子会话不可用。
jouzu-cli-subagent-parentSnapshotTooLarge = 上下文：父快照超过 32 MB。请使用 parentContext: false 搭配全新上下文，或使用聚焦的拼接。
jouzu-cli-subagent-messageLength = 消息：请输入 1–16000 个字符。
jouzu-cli-subagent-notRunningUseResume = 此代理未在运行。后续指令请使用 Resume。
jouzu-cli-subagent-runNotFound = 未找到代理运行。
jouzu-cli-subagent-stopIncomplete = 部分子代理无法停止。请检查 Runs，并对每个活动的子代理重试 Stop。
jouzu-cli-subagent-storageSaveFailed = 保存代理结果时存储失败。
jouzu-cli-subagent-lockReleaseFailed = 进程锁释放失败；在开始更多代理前请重启 Jouzu。{ $detail }
jouzu-cli-subagent-traceBounds = 追踪：偏移必须是非负的字节游标，上限必须是 1–100。
jouzu-cli-subagent-traceKind = 追踪：请选择 all、messages、tools、errors 或 compaction。
jouzu-cli-subagent-traceQuery = 追踪：请使用最多 2000 个字符的文本查询和字符串 entryId。
jouzu-cli-subagent-traceNotRegularFile = 追踪：会话路径不是常规文件。
jouzu-cli-subagent-tracePastEnd = 追踪：偏移已超过会话末尾。
jouzu-cli-subagent-traceLineBoundary = 追踪：偏移必须是一行 JSONL 的开头。请使用上一页的 nextOffset。
jouzu-cli-subagent-traceMalformedEntry = 追踪：字节 { $offset } 处有格式错误的完整 JSONL 条目。请检查已保存的会话文件。
jouzu-cli-subagent-traceEntryTooLarge = 追踪：某个条目超过 8 MB 的扫描上限。请直接读取已保存的会话文件。
jouzu-cli-subagent-contextMode = 上下文：请选择 fresh、fork 或 splice。
jouzu-cli-subagent-contextParentLookup = 上下文：parentContext 必须是 true 或 false。
jouzu-cli-subagent-contextEntryIdsMode = 上下文：entryIds 仅在 context: splice 时有效，但本次启动使用 { $mode }。请省略 entryIds，或如果接口要求该字段则发送 null。除非你打算共享选定的父条目，否则不要切换到 splice。
jouzu-cli-subagent-contextSpliceIds = 上下文：splice 需要来自活动父分支的 1–100 个消息或压缩条目 ID。调用 subagent 并传入 { $command } 获取 ID，然后用这些 ID 重试。对于全新的任务分配，请同时省略 context 和 entryIds（或发送 null）。

# The flow-control status view and its notices. State values, wait tokens,
# dependency handles, and provider/model IDs are passed as arguments, never
# stored here. A stage word is display text; an unknown internal stage stays
# as the producer named it.
jouzu-cli-flow-stage-contextPreparation = 上下文准备
jouzu-cli-flow-stage-modelConversion = 模型转换
jouzu-cli-flow-input-continueAfterCompaction = 压缩后继续
jouzu-cli-flow-input-multiloopResume = 已分离目标的恢复通知
jouzu-cli-flow-status-blockedOneRequest = 已阻止：{ $count } 个请求未发送。
jouzu-cli-flow-status-blockedManyRequests = 已阻止：{ $count } 个请求未发送。
jouzu-cli-flow-status-requestEndedDuring = 请求在{ $stage }期间结束；未接纳任何负载。
jouzu-cli-flow-status-requestEndedBeforeAdmission = 请求在负载接纳前结束。未记录发送；回执未指明原因。
jouzu-cli-flow-status-requiredInputRemovedBeforeSending = 必需的输入在发送前被移除或更改。
jouzu-cli-flow-status-requiredContextRemovedBeforeSending = 必需的上下文在发送前被移除或更改。
jouzu-cli-flow-status-requiredInputRemovedDuring = 必需的输入在{ $stage }期间被移除或更改。
jouzu-cli-flow-status-requiredContextRemovedDuring = 必需的上下文在{ $stage }期间被移除或更改。
jouzu-cli-flow-status-commandNotRun = 命令未运行。仅在仍然需要时重新运行它。
jouzu-cli-flow-status-extensionNoticeNotDelivered = 扩展通知未送达。它不会被排队重放。
jouzu-cli-flow-status-notQueuedForReplay = 未排队重放。仅在仍然需要时再次提交。
jouzu-cli-flow-status-savedStateBlocksInput = 已保存的流状态仍在阻止此输入。重置前请运行 /flow details 检查它。
jouzu-cli-flow-status-waitingForRequestBlock = 正在等待上方的请求阻止被清除。
jouzu-cli-flow-status-heldBehindBlocker = 被阻止项挡在后面
jouzu-cli-flow-status-heldInput = 已保留的输入
jouzu-cli-flow-status-inputDetailsUnavailable = 输入详情不可用
jouzu-cli-flow-status-taskDetailsUnavailable = 任务：详情不可用
jouzu-cli-flow-status-taskLabel = 任务 #{ $id }：{ $subject }
jouzu-cli-flow-status-showingEntries = 正在显示 { $total } 个条目中的 { $from }-{ $to } 个。
jouzu-cli-flow-status-noEntriesOnPage = 第 { $page } 页没有条目。
jouzu-cli-flow-status-waitUnmetDeadline = { $unmet } 个未满足；截止时间还有 { $minutes }m。
jouzu-cli-flow-status-waitUnmetPastDeadline = { $unmet } 个未满足；已过截止时间。
jouzu-cli-flow-status-ageJustNow = 刚刚
jouzu-cli-flow-status-ageMinutes = { $minutes }m 前
jouzu-cli-flow-status-ageHoursMinutes = { $hours }h { $minutes }m 前
jouzu-cli-flow-status-eligibleForAutomation = 可用于自动化。
jouzu-cli-flow-status-eligibleForAutomationWithStatus = 可用于自动化；任务状态：{ $status }。
jouzu-cli-flow-status-taskCompleted = 任务已完成。
jouzu-cli-flow-status-taskState = 任务状态：{ $state }
jouzu-cli-flow-status-taskDetailsChanged = 任务详情已更改；流状态尚未同步。
jouzu-cli-flow-status-liveWaitOne = { $count } 个活动等待
jouzu-cli-flow-status-liveWaitMany = { $count } 个活动等待
jouzu-cli-flow-status-noLiveWait = 无活动等待
jouzu-cli-flow-status-deadlineExpiresIn = 将在 { $duration } 后到期
jouzu-cli-flow-status-deadlinePast = 已过截止时间
jouzu-cli-flow-status-repairCauseClear = 修复原因，然后运行 /flow clear 并发送新消息。
jouzu-cli-flow-status-resumeNow = 立即恢复：/flow resume
jouzu-cli-flow-status-durationUnderMinute = 不到一分钟
jouzu-cli-flow-status-durationMinutes = { $minutes }m
jouzu-cli-flow-status-durationHours = { $hours }h
jouzu-cli-flow-status-durationHoursMinutes = { $hours }h { $minutes }m
jouzu-cli-flow-status-senderExtension = 扩展
jouzu-cli-flow-status-customMessage = 自定义消息
jouzu-cli-flow-status-messageWithNonTextContent = 含非文本内容的消息
jouzu-cli-flow-status-stageRequestPreparation = 请求准备
jouzu-cli-flow-status-titleUnavailable = 标题不可用
jouzu-cli-flow-status-workFallback = 工作
jouzu-cli-flow-status-requestsNotSentHeading = 未发送的请求
jouzu-cli-flow-status-correctCauseThenClear = 纠正报告的原因，然后运行 /flow clear 释放已保存的保留。
jouzu-cli-flow-status-automationAlsoPaused = 自动化也已暂停：{ $reason }。仅运行 /flow resume 无法清除请求阻止。
jouzu-cli-flow-status-inputLine = 输入：{ $id }
jouzu-cli-flow-status-moreRequiredInputs = 还有 { $count } 个必需输入共享此请求。
jouzu-cli-flow-status-requiredContextUnlinked = - 必需的上下文（未链接已提交的消息）
jouzu-cli-flow-status-reasonLine = 原因：{ $reason }
jouzu-cli-flow-status-failureLine = 失败：{ $code }，记录于 { $recordedAt }
jouzu-cli-flow-status-destinationLine = 目的地：{ $provider } / { $model }
jouzu-cli-flow-status-providerFallback = 提供方
jouzu-cli-flow-status-modelFallback = 模型
jouzu-cli-flow-status-requestLine = 请求：{ $id }
jouzu-cli-flow-status-retryAfterCorrection = 纠正后重试：/flow retry { $id }
jouzu-cli-flow-status-resetPreservesRecords = 重置会保留这些记录；它不会重新发送失败的请求。
jouzu-cli-flow-status-blockedRecoveryDecision = 已阻止：已保存的工作需要恢复决策。
jouzu-cli-flow-status-turnInProgress = 模型轮次正在进行中。
jouzu-cli-flow-status-furtherAutomationPaused = 进一步的自动化已暂停：{ $reason }
jouzu-cli-flow-status-pausedLine = 已暂停：{ $reason }
jouzu-cli-flow-status-resumeAutomation = 使用 /flow resume 恢复自动化，或发送新消息。
jouzu-cli-flow-status-otherRecoveryBlockersHeading = 其他恢复阻止项
jouzu-cli-flow-status-statusIncompleteHeading = 状态不完整
jouzu-cli-flow-status-unreadableState = 无法读取的状态尚未清除。运行 /flow runtime 查看构建详情。
jouzu-cli-flow-status-sentOutcomeUnknownHeading = 已发送，结果未知
jouzu-cli-flow-status-sendAgain = 再次发送（可能重复工作）：/flow resolve { $id } retry
jouzu-cli-flow-status-doNotResend = 不要重发：/flow resolve { $id } discard
jouzu-cli-flow-status-waitingOnJobsHeading = 正在等待作业
jouzu-cli-flow-status-waitingForDependency = 正在等待 { $dependency }
jouzu-cli-flow-status-moreJobDependencies = 还有 { $count } 个作业依赖。
jouzu-cli-flow-status-cancelWaitOnly = 仅取消等待：/flow cancel { $token }
jouzu-cli-flow-status-undeliveredInputHeading = 未送达的输入
jouzu-cli-flow-status-workEligibilityHeading = 工作资格
jouzu-cli-flow-status-workLine = 工作：{ $id }
jouzu-cli-flow-status-pauseLine = 暂停：/flow pause { $id }
jouzu-cli-flow-status-stopLine = 停止：/flow stop { $id }
jouzu-cli-flow-status-notAttachedHeading = 未附加到此会话
jouzu-cli-flow-status-nothingHeld = 没有任何内容被保留、扣留、等待或未解决。
jouzu-cli-flow-status-fullIdentifiers = 完整标识符和控制：/flow details
jouzu-cli-flow-status-moreEntries = 更多条目：/flow details { $page }
jouzu-cli-flow-status-previousEntries = 较早的条目：/flow details { $page }
jouzu-cli-flow-notice-pauseAfterInterrupt = 流控制在中断后暂停。自动化工作会在你的下一条消息时恢复。运行 /flow 查看详情。
jouzu-cli-flow-notice-pauseAfterAdmissionFailure = 流控制在接纳失败后暂停。待处理的工作被保留。运行 /flow 查看详情，运行 /flow clear 释放保留，或运行 /flow reset 重置送达。
jouzu-cli-flow-notice-pausedAfterReopen = 重新打开此会话后流控制处于暂停状态。用 /flow 检查；用 /flow resume 或你的下一条消息恢复自动化。
jouzu-cli-flow-notice-flowOffHeadline = 流控制已关闭。
jouzu-cli-flow-notice-flowOnHeadline = 流控制已重新开启。
jouzu-cli-flow-notice-flowResetHeadline = 流控制已重置。
jouzu-cli-flow-notice-flowOffTail = 作业、任务和车道现在通过各自的送达路径运行和报告。
jouzu-cli-flow-notice-flowOnTail = 保留的结果和等待已生效，并从下一个空闲边界开始运行。
jouzu-cli-flow-notice-withheldRequestNeedsClear = 被扣留的请求仍需要 /flow clear。
jouzu-cli-flow-notice-flowOffCommandUnavailable = /flow { $verb } 在 /flow on 后再次可用。
jouzu-cli-flow-notice-alreadyPaused = 已暂停：{ $reason }。使用 /flow resume 释放它。
jouzu-cli-flow-notice-pausedEveryTurn = 已暂停此会话中的每个自动化轮次。使用 /flow resume 释放它。
jouzu-cli-flow-notice-resolvedSpent = 已将 { $target } 解决为已耗尽。其工作不会在此次尝试中再次运行。
jouzu-cli-flow-notice-resolvedUndelivered = 已将 { $target } 解决为未送达。其工作再次符合条件，并可能重复提供方已回答的轮次。
jouzu-cli-flow-notice-stoppedWork = 已停止 { $target }。其等待已取消，且不会再为其运行自动化轮次。它启动的任何作业会继续运行。
jouzu-cli-flow-notice-pausedWork = 已暂停 { $target }。其自动化轮次会被保留，直到 /flow resume { $target }。
jouzu-cli-flow-notice-resumedWork = 已恢复 { $target }。其自动化轮次可以再次运行。
jouzu-cli-flow-notice-flowClearReleasedOne = Flow clear 释放了 { $count } 个请求保留。回执证据已保留。请继续发送新消息。
jouzu-cli-flow-notice-flowClearReleasedMany = Flow clear 释放了 { $count } 个请求保留。回执证据已保留。请继续发送新消息。
jouzu-cli-flow-notice-flowClearReleasedOneReservation = Flow clear 释放了 { $count } 个请求保留并清除了预留 { $attemptId }。回执证据已保留。请继续发送新消息。
jouzu-cli-flow-notice-flowClearReleasedManyReservation = Flow clear 释放了 { $count } 个请求保留并清除了预留 { $attemptId }。回执证据已保留。请继续发送新消息。
jouzu-cli-flow-compaction-label = 压缩上下文
jouzu-cli-flow-message-work = ▶ 工作
jouzu-cli-flow-message-alert = ⚠ 警报
jouzu-cli-flow-registry-rebuilt = 此会话的流注册表与当前版本不兼容，已被丢弃。流状态已从记录中重建。
jouzu-cli-flow-registry-rebuiltSaved = 此会话的流注册表与当前版本不兼容，已被丢弃。流状态已从记录中重建。被丢弃的状态已保存到 { $path }。
jouzu-cli-flow-noReply-label = 结束轮次且不回复
jouzu-cli-flow-ownership-busy = 此会话分支已被另一个附加实例拥有。
jouzu-cli-flow-ownership-failed = 无法获取流所有权。
jouzu-cli-flow-native-editedInput = 已编辑的原生输入需要新的观察。
jouzu-cli-flow-native-observationRetained = 无法保留原生输入观察。
jouzu-cli-flow-native-queueAdmission = 队列接纳未能完成。
jouzu-cli-flow-native-queueHeld = 排队的输入被会话策略保留。
jouzu-cli-flow-native-compactionProviderFailed = 压缩提供方在负载接纳前失败：{ $message }
jouzu-cli-flow-native-maintenanceNoAdmission = 维护提供方在未接纳负载的情况下返回。
jouzu-cli-flow-native-providerNoAdmission = 原生提供方在未接纳负载的情况下返回。运行 /flow 查看恢复选项。
jouzu-cli-flow-native-providerFailed = 提供方请求在负载接纳前失败（{ $provider } / { $model }）：{ $message }。运行 /flow 查看恢复选项。
jouzu-cli-flow-native-noFailureDescription = 未返回失败描述。
jouzu-cli-flow-ingress-hostAdmission = 输入被主机接纳策略保留。
jouzu-cli-flow-ingress-recoveryReconciliation = 输入正在等待恢复协调。
jouzu-cli-flow-ingress-semanticAdmission = 输入正在等待更新的语义接纳。
jouzu-cli-flow-ingress-providerOutcomeUnknown = 提供方结果未知。
jouzu-cli-flow-service-resolvedSpent = 已从 /flow 解决为已耗尽。
jouzu-cli-flow-service-resolvedUndelivered = 已从 /flow 解决为未送达。
jouzu-cli-flow-ledger-invalidRequestSummary = 无效的请求摘要。
jouzu-cli-flow-ledger-invalidRetiredAttempts = 无效的已退役尝试。
jouzu-cli-flow-ledger-noComposedInput = 没有组合输入在过滤后留存。
jouzu-cli-flow-ledger-outcomeUnknown = 附加丢失后请求结果未知。
jouzu-cli-flow-ledger-requiredFiltered = 必需的输入或完整的聚合元数据被过滤。
jouzu-cli-flow-ledger-handoffCancelled = 未发送的交接在重新附加时被取消。
jouzu-cli-flow-results-label = 读取完成结果
jouzu-cli-flow-submission-deferredContextCancellation = 延迟的上下文取消需要移除协调。
jouzu-cli-flow-submission-queueCancellation = 队列取消需要移除协调。
jouzu-cli-flow-submission-deliveryUnknown = 已发送，但模型是否收到未知。
jouzu-cli-flow-submission-unavailable = 输入未派发且无法送达。请再次提交以运行它。
jouzu-cli-flow-task-continuationSkipped = 已跳过任务延续，因为其任务已更改。
jouzu-cli-flow-wait-label = 等待依赖
jouzu-cli-flow-wait-cancelLabel = 取消依赖等待
jouzu-cli-selfUpdate-lockBusy = 另一个 Jouzu 更新正在运行
jouzu-cli-flow-message-reviewNote = 完成并不意味着审查批准。
jouzu-cli-flow-controller-producerInput = 生产者输入不可用。
jouzu-cli-flow-controller-producerState = 生产者状态不可用。
jouzu-cli-flow-controller-resultInput = 结果输入不可用。
jouzu-cli-flow-controller-resultMetadata = 结果元数据不可用。
jouzu-cli-flow-controller-waitDecisionInput = 等待决策输入不可用。
jouzu-cli-flow-controller-aggregateCapacity = 聚合元数据超过可用容量。
jouzu-cli-flow-controller-resultCapacity = 结果超过剩余的组合输入容量。

# Session labels: the /labels status block, its command list, the command
# description, and the command notices. The state words are catalog text so a
# locale change localizes them; the provider/model identity is a protected value
# passed as an argument.
jouzu-cli-sessionLabels-status-automaticNaming = 自动命名：{ $state }。全局：{ $global }；会话：{ $session }。
jouzu-cli-sessionLabels-status-namingModel = 命名模型：{ $model }。
jouzu-cli-sessionLabels-status-sessionNamePane = 会话名称：{ $name }。窗格：{ $pane }。
jouzu-cli-sessionLabels-status-namingRequests = 命名请求：{ $count }/20。
jouzu-cli-sessionLabels-status-globalInvalid = 全局标签设置无效；在修复设置文件之前命名被禁用。
jouzu-cli-sessionLabels-status-revisit = 任务不明确：在再完成 { $count } 个用户轮次后重新查看。
jouzu-cli-sessionLabels-status-runsAfterTurn = 命名在完成的任务轮次后运行；恢复时会检查已保存的标签。
jouzu-cli-sessionLabels-command-show = /labels — 显示状态和命令。
jouzu-cli-sessionLabels-command-global = /labels global on|off — 保存全局命名设置。
jouzu-cli-sessionLabels-command-on = /labels on — 使用所选模型启用命名。
jouzu-cli-sessionLabels-command-off = /labels off — 取消待处理的命名并停止请求。
jouzu-cli-sessionLabels-command-pin = /labels pin — 保护会话名称。
jouzu-cli-sessionLabels-command-auto = /labels auto — 允许自动更改会话名称。
jouzu-cli-sessionLabels-command-panePin = /labels pane pin — 保护此窗格的标题。
jouzu-cli-sessionLabels-command-paneAuto = /labels pane auto — 允许替换此 tmux 窗格的标题。
jouzu-cli-sessionLabels-command-description = 配置自动会话名称和 tmux 窗格标签
jouzu-cli-sessionLabels-notify-requiresInteractive = 会话标签需要交互式会话。
jouzu-cli-sessionLabels-notify-globalUnavailable = 全局标签设置不可用。
jouzu-cli-sessionLabels-notify-selectModel = 请先选择模型。
jouzu-cli-sessionLabels-notify-enableBeforePane = 在认领窗格前，请先启用会话和全局标签。
jouzu-cli-sessionLabels-notify-paneUnavailable = 窗格不可用或由另一个附加实例拥有；标题已保留。
jouzu-cli-sessionLabels-notify-useCommand = 使用 /labels 查看状态和命令。
jouzu-cli-sessionLabels-value-on = 开
jouzu-cli-sessionLabels-value-off = 关
jouzu-cli-sessionLabels-value-pinned = 已固定
jouzu-cli-sessionLabels-value-automatic = 自动
jouzu-cli-sessionLabels-value-guarded = 受保护（未知标题会被保护）
jouzu-cli-sessionLabels-value-selectedModel = 首次命名请求时选择的模型
jouzu-cli-sessionLabels-value-none = 无

# Dashboard policy recovery. The policy error text is a protected value passed
# as an argument.
jouzu-cli-settings-dashboardUnreadable = 无法读取仪表板设置：{ $message }
# Jouzu-owned browser and delegation tool labels, plus the Camoufox tool-result
# screenshot lines. A tool name, a tool ID, and a parameter name stay in code;
# only the display text moves here.
jouzu-cli-tool-fetchUrl-label = 获取 URL
jouzu-cli-tool-searchWeb-label = 搜索网络
jouzu-cli-tool-parentContext-label = 父上下文
jouzu-cli-tool-subagent-label = 子代理
jouzu-cli-camoufox-result-screenshotOmitted = 已省略截图：{ $size } 超过 { $limit } 的附件上限。请使用 screenshot.full_page=false 重试，或降低 screenshot.quality。
jouzu-cli-camoufox-result-screenshotAttached = 截图：{ $mimeType }，{ $size } 已附加到此结果。
# Pre-launch CLI text for the presentation banner and status command, the
# classic-host MCP notice, the keybinding and profile lock messages, the
# process lock errors, the runtime restart suffix, the compaction outcome, and
# the release-extension warnings. Lock file names, CLI option names, tool names,
# and stored diagnostic values are protected values passed as arguments.
jouzu-cli-presentation-windowTitle = Jouzu - { $workspace }
jouzu-cli-presentation-windowTitle-session = Jouzu - { $session } - { $workspace }
jouzu-cli-presentation-bannerVersion-jouzu = jouzu { $version }
jouzu-cli-presentation-bannerVersion-pi = pi { $version }
jouzu-cli-presentation-status-modelNotSelected = 未选择
jouzu-cli-presentation-status-profileNotApplied = 未应用
jouzu-cli-presentation-status-scopedModelsAll = 全部可用
jouzu-cli-presentation-status-contextUsage = { $tokens }/{ $window } 令牌（{ $percent }%）
jouzu-cli-presentation-status-heading = Jouzu 会话状态
jouzu-cli-presentation-status-session = 会话：{ $id }
jouzu-cli-presentation-status-workspace = 工作区：{ $name }
jouzu-cli-presentation-status-model = 模型：{ $model }
jouzu-cli-presentation-status-thinking = 思考：{ $level }
jouzu-cli-presentation-status-context = 上下文：{ $context }
jouzu-cli-presentation-status-scopedModels = 范围模型：{ $models }
jouzu-cli-presentation-status-profile = 配置档案：{ $id }（{ $state }）
jouzu-cli-presentation-status-runtime = 运行时：Jouzu { $jouzu } · Pi { $pi }
jouzu-cli-presentation-status-profileApplied = 已应用
jouzu-cli-presentation-command-statusDescription = 显示当前 Jouzu 会话、模型、上下文和配置档案状态
jouzu-cli-classicHost-mcpUnavailable = 此会话未启用内置的 Model Context Protocol (MCP) 连接。请改用 Jouzu 的文件和网络工具。
jouzu-cli-keybindings-action-conflictDetail = ；与 { $action } 冲突
jouzu-cli-keybindings-action-currentDetail = ；当前 { $binding }
jouzu-cli-keybindings-lockBusy = 另一个按键绑定操作正在进行中
jouzu-cli-profile-lockBusy = 另一个配置档案操作正在进行中
jouzu-cli-processLock-busy = 进程锁被另一个进程持有：{ $path }
jouzu-cli-processLock-unavailable = 无法获取进程锁：{ $path }
# The `/flow runtime` report, the About view, and the startup warning. A
# package name, a path, a version, a start timestamp, and a SHA-256 hash are
# protected values passed as arguments.
jouzu-cli-runtime-patchDiffers = { $package }：必需的流补丁在 { $path } 处不同。请修复安装并重启；运行 /flow runtime 查看路径。
jouzu-cli-runtime-patchUnavailable = 运行时补丁诊断不可用。请修复安装以恢复 /flow runtime 检查。
jouzu-cli-runtime-running = 正在运行 Jouzu { $version }
jouzu-cli-runtime-pi = Pi { $version }
jouzu-cli-runtime-started = 启动于 { $started }
jouzu-cli-runtime-installed = 已安装 Jouzu { $version }
jouzu-cli-runtime-versionUnavailable = 不可用
jouzu-cli-runtime-installedDiffers = 已安装的构建不同。重启 Jouzu 以加载它。
jouzu-cli-runtime-summary = 运行时：Jouzu { $version } · Pi { $pi }
jouzu-cli-runtime-reportHeading = 启动时捕获的包路径和 SHA-256 哈希：
jouzu-cli-runtime-buildChanged = 已安装的 Jouzu 构建已更改。重启 Jouzu 以加载它；/flow runtime 显示正在运行和已安装的版本。
jouzu-cli-runtime-restartAvailable = · 可重启
jouzu-cli-compaction-outcome = 上下文已按代理请求压缩。较早的消息仍可搜索。
jouzu-cli-compaction-outcome-piVcc = 上下文已按代理请求压缩（pi-vcc 摘要）。较早的消息仍可搜索。
jouzu-cli-compaction-continueFailed = 压缩后无法继续：{ $message }
jouzu-cli-releaseExtensions-disabledTools = 已禁用的工具：{ $tools }。
jouzu-cli-releaseExtensions-unavailable = 可选的扩展 { $package }@{ $version } 不可用。{ $tools } { $error } 运行 `jz doctor` 查看详情。
jouzu-cli-releaseExtensions-requiredUnavailable = 发布方拥有的扩展不可用：{ $errors }
jouzu-cli-releaseExtensions-warning = Jouzu 警告：{ $message }
jouzu-cli-releaseExtensions-conflict-one = 与 Jouzu 发布方拥有的工具 "{ $tool }" 冲突；请用 `jz config` 禁用此扩展或其包
jouzu-cli-releaseExtensions-conflict-many = 与 Jouzu 发布方拥有的工具 { $tools } 冲突；请用 `jz config` 禁用此扩展或其包
jouzu-cli-flow-runtimeError = Jouzu 流控制：{ $message }
jouzu-cli-flow-runtimeDiagnosticsUnavailable = 此会话中运行时诊断不可用。
