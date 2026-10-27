# Japanese catalog for the Jouzu CLI.
#
# Same message IDs and placeholders as `en/cli.ftl`. Terminology follows the
# localization glossary.
#
# Reviewed 2026-10-09 by Aki Komori. The safety, authentication, billing, and
# destructive-action wording was checked against real behavior and the English
# source; the remaining messages were checked for correspondence with the
# English text.
jouzu-cli-error-piImport = Jouzu Pi 取り込みに失敗しました: { $message }
jouzu-cli-error-keybindingConflict = { $plan }
jouzu-cli-error-keybindingConflict-recovery = 上記の競合を解消してから、`jouzu keybindings apply` を再度実行してください。
jouzu-cli-error-keybindingConfig = Jouzu のキーバインドに失敗しました: { $message }
jouzu-cli-error-profileState = Jouzu のプロファイル状態を読み取れません: { $message }
jouzu-cli-error-profileState-recovery = 復旧: プロファイル状態ファイルを修復または削除してから、`jouzu profile plan` と `jouzu profile apply` を再度実行してください。
jouzu-cli-error-profileConflict = { $plan }
jouzu-cli-error-profileConflict-recovery = 上記の競合を解消してから、`jouzu profile apply` を再度実行してください。
jouzu-cli-error-usage = エラー: { $message }
jouzu-cli-error-usage-hint = Jouzu の使い方は `jouzu --help`、Pi の使い方は `jouzu pi --help` を実行してください。
jouzu-cli-error-generic = Jouzu の実行に失敗しました: { $message }
jouzu-cli-error-update = Jouzu の自己更新に失敗しました: { $message }
jouzu-cli-args-optionValueRequired = { $option } には値が必要です
jouzu-cli-args-internalParserError = { $option } の内部パーサーエラー
jouzu-cli-args-catalogOperationRequired = catalog には "status"、"refresh"、"accept"、"validate"、"conformance" のいずれかが必要です
jouzu-cli-args-catalogAcceptOptionsRequireValues = catalog accept のオプションには値が必要です
jouzu-cli-args-catalogUnknownAcceptOption = 不明な catalog accept オプション: { $option }
jouzu-cli-args-catalogAcceptUsage = catalog accept には <revision> --digest <sha256> [--source <source-id>] が必要です
jouzu-cli-args-catalogFileRequired = catalog { $operation } にはファイルパス 1 つと省略可能な --json が必要です
jouzu-cli-args-catalogUnknownOption = 不明な catalog { $operation } オプション: { $token }
jouzu-cli-args-selfUpdateOperationRequired = self-update には "status"、"check"、"apply"、"policy" のいずれかが必要です
jouzu-cli-args-selfUpdatePolicyRequired = self-update ポリシーは auto-restart、notify、off のいずれかでなければなりません
jouzu-cli-args-selfUpdatePolicySingleValue = self-update ポリシーが受け取る値は 1 つだけです
jouzu-cli-args-selfUpdateUnknownOption = 不明な self-update { $operation } オプション: { $token }
jouzu-cli-args-keybindingsOperationRequired = keybindings には "status"、"plan"、"apply"、"reset" のいずれかが必要です
jouzu-cli-args-keybindingsUnknownOption = 不明な keybindings { $operation } オプション: { $token }
jouzu-cli-args-profileMixedSelection = profile --profile <core|ja> を使用し、--jouzu-profile と混在させないでください
jouzu-cli-args-profileOperationRequired = profile には "plan" または "apply" が必要です
jouzu-cli-args-profileRepeatedOption = --profile は 1 回だけ指定できます
jouzu-cli-args-profileInvalidId = --profile は次のいずれかでなければなりません: { $values }
jouzu-cli-args-profileRepeatedJson = --json は 1 回だけ指定できます
jouzu-cli-args-profileUnknownOption = 不明な profile { $operation } オプション: { $token }
jouzu-cli-args-homeRepeated = --jouzu-home は 1 回だけ指定できます
jouzu-cli-args-launchProfileRepeated = --jouzu-profile は 1 回だけ指定できます
jouzu-cli-args-launchProfileInvalidId = --jouzu-profile は次のいずれかでなければなりません: { $values }
jouzu-cli-args-uiLocaleRepeated = --jouzu-ui-locale は 1 回だけ指定できます
jouzu-cli-args-uiLocaleInvalid = --jouzu-ui-locale は次のいずれかでなければなりません: { $values }
jouzu-cli-args-textguardRepeated = { $option } は 1 回だけ指定できます
jouzu-cli-args-unknownJouzuOption = 不明な Jouzu オプション: { $token }
jouzu-cli-args-textguardOffStrict = --jouzu-textguard-off と --jouzu-textguard-strict は同時に指定できません
jouzu-cli-args-textguardOffFiles = --jouzu-textguard-off と --jouzu-textguard-files は同時に指定できません
jouzu-cli-args-doctorUnexpectedToken = doctor は { $token } を受け付けません
jouzu-cli-args-versionHelpArguments = { $command } は引数を受け付けません。Pi には `jouzu pi { $command }` を使用してください

# Pre-launch help, version, doctor, and report text.
# Same message IDs and placeholders as `en/cli.ftl`. Terminology follows the
# localization glossary.
#

jouzu-cli-help-title = Jouzu エージェント型 AI 環境
jouzu-cli-help-usageHeading = 使用方法:
jouzu-cli-help-commandsHeading = コマンド:
jouzu-cli-acp-model = モデル
jouzu-cli-acp-reject = 拒否
jouzu-cli-acp-formUnavailable = この ACP ホストはフォーム入力に対応していないため、ダイアログをキャンセルしました。
jouzu-cli-help-command-acp = 標準入出力で Agent Client Protocol の接続を受け付けます
jouzu-cli-help-command-doctor = 変更を加えない実行環境と分離の診断を表示します
jouzu-cli-help-command-catalog = 任意のカタログ設定を調べるか、カタログファイルを検証します
jouzu-cli-help-command-profilePlan = 書き込みせずに Core/JA プロファイルの安全な変更を確認します
jouzu-cli-help-command-profileApply = 選択したプロファイルを競合とバックアップとともに適用します
jouzu-cli-help-command-keybindings = Jouzu の Pi 互換キー既定を調べる、適用する、またはリセットします
jouzu-cli-help-command-selfUpdate = Jouzu の npm 更新を調べる、確認する、適用する、または設定します
jouzu-cli-help-command-pi = 残りの引数をすべて固定した Pi へ明示的に渡します
jouzu-cli-help-textguard-scanning = TextGuard は既定でスキルとウェブ内容をローカルで走査します。
jouzu-cli-help-textguard-handling = フラグが付いたウェブ結果は信頼できないデータとしてラベル付けされてモデルに届きます。フラグが付いたスキルは、承認するまで差し止められます。
jouzu-cli-help-textguard-controls = 対話セッションで `{ $reviewCommand }` を使うと検出内容を確認でき、`{ $onCommand }`、`{ $strictCommand }`、`{ $offCommand }` でそのセッションの走査を変更できます。
jouzu-cli-help-option-textguardStrict = フラグが付いたすべての入力を承認まで差し止めます
jouzu-cli-help-option-textguardOff = 走査をオフにして開始します
jouzu-cli-help-option-textguardFiles = 通常の読み取りツールの内容も走査します
jouzu-cli-help-option-uiLocale = 表示言語。auto は OS ロケールに従います
jouzu-cli-help-footer-alias = `{ $alias }` は `{ $command }` と同じ動作をする別名です。
jouzu-cli-help-footer-resume = 終了時に表示される `{ $command }` コマンドで再開します。Jouzu は分離されたセッションルートを解決します。
jouzu-cli-help-footer-profile = 最初の対話起動では、任意の JA プロファイルを有効にする前に確認します。Core がフォールバックです。
jouzu-cli-help-footer-startup = 対話起動ではビューポートを消去し、Jouzu ヘッダーを表示します。`{ $setting }` を設定すると既存の画面を保持します。
jouzu-cli-help-footer-palette = `{ $command }` または { $key } で Jouzu Palette を開きます。
jouzu-cli-help-footer-catalogs = `{ $command }` は設定 / カタログを直接開きます。
jouzu-cli-help-footer-sections = 閲覧モードでは { $nextKey } または { $previousKey } で Palette のセクションを切り替えます。
jouzu-cli-help-footer-pi = Pi の CLI ヘルプには `{ $command }` を使用します。

jouzu-cli-version-jouzu = jouzu { $version }
jouzu-cli-version-pi = pi { $version }
jouzu-cli-version-profileSchema = プロファイルスキーマ { $version }
jouzu-cli-localization-future = Jouzu の言語設定は schemaVersion { $version } を使用しており、このビルドでは解釈できません。英語を使用し、ファイルは変更しません。
jouzu-cli-localization-invalid = Jouzu の言語設定を使用できませんでした（{ $reason }）。英語を使用し、ファイルは変更しません。

# 言語設定とコンテキストポリシーの診断。
# 破損または手で編集された設定ファイルでここに到達する。設定キー、schemaVersion、
# バイト上限、トークン境界は保護値として原文のまま置く。

jouzu-cli-localization-config-notInspected = 言語設定を検査できませんでした
jouzu-cli-localization-config-notRegularFile = 言語設定は通常ファイルでなければなりません
jouzu-cli-localization-config-tooLarge = 言語設定が { $maxBytes } バイトを超えています
jouzu-cli-localization-config-invalidJson = 言語設定が不正な JSON です: { $message }
jouzu-cli-localization-config-notObject = 言語設定はオブジェクトでなければなりません
jouzu-cli-localization-config-unknownFields = 言語設定に不明なフィールドがあります
jouzu-cli-localization-config-schemaVersionInvalid = 言語設定の schemaVersion が無効です
jouzu-cli-localization-config-localizationNotObject = 言語設定には localization オブジェクトが必要です
jouzu-cli-localization-config-unknownLocalizationFields = 言語設定の localization に不明なフィールドがあります
jouzu-cli-localization-uiLocaleNotString = localization.uiLocale は文字列でなければなりません
jouzu-cli-localization-uiLocaleUnsupported = localization.uiLocale はサポートされていない表示言語です: { $value }
jouzu-cli-localization-osCandidateUnsupported = サポートされていない OS ロケール候補です: { $candidate }
jouzu-cli-localization-lockNotRegularFile = localization.lock は通常のロックファイルではありません
jouzu-cli-localization-lockBusy = 別の言語設定の保存が進行中です
jouzu-cli-localization-responseLanguageNotString = localization.responseLanguage は文字列でなければなりません
jouzu-cli-localization-responseLanguageUnsupported = localization.responseLanguage はサポートされていない回答言語です: { $value }
jouzu-cli-localization-artifactPolicyNotObject = localization.artifactPolicy はオブジェクトでなければなりません
jouzu-cli-localization-artifactPolicyFieldInvalid = localization.artifactPolicy.{ $field } はサポートされていない成果物言語です: { $value }

# 信頼済みプロジェクト方針は `<repository root>/.jouzu/localization.json` から読みます。
# 信頼を確立できないリポジトリは読み取らないため、これらの理由は実行環境が信頼済みと
# 報告したリポジトリでのみ表示されます。

jouzu-cli-projectPolicy-notInspected = プロジェクト言語ポリシーを検査できませんでした
jouzu-cli-projectPolicy-notRegularFile = プロジェクト言語ポリシーは通常ファイルでなければなりません
jouzu-cli-projectPolicy-tooLarge = プロジェクト言語ポリシーが { $maxBytes } バイトを超えています
jouzu-cli-projectPolicy-invalidJson = プロジェクト言語ポリシーが不正な JSON です: { $message }
jouzu-cli-projectPolicy-notObject = プロジェクト言語ポリシーはオブジェクトでなければなりません
jouzu-cli-projectPolicy-artifactPolicyNotObject = プロジェクト言語ポリシーの localization.artifactPolicy はオブジェクトでなければなりません

jouzu-cli-context-policy-notBoundedFile = コンテキストポリシーはサイズ制限のある通常ファイルでなければなりません
jouzu-cli-context-policy-notObject = コンテキストポリシーはオブジェクトでなければなりません
jouzu-cli-context-policy-unknownKeys = コンテキストポリシーに不明なキーがあります: { $keys }
jouzu-cli-context-policy-schemaVersionRequired = コンテキストポリシーには schemaVersion { $version } が必要です
jouzu-cli-context-policy-maxTokensRange = コンテキストポリシーの maxContextTokens は { $min } から { $max } までの整数でなければなりません

jouzu-cli-report-problem = 件の問題
jouzu-cli-report-problems = 件の問題
jouzu-cli-report-warning = 件の警告
jouzu-cli-report-warnings = 件の警告

jouzu-cli-doctor-title = Jouzu 診断
jouzu-cli-doctor-notes = 注意
jouzu-cli-doctor-hint = 同じレポートを JSON で得るには `jz doctor --json`、カタログの詳細には `jz catalog status` を実行してください。
jouzu-cli-doctor-upstreamConstraint = 上流の表示に関する制約: 固定版の Pi と第三者の同梱拡張は独自の英語で表示し、Jouzu はこれを翻訳も置換もしません。Jouzu 所有のブラウザーアダプターはツールのラベルを Jouzu カタログから表示します。確認できなかった表示面は未確認のままとなり、翻訳済みには数えません。Pi の固定版または拡張の版が変わったときに再確認します。
jouzu-cli-doctor-section-runtime = 実行環境
jouzu-cli-doctor-section-catalog = モデルカタログ
jouzu-cli-doctor-section-platform = プラットフォーム
jouzu-cli-doctor-section-localization = ローカライズ
jouzu-cli-doctor-section-upstream = 上流境界
jouzu-cli-doctor-section-roots = ルート
jouzu-cli-doctor-section-profile = プロファイル
jouzu-cli-doctor-field-jouzu-version = Jouzu バージョン
jouzu-cli-doctor-field-pi-runtime = Pi 実行環境
jouzu-cli-doctor-field-pi-upstream = Pi 上流
jouzu-cli-doctor-field-pi-packageSource = Pi パッケージソース
jouzu-cli-doctor-field-pi-qualification = Pi 適格性
jouzu-cli-doctor-field-profile-schema = プロファイルスキーマ
jouzu-cli-doctor-field-extensions-releaseOwned = 同梱の拡張機能
jouzu-cli-doctor-field-skills-packageOwned = パッケージ同梱のスキル
jouzu-cli-doctor-field-extensions-compatibilityDependencies = 互換性依存関係
jouzu-cli-doctor-field-camoufox-runtime = 任意の Camoufox 実行環境
jouzu-cli-doctor-field-update-installChannel = インストール方法
jouzu-cli-doctor-field-update-policy = 自己更新ポリシー
jouzu-cli-doctor-field-update-channel = 自己更新のインストール方法
jouzu-cli-doctor-field-update-startupEligible = 自動起動時更新
jouzu-cli-doctor-field-update-lastCheckedAt = 最後の更新確認
jouzu-cli-doctor-field-update-latestVersion = 最後に確認した Jouzu
jouzu-cli-doctor-field-keybindings-status = キーバインド既定
jouzu-cli-doctor-field-keybindings-policy = キーバインドポリシー
jouzu-cli-doctor-field-keybindings-followUpKey = Jouzu の既定フォローアップキー
jouzu-cli-doctor-field-keybindings-dequeueKey = Jouzu の既定デキューキー
jouzu-cli-doctor-field-keybindings-configPath = キーバインド設定
jouzu-cli-doctor-field-executable = 実行ファイル
jouzu-cli-doctor-field-catalog-sources = 有効なカタログ
jouzu-cli-doctor-field-catalog-offerings = 提供モデル数
jouzu-cli-doctor-field-catalog-registration = モデル登録
jouzu-cli-doctor-field-catalog-thinkingLevels = 思考レベル
jouzu-cli-doctor-field-platform = プラットフォーム
jouzu-cli-doctor-field-node = Node
jouzu-cli-doctor-field-locale = ロケール
jouzu-cli-doctor-field-git = Git
jouzu-cli-doctor-field-bash = Bash
jouzu-cli-doctor-field-npm = npm
jouzu-cli-doctor-field-proxy = プロキシ設定
jouzu-cli-doctor-field-extraCaCerts = 追加 CA 設定
jouzu-cli-doctor-field-localization-requested = 要求した表示言語
jouzu-cli-doctor-field-localization-effective = 有効な表示言語
jouzu-cli-doctor-field-localization-source = 表示言語の取得元
jouzu-cli-doctor-field-localization-fallback = 表示言語のフォールバック理由
jouzu-cli-doctor-field-localization-catalogVersion = UI カタログバージョン
jouzu-cli-doctor-field-localization-catalogDigest = UI カタログダイジェスト
jouzu-cli-doctor-field-localization-catalogFallback = UI カタログのフォールバック理由
jouzu-cli-doctor-field-localization-catalogState = UI カタログの対応状態
jouzu-cli-doctor-field-localization-supportStates = 記録済みの UI カタログ状態
jouzu-cli-doctor-field-language-responseLanguage-requested = 要求した回答言語
jouzu-cli-doctor-field-language-responseLanguage-effective = 有効な回答言語
jouzu-cli-doctor-field-language-responseLanguage-source = 回答言語の取得元
jouzu-cli-doctor-field-language-artifactPolicy-requested = 要求した成果物ポリシー
jouzu-cli-doctor-field-language-artifactPolicy-effective = 有効な成果物ポリシー
jouzu-cli-doctor-field-language-artifactPolicy-source = 成果物ポリシーの取得元
jouzu-cli-doctor-field-language-projectPolicy = プロジェクト言語ポリシー
jouzu-cli-doctor-field-upstream-surfaces-total = 記録済みの表示面
jouzu-cli-doctor-field-upstream-surfaces-translated = 翻訳済みの表示面
jouzu-cli-doctor-field-upstream-surfaces-upstreamOwned = 上流所有の表示面
jouzu-cli-doctor-field-upstream-surfaces-notInspected = 未確認の表示面
jouzu-cli-doctor-field-upstream-surfaces-outOfScope = 対象外の表示面
jouzu-cli-doctor-field-upstream-supportStage = 対応段階
jouzu-cli-doctor-field-paths-agentDir = エージェント/設定ルート
jouzu-cli-doctor-field-paths-stateDir = 状態ルート
jouzu-cli-doctor-field-paths-sessionDir = セッションルート
jouzu-cli-doctor-field-paths-cacheDir = キャッシュルート
jouzu-cli-doctor-field-modelPicker-state = モデルピッカー状態
jouzu-cli-doctor-field-isolation-piAgentDir = Pi エージェントルートの置き換え
jouzu-cli-doctor-field-isolation-piSessionDir = Pi セッションルートの置き換え
jouzu-cli-doctor-field-skills-shared = 共有クロスハーネススキル
jouzu-cli-doctor-field-profile-selected = 選択したプロファイル
jouzu-cli-doctor-field-profile-bundledManifest = 同梱プロファイルマニフェスト
jouzu-cli-doctor-field-profile-appliedManifest = 適用済みプロファイルマニフェスト
jouzu-cli-doctor-field-packages-count = 設定済み Pi パッケージ
jouzu-cli-doctor-field-provider-authFile = プロバイダー認証ファイル
jouzu-cli-doctor-field-provider-modelsFile = カスタムモデルファイル
jouzu-cli-doctor-field-provider-environment = プロバイダー環境変数
jouzu-cli-doctor-field-lock-profile = プロファイルロック
jouzu-cli-doctor-field-lock-piImport = Pi 取り込みロック
jouzu-cli-doctor-field-lock-keybindings = キーバインドロック
jouzu-cli-doctor-field-lock-modelPicker = モデルピッカーロック
jouzu-cli-doctor-field-lock-update = 更新ロック
jouzu-cli-doctor-field-lock-camoufoxRuntime = Camoufox 実行環境インストールロック

# Doctor diagnoses. Same message IDs and placeholders as `en/cli.ftl`.
# Terminology follows the localization glossary. Messages marked
#
jouzu-cli-doctor-warning-providerUnconfigured = プロバイダーの資格情報、カスタムモデル設定が見つかりませんでした。`/login` またはプロバイダーの環境変数を使用してください
jouzu-cli-doctor-warning-profileNotApplied = 選択したプロファイルはまだ適用されていません。`jouzu profile apply` を実行してください
jouzu-cli-doctor-warning-profileDrift = 適用済みプロファイルが同梱マニフェストと異なります。`jouzu profile plan` を実行してください
jouzu-cli-doctor-warning-packagesNotArray = settings.json の packages が配列ではありません
jouzu-cli-doctor-warning-packagesUnparseable = settings.json を解析できませんでした
jouzu-cli-doctor-warning-updateLastFailed = 最後の Jouzu 更新操作に失敗しました（{ $code }）
jouzu-cli-doctor-warning-updateStatusUnavailable = 自己更新ステータスを利用できません: { $diagnostic }
jouzu-cli-doctor-warning-keybindingsConflict = Jouzu のキーバインド既定がユーザーのバインドと競合しています。`jouzu keybindings plan` を実行してください
jouzu-cli-doctor-warning-keybindingsStatusUnavailable = キーバインドステータスを利用できません: { $diagnostic }
jouzu-cli-doctor-warning-catalogStatusUnavailable = カタログステータスを利用できません: { $diagnostic }
jouzu-cli-doctor-warning-catalogRegistration = 提供モデル { $total } 件のうち { $complete } 件が、新しいモデルに必要な項目を備えています（{ $gaps }）。{ $effect } 一覧を表示するには `jz catalog status { $sourceId }` を実行してください。
jouzu-cli-doctor-warning-catalogThinkingLevels = 提供モデル { $total } 件のうち { $count } 件が思考レベルを宣言していないため、Jouzu は推論の強度を制御できません。一覧を表示するには `jz catalog status { $sourceId }` を実行してください。
jouzu-cli-doctor-warning-modelPickerUnreadable = モデルピッカー状態を読み取れません: { $message }

# Doctor problems. Same message IDs and placeholders as `en/cli.ftl`.
# Terminology follows the localization glossary. Messages marked
#
jouzu-cli-doctor-problem-nodeUnsupported = Node { $version } はサポート対象外です。Jouzu には 22.19.0 以降が必要です
jouzu-cli-doctor-problem-gitMissing = Git が PATH に見つかりません
jouzu-cli-doctor-problem-bashMissing = Bash が見つかりません。Bash または Git Bash をインストールしてください
jouzu-cli-doctor-problem-npmMissing = npm が PATH に見つかりません。npm は Jouzu の更新に必要です
jouzu-cli-doctor-problem-piVersionMismatch = 固定された Pi { $pinned } は、読み込まれた実行環境 { $loaded } と一致しません
jouzu-cli-doctor-problem-piRuntimeUnavailable = Pi 実行環境を読み込めませんでした: { $diagnostic }
jouzu-cli-doctor-problem-piLockUnqualified = Pi ロックのステータスは { $status } で、適格ではありません
jouzu-cli-doctor-problem-extensionsUnavailable = 必須の同梱拡張機能が利用できません: { $errors }
jouzu-cli-doctor-problem-extensionsOptionalUnavailable = 任意の同梱拡張機能が利用できません: { $failures }。報告されたプラットフォームまたはパッケージのエラーを修正してから、`jz doctor` を再実行してください。
jouzu-cli-doctor-problem-extensionsDisabledTools = 、無効化されたツール: { $tools }
jouzu-cli-doctor-problem-extensionsManifestInvalid = 同梱拡張機能の一覧を利用できません: { $diagnostic }
jouzu-cli-doctor-problem-camoufoxRuntimeInvalid = 任意の Camoufox 実行環境が { $path } で無効です。そのディレクトリを削除してから、ブラウザーツールを再試行してください
jouzu-cli-doctor-problem-lockUnreadable = ロックを検査できませんでした: { $path }
jouzu-cli-doctor-problem-lockStale = 残っているロックが Jouzu の操作を妨げています: { $path }（{ $status }）

jouzu-cli-catalog-title = Jouzu モデルカタログ
jouzu-cli-catalog-title-plural = Jouzu モデルカタログ
jouzu-cli-catalog-sourcesActive = { $configured } ソース中 { $active } ソースが有効
jouzu-cli-catalog-notes = 注意
jouzu-cli-catalog-hint = 1 つのソースには `jz catalog status <source-id>`、保存された記録には --json を追加してください。
jouzu-cli-catalog-unconfigured = モデルカタログのエンドポイントが設定されていません。Jouzu は Pi とローカルのモデル設定を引き続き使用します。
jouzu-cli-catalog-state-unconfigured = 未設定
jouzu-cli-catalog-state-empty = 空
jouzu-cli-catalog-state-active = 有効
jouzu-cli-catalog-state-stale = 更新が必要
jouzu-cli-catalog-state-degraded = 一部制限
jouzu-cli-catalog-problem = 件の問題
jouzu-cli-catalog-problems = 件の問題
jouzu-cli-catalog-warning = 件の警告
jouzu-cli-catalog-warnings = 件の警告
jouzu-cli-catalog-field-endpoint = エンドポイント
jouzu-cli-catalog-field-catalog = カタログ
jouzu-cli-catalog-field-models = モデル
jouzu-cli-catalog-field-registration = 登録
jouzu-cli-catalog-field-thinkingLevels = 思考レベル
jouzu-cli-catalog-field-revision = リビジョン
jouzu-cli-catalog-field-sequence = シーケンス
jouzu-cli-catalog-field-validated = 検証日時
jouzu-cli-catalog-field-credential = 資格情報
jouzu-cli-catalog-field-quarantined = 隔離中の候補
jouzu-cli-catalog-field-lastError = 最後のエラー
jouzu-cli-catalog-valid = モデルカタログは有効です。
jouzu-cli-catalog-invalid = モデルカタログが無効です: { $message }
jouzu-cli-catalog-note-tokenMissing = トークン変数 { $name } が設定されておらず、このソースに保存されたトークンもありません。トークンが利用可能になるまで更新はスキップされます。
jouzu-cli-catalog-note-registrationGaps = 提供モデル { $total } 件のうち { $complete } 件が、新しいモデルに必要な項目を備えています（{ $gaps }）。{ $effect }
jouzu-cli-catalog-note-thinkingLevels = 提供モデル { $total } 件のうち { $count } 件が思考レベルを宣言していないため、Jouzu は推論の強度を制御できません。
jouzu-cli-catalog-note-quarantined = { $count } 件の候補リビジョンが隔離されています。
jouzu-cli-catalog-field-registrationValue = 提供モデル { $total } 件のうち { $complete } 件が、新しいモデルに必要な項目を備えています
jouzu-cli-catalog-field-thinkingLevelsValue = 提供モデル { $total } 件のうち { $count } 件が思考レベルを宣言していません
jouzu-cli-catalog-credential-environmentSet = 環境変数 { $name }（設定済み）
jouzu-cli-catalog-credential-savedToken = 保存されたトークン（環境変数 { $name } は未設定）
jouzu-cli-catalog-credential-environmentNotSet = 環境変数 { $name }（未設定）
jouzu-cli-catalog-status-disabled = 無効
jouzu-cli-catalog-sourceNotFound = カタログソースが見つかりません: { $id }
jouzu-cli-catalog-tokenMissing = トークン変数 { $name } はこの Jouzu プロセスで設定されていません。Jouzu を起動する前にエクスポートするか、設定 / カタログでトークンを保存してから再試行してください。
jouzu-cli-catalog-tokenMissingWithSaved = トークン変数 { $name } はこの Jouzu プロセスで設定されておらず、このソースに保存されたトークンもありません。Jouzu を起動する前にエクスポートするか、設定 / カタログでトークンを保存してから再試行してください。
jouzu-cli-catalog-attempt-http = HTTP { $status }
jouzu-cli-catalog-attempt-timedOut = タイムアウト
jouzu-cli-catalog-discovery-authFailed = カタログの認証に失敗しました（HTTP { $status }）。このカタログが bearer トークン認証を必要とする場合は設定してください。
jouzu-cli-catalog-discovery-accessDenied = カタログへのアクセスが拒否されました（HTTP { $status }）。このカタログが bearer トークン認証を必要とする場合は設定してください。
jouzu-cli-catalog-discovery-authFailedBearer = カタログの認証に失敗しました（HTTP { $status }）。{ $name } またはこのソースに保存されたトークンに、カタログが受け入れる bearer トークンが含まれているか確認してください。
jouzu-cli-catalog-discovery-accessDeniedBearer = カタログへのアクセスが拒否されました（HTTP { $status }）。{ $name } またはこのソースに保存されたトークンに、カタログが受け入れる bearer トークンが含まれているか確認してください。
jouzu-cli-catalog-insecureTransport = このカタログは HTTP を使用しているため、bearer トークンが平文で送信され、ネットワーク上で読み取られる可能性があります。カタログが対応している場合は HTTPS を使用してください。
jouzu-cli-catalog-registrationEffect = Pi に未登録のモデルの提供モデルは破棄されるため、そのモデルがモデル一覧に到達することはありません。
jouzu-cli-catalog-registrationGap-field = { $field }なし
jouzu-cli-catalog-registrationGap-count = { $field }なし { $count } 件
jouzu-cli-catalog-registrationGap-detail = { $model } — { $gap }
jouzu-cli-catalog-registrationField-textModality = テキスト入力
jouzu-cli-catalog-registrationField-contextWindow = コンテキストウィンドウ
jouzu-cli-catalog-registrationField-maxOutputTokens = 最大出力トークン
jouzu-cli-catalog-listSeparator = 、

# カタログソース設定の検証、エンドポイント探索、同期失敗の文言。ソース ID、
# 項目名、添字、URL、メディアタイプ、HTTP ステータスは保護値として引数で渡す。
# 用語は日本語用語集に従う。

jouzu-cli-catalogSource-context-source = カタログソース { $index }
jouzu-cli-catalogSource-context-sourceAuth = カタログソース { $index }.auth
jouzu-cli-catalogSource-context-sourceLabel = カタログソース { $index } のラベル
jouzu-cli-catalogSource-context-sourceLabelBare = カタログソースのラベル
jouzu-cli-catalogSource-context-override = カタログソースの上書き { $id }
jouzu-cli-catalogSource-context-registry = カタログソース登録
jouzu-cli-catalogSource-context-overrides = カタログソースの上書き設定
jouzu-cli-catalogSource-context-credentials = カタログの資格情報
jouzu-cli-catalogSource-context-url = カタログソース URL
jouzu-cli-catalogSource-context-token = カタログトークン
jouzu-cli-catalogSource-context-tokenFor = カタログソース { $id } のトークン
jouzu-cli-catalogSource-unknownField = { $context } に不明な項目があります: { $field }
jouzu-cli-catalogSource-notObject = { $context } はオブジェクトである必要があります
jouzu-cli-catalogSource-notBoundedText = { $context } は空でなく、長さが制限され、制御文字を含まない必要があります
jouzu-cli-catalogSource-invalidSourceId = カタログソース ID は 1〜64 文字の小文字英数字、ドット、ハイフン、アンダースコアで指定してください
jouzu-cli-catalogSource-urlAbsolute = カタログソース URL は絶対 HTTP(S) URL またはホスト名で指定してください
jouzu-cli-catalogSource-urlCredentials = カタログソース URL に資格情報を含めないでください
jouzu-cli-catalogSource-urlQueryOrFragment = カタログソース URL にクエリやフラグメントを含めないでください
jouzu-cli-catalogSource-urlScheme = カタログソース URL は HTTP または HTTPS を使用してください
jouzu-cli-catalogSource-authBearerCredentialRef = { $context } の bearer 認証には環境変数の資格情報参照が必要です
jouzu-cli-catalogSource-authInvalidCredentialRef = { $context } の環境変数の資格情報参照が不正です
jouzu-cli-catalogSource-authType = { $context }.type は none または bearer である必要があります
jouzu-cli-catalogSource-sourceNotObject = カタログソース { $index } はオブジェクトである必要があります
jouzu-cli-catalogSource-sourceRequiresFields = カタログソース { $index } には id、label、url の文字列が必要です
jouzu-cli-catalogSource-sourceEnabledBoolean = カタログソース { $index }.enabled は真偽値である必要があります
jouzu-cli-catalogSource-registryNotObject = カタログソース登録はオブジェクトである必要があります
jouzu-cli-catalogSource-registrySchema = カタログソース登録には schemaVersion 1 と sources 配列が必要です
jouzu-cli-catalogSource-registryNotRegularFile = カタログソース登録はサイズ制限のある通常ファイルである必要があります
jouzu-cli-catalogSource-duplicateId = カタログソース ID が重複しています: { $id }
jouzu-cli-catalogSource-duplicateUrl = カタログソース URL が重複しています: { $url }
jouzu-cli-catalogSource-overrideNotObject = カタログソースの上書き { $id } はオブジェクトである必要があります
jouzu-cli-catalogSource-overrideEnabledBoolean = カタログソースの上書き { $id }.enabled は真偽値である必要があります
jouzu-cli-catalogSource-overridesNotObject = カタログソースの上書き設定はオブジェクトである必要があります
jouzu-cli-catalogSource-overridesSchema = カタログソースの上書き設定には schemaVersion 1 と overrides オブジェクトが必要です
jouzu-cli-catalogSource-overridesNotRegularFile = カタログソースの上書き設定はサイズ制限のある通常ファイルである必要があります
jouzu-cli-catalogSource-credentialsNotObject = カタログの資格情報はオブジェクトである必要があります
jouzu-cli-catalogSource-credentialsSchema = カタログの資格情報には schemaVersion 1 と tokens オブジェクトが必要です
jouzu-cli-catalogSource-credentialsNotRegularFile = カタログの資格情報はサイズ制限のある通常ファイルである必要があります
jouzu-cli-catalogSource-tokenNotString = カタログソース { $id } のトークンは文字列である必要があります
jouzu-cli-catalogSource-builtinImmutableEdit = 組み込みの { $label } カタログソースは編集できません。有効化または無効化だけが可能です
jouzu-cli-catalogSource-builtinImmutableRemove = 組み込みの { $label } カタログソースは削除できません。有効化または無効化だけが可能です
jouzu-cli-catalogSource-reservedId = ソース ID "{ $id }" は組み込みの Shisa API カタログ（{ $url }、env:{ $env }）用に予約されています。この設定項目は別の場所を指すため、組み込みソースは無効のままです
jouzu-cli-catalogSource-signedOut = Shisa からサインアウトしました。再接続するには `/login shisa` を実行してください。
jouzu-cli-catalogSource-discoveryCanceled = カタログエンドポイントの探索を中止しました。
jouzu-cli-catalogSource-unsupportedContentType = 対応していない Content-Type です: { $mediaType }
jouzu-cli-catalogSource-mediaTypeMissing = 不明
jouzu-cli-catalogSource-attemptValid = 有効
jouzu-cli-catalogSource-responseTooLarge = カタログの応答が 16 MiB を超えています
jouzu-cli-catalogSource-noCatalogFound = Jouzu カタログが見つかりません。試行結果: { $attempts }

# カタログ同期失敗の文言。ロックの状態語と HTTP ステータスは保護値として
# 引数で渡す。
jouzu-cli-catalog-sync-refreshBusy = モデルカタログの更新が実行中です（{ $status }）
jouzu-cli-catalog-sync-operationBusy = モデルカタログの操作が実行中です（{ $status }）
jouzu-cli-catalog-sync-authFailed = カタログの認証に失敗しました（HTTP 401）。もう一度サインインするか、このソースの保存済みトークンまたは環境変数の資格情報を更新してください。
jouzu-cli-catalog-sync-accessDenied = カタログへのアクセスが拒否されました（HTTP 403）。このアカウントのカタログアクセス権をサービス提供者に確認してください。
jouzu-cli-catalog-sync-proxyAuth = プロキシが認証を要求しています（HTTP 407）。プロキシの資格情報と設定を確認してください。
jouzu-cli-catalog-sync-httpError = カタログエンドポイントが HTTP { $status } を返しました
jouzu-cli-catalog-sync-noActiveAccount = 有効なカタログアカウントがありません

# 対話式の Pi 設定取り込みプロンプトとその出力。ファイル名、パス、エラーの
# 詳細は保護値として引数で渡す。
jouzu-cli-piImport-questionModels = Pi のカスタムモデルが { $path } にあります。{"\u000A"}models.json を Jouzu の分離された設定にコピーしますか？Pi 側のファイルは変更しません。[y/N]{" "}
jouzu-cli-piImport-questionAuth = 保存済みの Pi プロバイダー資格情報が { $path } にあります。{"\u000A"}auth.json を Jouzu の非公開設定にコピーしますか？Pi 側のファイルは変更しません。[y/N]{" "}
jouzu-cli-piImport-invalidSource = 既存の Pi { $filename } は、通常の JSON オブジェクトではないため取り込みませんでした。
jouzu-cli-piImport-imported = { $filename } を Jouzu に取り込みました。
jouzu-cli-piImport-skipped = Jouzu にすでにあるため、{ $filename } をスキップしました。
jouzu-cli-piImport-importFailed = { $filename } を取り込めませんでした: { $detail }
jouzu-cli-piImport-lockBusy = 別の Pi 取り込みの判断が進行中です

# Catalog failure explanations and locale-selection fallback reasons.
# Same message IDs and placeholders as `en/cli.ftl`. Terminology follows the
# localization glossary.
#
jouzu-cli-catalog-failure-dnsHostname = カタログのホスト名を解決できませんでした。エンドポイント、DNS、VPN 接続を確認してください。
jouzu-cli-catalog-failure-dnsLookup = カタログの DNS 参照が一時的に失敗しました。ネットワーク接続を確認して再試行してください。
jouzu-cli-catalog-failure-connectionRefused = カタログへの接続が拒否されました。エンドポイントとプロキシアドレスを確認してください。
jouzu-cli-catalog-failure-connectionReset = カタログへの接続がリセットされました。接続と、プロキシまたはセキュリティソフトを確認してください。
jouzu-cli-catalog-failure-connectionClosed = カタログへの接続が予期せず閉じられました。接続とプロキシ設定を確認してください。
jouzu-cli-catalog-failure-networkUnreachable = カタログのネットワークに到達できません。ネットワーク、VPN、プロキシ設定を確認してください。
jouzu-cli-catalog-failure-hostUnreachable = カタログのホストに到達できません。ネットワーク、VPN、プロキシ設定を確認してください。
jouzu-cli-catalog-failure-timeout = カタログへのリクエストがタイムアウトしました。接続とプロキシ設定を確認してから再試行してください。
jouzu-cli-catalog-failure-connectTimeout = カタログへの接続がタイムアウトしました。接続とプロキシ設定を確認してください。
jouzu-cli-catalog-failure-headersTimeout = カタログが応答ヘッダーを時間内に送信しませんでした。再試行するか、カタログサービスを確認してください。
jouzu-cli-catalog-failure-bodyTimeout = カタログの応答が停止しました。再試行するか、カタログサービスを確認してください。
jouzu-cli-catalog-failure-networkPermission = カタログへの接続権限が拒否されました。マシンの送信ネットワークポリシーを確認してください。
jouzu-cli-catalog-failure-redirectBlocked = カタログがリクエストをリダイレクトしました。最終的なエンドポイント URL を使用してください。Jouzu はリダイレクトを通じてカタログの資格情報を転送しません。
jouzu-cli-catalog-failure-filesystem = Jouzu はローカルのカタログデータを読み書きできませんでした（{ $code }）。Jouzu データフォルダーの権限、空き容量、別のプログラムが使用していないかを確認してください。
jouzu-cli-catalog-failure-certificate = カタログの証明書検証に失敗しました（{ $code }）。システム時計と信頼された証明書（組織のプロキシ証明書を含む）を確認してください。証明書検証を無効にしないでください。
jouzu-cli-catalog-failure-network = カタログへのリクエストが失敗しました。エンドポイント、ネットワーク接続、プロキシ環境変数、信頼された証明書を確認してください。
jouzu-cli-catalog-failure-cache = Jouzu はローカルのカタログデータにアクセスできませんでした。Jouzu データフォルダーを確認して再試行してください。
jouzu-cli-catalog-sourceNotFoundOrDisabled = カタログソースが見つからないか無効です: { $id }
jouzu-cli-catalog-fallback-noCatalog = "{ $requested }" のカタログがありません（正規ロケール "{ $canonical }"）。英語を使用します
jouzu-cli-catalog-fallback-unsupported = サポートされていないロケール "{ $requested }" です。英語を使用します
jouzu-cli-catalog-fallback-canonical = "{ $requested }" の正確なカタログがありません。正規ロケール "{ $canonical }" を使用します

jouzu-cli-keybindings-title = Jouzu キーバインドプラン
jouzu-cli-keybindings-notes = 注意
jouzu-cli-keybindings-plan = プラン
jouzu-cli-keybindings-desired = 適用するバインド
jouzu-cli-keybindings-actions = 操作
jouzu-cli-keybindings-field-policy = ポリシー
jouzu-cli-keybindings-field-config = 設定
jouzu-cli-keybindings-noChanges = キーバインドの変更は不要です。
jouzu-cli-keybindings-applied = キーバインドのトランザクションを適用しました: { $id }
jouzu-cli-keybindings-reset = キーバインドのトランザクションをリセットしました: { $id }
jouzu-cli-keybindings-alreadyConverged = キーバインド既定はすでに適用済みです。
jouzu-cli-keybindings-alreadyDisabled = キーバインド既定はすでに無効です。
jouzu-cli-keybindings-backup = バックアップ: { $path }

# keybindings.json と keybindings-state.json の検証。ファイル名、アクション ID、
# JSON エラーの詳細は保護値または引数で渡す。
jouzu-cli-keybindings-config-notRegularFile = keybindings.json は通常ファイルである必要があります
jouzu-cli-keybindings-config-invalidJson = keybindings.json の JSON が不正です: { $detail }
jouzu-cli-keybindings-config-notObject = keybindings.json はオブジェクトである必要があります
jouzu-cli-keybindings-config-bindingInvalid = keybindings.json の { $action } のバインドはキーまたはキーの配列で指定してください
jouzu-cli-keybindings-state-notRegularFile = キーバインド状態は通常ファイルである必要があります
jouzu-cli-keybindings-state-invalidJson = キーバインド状態の JSON が不正です: { $detail }
jouzu-cli-keybindings-state-notObject = キーバインド状態はオブジェクトである必要があります
jouzu-cli-keybindings-state-fieldsInvalid = キーバインド状態の項目が不正です
jouzu-cli-keybindings-state-insertedNotObject = キーバインド状態の追加バインドはオブジェクトである必要があります
jouzu-cli-keybindings-state-insertedInvalid = キーバインド状態の追加バインドが不正か重複しています

jouzu-cli-profile-title = Jouzu プロファイルプラン
jouzu-cli-profile-section = プロファイル
jouzu-cli-profile-actions = 操作
jouzu-cli-profile-field-manifest = マニフェスト
jouzu-cli-profile-field-agentRoot = エージェントルート
jouzu-cli-profile-noChanges = プロファイルの変更は不要です。
jouzu-cli-profile-applied = トランザクションを適用しました: { $id }
jouzu-cli-profile-alreadyConverged = プロファイルはすでに適用済みです
jouzu-cli-profile-backups = バックアップ: { $path }

# プロファイル状態と保存済みプロファイル選択の検証。パスと JSON エラーの詳細は
# 保護値として引数で渡す。
jouzu-cli-profile-state-notRegularFile = プロファイル状態は通常ファイルである必要があります: { $path }
jouzu-cli-profile-state-invalidJson = プロファイル状態の JSON が不正です（{ $path }）: { $detail }
jouzu-cli-profile-state-notObject = プロファイル状態はオブジェクトである必要があります
jouzu-cli-profile-state-unknownFields = プロファイル状態に不明な項目があります
jouzu-cli-profile-state-fieldsInvalid = プロファイル状態の項目が不正です（{ $path }）
jouzu-cli-profile-state-targetNotObject = プロファイル状態の管理対象はオブジェクトである必要があります
jouzu-cli-profile-state-targetInvalid = プロファイル状態の管理対象が不正か重複しています
jouzu-cli-profile-choice-notRegularFile = プロファイルの選択は通常ファイルである必要があります
jouzu-cli-profile-choice-invalidJson = プロファイルの選択の JSON が不正です: { $detail }
jouzu-cli-profile-choice-notObject = プロファイルの選択はオブジェクトである必要があります
jouzu-cli-profile-choice-unknownFields = プロファイルの選択に不明な項目があります
jouzu-cli-profile-choice-fieldsInvalid = プロファイルの選択の項目が不正です
jouzu-cli-profile-japaneseEnabled = 日本語サポートを有効にしました。
jouzu-cli-profile-coreFallback = Core プロファイルで続行します。

jouzu-cli-selfUpdate-title = Jouzu 自己更新ステータス
jouzu-cli-selfUpdate-policy = ポリシー: { $value }
jouzu-cli-selfUpdate-installChannel = インストール方法: { $value }
jouzu-cli-selfUpdate-automatic = 自動起動時更新: { $value }
jouzu-cli-selfUpdate-installed = インストール済みバージョン: { $version }
jouzu-cli-selfUpdate-latest = 最後に確認したバージョン: { $value }
jouzu-cli-selfUpdate-lastResult = 最後の結果: { $value }
jouzu-cli-selfUpdate-lastChecked = 最後の確認: { $value }
jouzu-cli-selfUpdate-nextCheck = 次の確認: { $value }
jouzu-cli-selfUpdate-lastUpdated = 最後の更新: { $value }
jouzu-cli-selfUpdate-previous = 前のバージョン: { $value }
jouzu-cli-selfUpdate-lastError = 最後のエラー: { $value }
jouzu-cli-selfUpdate-value-eligible = 対象
jouzu-cli-selfUpdate-value-notEligible = 対象外
jouzu-cli-selfUpdate-value-notChecked = 未確認
jouzu-cli-selfUpdate-value-never = なし
jouzu-cli-selfUpdate-value-due = 予定あり
jouzu-cli-selfUpdate-value-none = なし
jouzu-cli-selfUpdate-available = Jouzu { $version } が利用可能です（インストール済み { $installed }）
jouzu-cli-selfUpdate-current = Jouzu { $installed } は最新です（最新 { $latest }）
jouzu-cli-selfUpdate-applied = Jouzu を { $version } に更新しました。新しいバージョンを使うには Jouzu を再起動してください。
jouzu-cli-selfUpdate-alreadyCurrent = Jouzu { $version } はすでに最新です。
jouzu-cli-selfUpdate-policySet = Jouzu 自己更新ポリシー: { $policy }
jouzu-cli-selfUpdate-restarting = Jouzu を { $from } → { $to } に更新しました。再起動します…

# 自己更新の失敗と復旧の文言。npm コマンド名、終了ステータスまたはエラー
# コード、バージョン、npm のエラーメッセージは保護値として引数で渡す。
jouzu-cli-selfUpdate-unsupportedChannel = 自動インストールは実際のグローバル npm インストールでのみ利用できます。このソース、ローカル、または npx の実行は、それぞれのインストール方法で更新してください
jouzu-cli-selfUpdate-npmCommandFailed = { $operation } の実行に失敗しました（{ $code }）
jouzu-cli-selfUpdate-npmCommandExit = { $operation } の実行に失敗しました（npm 終了コード { $status }）
jouzu-cli-selfUpdate-integrityMismatch = ダウンロードした更新は SHA-512 の検証に失敗しました
jouzu-cli-selfUpdate-updateRolledBack = Jouzu { $version } は検証に失敗したため、{ $current } に戻しました
jouzu-cli-selfUpdate-updateNotInstalled = Jouzu { $version } はインストールされませんでした。{ $current } は検証済みのままです
jouzu-cli-selfUpdate-rollbackFailed = Jouzu の更新と自動ロールバックの両方に失敗しました。npm で以前の Jouzu バージョンを再インストールしてください
jouzu-cli-selfUpdate-restartFailed = 更新後の Jouzu を再起動できませんでした: { $message }
jouzu-cli-selfUpdate-invalidPolicy = 不明な更新ポリシーです: { $policy }
jouzu-cli-selfUpdate-updateFailed = Jouzu の更新に失敗しました
jouzu-cli-selfUpdate-checkFailed = 更新の確認に失敗しました

# Jouzu renderer startup notice, banner labels, help overlay, and the
# first-run profile prompt. Same message IDs and placeholders as `en/cli.ftl`.
#
# authentication, billing, or destructive-action wording.
#

jouzu-cli-presentation-startupNotice = モデルカタログを取得しています…
jouzu-cli-presentation-bannerHint-model = { $command } 選択
jouzu-cli-presentation-bannerHint-hotkeys = { $command } キーバインド
jouzu-cli-presentation-bannerHint-status = { $command } セッション

jouzu-cli-help-overlay-title = Jouzu Help
jouzu-cli-help-overlay-models = { $key }{" "} モデル
jouzu-cli-help-overlay-cycleFavorites = { $key }{" "} お気に入りを切り替え
jouzu-cli-help-overlay-help = { $key }{" "} ヘルプ
jouzu-cli-help-overlay-allShortcuts = { $command }{" "} すべてのキーバインド
jouzu-cli-help-overlay-sessionDetails = { $command }{" "} セッションの詳細
jouzu-cli-help-overlay-runtimeBuilds = { $command }{" "} 実行環境とインストール済みビルド
jouzu-cli-help-overlay-agentsRuns = { $command }{" "} エージェントと実行
jouzu-cli-help-overlay-childDashboard = { $command }{" "} サブエージェントの実行ダッシュボード
jouzu-cli-help-overlay-close = { $key } 閉じる
jouzu-cli-help-overlay-shortcutSeparator = {" "}または{" "}
jouzu-cli-help-overlay-shortcutDescription = Jouzu ヘルプを開く

jouzu-cli-profile-choice-intro = Jouzu は、日本語向けの指示とスキルを含む任意の日本語サポートプロファイルを追加できます。
jouzu-cli-profile-choice-conflict = Jouzu が書き込む前に、既存のプロファイルファイルとの競合を確認します。
jouzu-cli-profile-choice-question = 日本語サポートを有効にしますか？ [y/N]

# The remaining pre-launch literals. Same message IDs and placeholders as
# `en/cli.ftl`. Terminology follows the localization glossary. Messages marked
#
jouzu-cli-doctor-note-isolation = 分離: Pi の標準のグローバル設定、認証、パッケージ、セッションは取り込まれません。プロジェクトのリソースと `~/.agents/skills` は共有の Pi 互換面として残ります。
jouzu-cli-doctor-value-unavailable = 利用できません
jouzu-cli-doctor-value-upstreamSupportStage = Jouzu 所有の UI は英語と日本語で利用でき、Jouzu 所有のブラウザーアダプターはツールのラベルを Jouzu カタログから表示します。固定版の Pi と第三者の同梱拡張は独自の英語で表示します。
jouzu-cli-doctor-value-other = その他
jouzu-cli-doctor-value-globalNpmInstall = グローバル npm インストール
jouzu-cli-doctor-value-localNpmInstall = ローカル npm インストール
jouzu-cli-doctor-value-npxInstall = npx インストール
jouzu-cli-doctor-value-sourceCheckout = ソースチェックアウト
jouzu-cli-doctor-value-complete = 完了
jouzu-cli-doctor-value-noActiveCatalog = 有効なカタログなし
jouzu-cli-doctor-value-camoufoxNotInstalled = 未インストール。最初のブラウザーツール使用時にインストールされます
jouzu-cli-doctor-value-ready = 準備完了
jouzu-cli-doctor-value-invalid = 無効
jouzu-cli-doctor-value-notFound = 見つかりません
jouzu-cli-doctor-value-notSet = 未設定
jouzu-cli-doctor-value-notDetected = 検出されません
jouzu-cli-doctor-value-notApplied = 未適用
jouzu-cli-doctor-value-never = なし
jouzu-cli-doctor-value-notChecked = 未確認
jouzu-cli-doctor-value-eligible = 対象
jouzu-cli-doctor-value-notEligible = 対象外
jouzu-cli-doctor-value-none = なし
jouzu-cli-doctor-value-unreadable = 読み取れません
jouzu-cli-doctor-value-absent = なし
jouzu-cli-doctor-value-present = あり
jouzu-cli-doctor-value-yes = はい
jouzu-cli-doctor-value-no = いいえ
jouzu-cli-doctor-value-lockFree = 空き
jouzu-cli-doctor-value-lockHeldLive = 実行中のプロセスが保持しています（{ $age }）
jouzu-cli-doctor-value-lockHeldDead = 終了したプロセスが残しています（{ $age }、{ $recover } 後に回復可能）
jouzu-cli-doctor-value-lockOwnerUnknown = 所有者を特定できません（{ $age }、{ $recover } 後に回復可能）
jouzu-cli-doctor-value-lockUnreadable = 読み取れません（ロックの検査に失敗しました）
jouzu-cli-doctor-value-lockInvalid = 無効です（通常のロックファイルではありません）
jouzu-cli-doctor-value-nodeSupported = { $version }（サポート対象）
jouzu-cli-doctor-value-nodeUnsupported = { $version }（サポート対象外）
jouzu-cli-doctor-value-extensionsReleaseOwned = 選択 { $selected } 件、準備完了 { $ready } 件、利用不可（任意） { $optional } 件
jouzu-cli-doctor-value-extensionsReleaseOwnedRequired = 選択 { $selected } 件、準備完了 { $ready } 件、利用不可（任意） { $optional } 件、利用不可（必須）あり
jouzu-cli-doctor-value-skillsPackageOwned = 選択 { $selected } 件、準備完了 { $ready } 件
jouzu-cli-doctor-value-compatibilityDependencies = 選択 { $selected } 件
jouzu-cli-doctor-value-catalogRegistration = 提供モデル { $total } 件のうち { $complete } 件が新しいモデルを追加できます
jouzu-cli-doctor-value-catalogThinkingLevels = 提供モデル { $total } 件のうち { $count } 件が思考レベルを宣言していません
jouzu-cli-doctor-value-catalogSource = 提供モデル { $offerings } 件 · { $complete } 件がモデルを追加可能 · { $levels } 件が思考レベルなし
jouzu-cli-doctor-value-modelPicker = プロジェクト既定 { $defaults } 件、お気に入り { $favorites } 件、全体の履歴 { $recents } 件、プロジェクトの対象モデル設定 { $scopes } 件
jouzu-cli-doctor-value-skillsSharedPresent = { $path }（あり）
jouzu-cli-doctor-value-skillsSharedAbsent = { $path }（なし）

jouzu-cli-keybindings-portability-ctrlEnter = ctrl+enter は、ターミナルが Kitty キーボードプロトコルまたは modifyOtherKeys で修飾された Enter キーを報告する必要があります
jouzu-cli-keybindings-portability-ctrlUp = ctrl+up は、ターミナルが修飾された矢印キーを報告する必要があります。tmux ユーザーは extended-keys と extended-keys-format csi-u を有効にしてください
jouzu-cli-keybindings-portability-macMissionControl = macOS はシステムショートカットが変更されるまで Control+Up を Mission Control 用に予約することがあります
jouzu-cli-keybindings-portability-termDumb = TERM=dumb では信頼できる対話的なキーイベントを提供できません
jouzu-cli-keybindings-status-uninitialized = 未初期化
jouzu-cli-keybindings-status-converged = 適用済み
jouzu-cli-keybindings-status-customized = カスタマイズ済み
jouzu-cli-keybindings-policy-applied = 適用済み
jouzu-cli-keybindings-policy-disabled = 無効
jouzu-cli-keybindings-policy-unset = 未設定
jouzu-cli-keybindings-binding-piDefault = Pi の既定または未バインド
jouzu-cli-keybindings-binding-unbound = 未バインド
jouzu-cli-keybindings-upgradeRemoved = Jouzu は以前の { $previous } バインドを { $action } から削除しました。{ $desired } が { $conflictingAction } に割り当てられているためです。`jz keybindings plan` を実行してください。
jouzu-cli-keybindings-bootstrapFailed = Jouzu のキーバインド既定を適用できませんでした: { $message }

jouzu-cli-selfUpdate-report-downloading = Jouzu { $version } をダウンロードしています…
jouzu-cli-selfUpdate-report-installing = Jouzu { $version } をインストールしています…
jouzu-cli-selfUpdate-report-restoring = Jouzu { $version } は検証に失敗しました。{ $current } を復元しています…
jouzu-cli-selfUpdate-report-statusUnrecorded = Jouzu は更新および検証されましたが、更新ステータスを記録できませんでした。
jouzu-cli-selfUpdate-startup-skipped = 自動更新をスキップしました: { $message }
jouzu-cli-selfUpdate-startup-checkFailed = Jouzu の更新確認に失敗しました。{ $current } で続行します（{ $code }）
jouzu-cli-selfUpdate-startup-available = Jouzu { $version } が利用可能です。`jouzu self-update apply` を実行してください
jouzu-cli-selfUpdate-startup-failed = Jouzu の更新に失敗しました。{ $current } で続行します（{ $code }）

jouzu-cli-selfUpdate-policyValue-autoRestart = 自動再起動
jouzu-cli-selfUpdate-policyValue-notify = 通知のみ
jouzu-cli-selfUpdate-policyValue-off = オフ
jouzu-cli-selfUpdate-channelValue-globalNpm = グローバル npm インストール
jouzu-cli-selfUpdate-channelValue-localNpm = ローカル npm インストール
jouzu-cli-selfUpdate-channelValue-ephemeralNpx = npx インストール
jouzu-cli-selfUpdate-channelValue-source = ソースチェックアウト
jouzu-cli-selfUpdate-channelValue-other = その他

jouzu-cli-usage-pinnedPiSelfUpdate = Jouzu は Pi 実行環境を固定しているため、Pi の自己更新を実行できません。代わりに Jouzu を更新してください。`jz update --extensions` などのパッケージのみの更新は引き続き利用できます。
jouzu-cli-usage-catalogAcceptRevisionDigest = catalog accept には正確なリビジョンとダイジェストが必要です
jouzu-cli-usage-catalogFileRequired = catalog { $operation } にはファイルパスが必要です
jouzu-cli-usage-selfUpdatePolicyValue = self-update policy には値が必要です

jouzu-cli-runtime-piLoadFailed = Jouzu は固定した Pi 実行環境を読み込めませんでした: { $diagnostic }
jouzu-cli-runtime-piLoadFailedUnavailable = Jouzu は固定した Pi 実行環境を読み込めませんでした: 利用できません
jouzu-cli-runtime-piPinMismatch = 読み込まれた Pi { $loaded } は、Jouzu が固定した { $pinned } と一致しません

jouzu-cli-catalog-fileNotFound = カタログファイルが存在しません: { $path }
jouzu-cli-catalog-fileNotRegular = カタログパスは通常ファイルでなければなりません: { $path }

jouzu-cli-work-withheldRequest = 差し止められたリクエスト
jouzu-cli-work-outcomeUnknown = 結果不明
jouzu-cli-work-jobExit = 終了コード { $code }

# Palette key-bar actions and shared view labels. Same message IDs and
# placeholders as `en/cli.ftl`. Terminology follows the localization glossary.
jouzu-cli-palette-value-unknown = 不明
jouzu-cli-palette-action-refresh = 更新
jouzu-cli-palette-action-favorite = お気に入り
jouzu-cli-palette-action-compactAndSwitch = 圧縮して切り替え
jouzu-cli-palette-action-cancel = キャンセル
jouzu-cli-palette-action-selectAndSaveForProject = 選択してプロジェクトに保存
jouzu-cli-palette-action-cursor = カーソル
jouzu-cli-palette-action-move = 移動
jouzu-cli-palette-action-section = セクション
jouzu-cli-palette-action-browse = 閲覧
jouzu-cli-palette-action-search = 検索
jouzu-cli-palette-action-close = 閉じる
jouzu-cli-palette-action-view = 表示
jouzu-cli-palette-action-edit = 編集
jouzu-cli-palette-action-change = 変更
jouzu-cli-palette-action-toggle = 切り替え
jouzu-cli-palette-action-back = 戻る
jouzu-cli-palette-action-next = 次
jouzu-cli-palette-action-previous = 前
jouzu-cli-palette-action-confirm = 確定
jouzu-cli-palette-action-newline = 改行
jouzu-cli-palette-action-returnToForm = フォームに戻る

# The Models view.
jouzu-cli-modelPicker-refreshingCatalog = モデルカタログを更新しています…
jouzu-cli-modelPicker-filterNotSaved = 絞り込みの選択を保存できませんでした: { $message }
jouzu-cli-modelPicker-modelUnavailable = このモデルは利用できません。プロバイダーまたはカタログの資格情報を確認してください。
jouzu-cli-modelPicker-compactAndSwitch = 現在のコンテキストを圧縮して { $model } に切り替えますか？
jouzu-cli-modelPicker-statePreserved = 読み取れないモデルピッカー状態を { $path } に退避しました
jouzu-cli-modelPicker-filter-recent = 履歴
jouzu-cli-modelPicker-filter-favorite = お気に入り
jouzu-cli-modelPicker-filter-all = すべて
jouzu-cli-modelPicker-section-current = 使用中
jouzu-cli-modelPicker-section-previous = 前回
jouzu-cli-modelPicker-section-favorite = お気に入り
jouzu-cli-modelPicker-section-project = プロジェクト
jouzu-cli-modelPicker-section-recent = 履歴
jouzu-cli-modelPicker-section-all = すべて
jouzu-cli-modelPicker-title-confirm = 確定
jouzu-cli-modelPicker-title-search = 検索
jouzu-cli-modelPicker-detail = { $name } · コンテキスト { $context } · 最大 { $max }{ $default }
jouzu-cli-modelPicker-projectDefault = プロジェクト既定
jouzu-cli-modelPicker-refreshTimeout = モデルの更新がタイムアウトしました。キャッシュされたモデルを表示します。
jouzu-cli-modelPicker-refreshFailed = モデルの更新に失敗しました。キャッシュされたモデルを表示します: { $detail }
jouzu-cli-modelPicker-catalogRefreshed = モデルカタログを更新しました。
jouzu-cli-modelPicker-catalogRefreshTimeout = モデルカタログの更新がタイムアウトしました。キャッシュされたモデルを表示します。
jouzu-cli-modelPicker-catalogRefreshFailed = モデルカタログの更新に失敗しました。キャッシュされたモデルを表示します: { $detail }
jouzu-cli-modelPicker-compacting = { $model } に切り替える前に圧縮しています…
jouzu-cli-modelPicker-selecting = { $model } を選択しています…
jouzu-cli-modelPicker-favoriteAdded = { $model } をお気に入りに追加しました。
jouzu-cli-modelPicker-favoriteRemoved = { $model } をお気に入りから削除しました。
jouzu-cli-modelPicker-catalogsNotRefreshed = カタログを再取得できませんでした: { $sources }。キャッシュされたカタログデータは引き続き利用できます。カタログを開いて再試行してください。
jouzu-cli-modelPicker-catalogsWereNotRefreshed = カタログを再取得できませんでした: { $message } キャッシュされたカタログデータは引き続き利用できます。カタログを開いて再試行してください。
jouzu-cli-modelPicker-modelAvailabilityNotRefreshed = モデルの可用性を再取得できませんでした: { $message } `/reload` を実行してください。
jouzu-cli-modelPicker-switchQueued = モデルの切り替えを次のモデル呼び出しに予約しました: { $model }。
jouzu-cli-modelPicker-thinkingLevelNotApplied = 保存された思考レベルを適用できませんでした: { $message }
jouzu-cli-modelPicker-catalogSettingsRequireTui = カタログ設定には対話的な TUI モードが必要です。
jouzu-cli-modelPicker-modelsNotRefreshed = モデルを再取得できませんでした: { $message } Models を開いて再試行してください。
jouzu-cli-modelPicker-providersNotRefreshed = モデルプロバイダーを再取得できませんでした: { $providers }。Models を開いて再試行してください。
jouzu-cli-modelPicker-startup-projectDefault = プロジェクト既定
jouzu-cli-modelPicker-startup-lastUsed = 最後に使用したモデル
jouzu-cli-modelPicker-startup-unavailable = { $label } は利用できません: { $model }
jouzu-cli-modelPicker-startup-notAuthenticated = { $label } は認証されていません: { $model }
jouzu-cli-modelPicker-startup-notApplied = { $label } を適用できませんでした: { $message }
jouzu-cli-modelPicker-thinkingLevelNotSaved = 思考レベルを保存できませんでした: { $message }
jouzu-cli-modelPicker-recencyNotSaved = モデルの使用履歴を保存できませんでした: { $message }
jouzu-cli-modelPicker-switchedTo = { $model } に切り替えました。
jouzu-cli-modelPicker-queuedSwitchFailed = 予約したモデル切り替えに失敗しました: { $message }
jouzu-cli-modelPicker-modelSelectBinding = モデル選択のキーバインド
jouzu-cli-modelPicker-favoriteSwitchInProgress = お気に入りモデルの切り替えがすでに進行中です。
jouzu-cli-modelPicker-noFavoriteModelsAdd = お気に入りモデルがありません。{ $key } で Models を開き、モデル上で { $toggle } を押してお気に入りに追加してください。
jouzu-cli-modelPicker-noFavoriteModelsAvailable = 現在の対象モデル内で利用できるお気に入りモデルがありません。
jouzu-cli-modelPicker-noFavoriteFits = 現在のコンテキストに収まるお気に入りモデルがありません。{ $key } で Models を開いて圧縮して切り替えてください。
jouzu-cli-modelPicker-onlyOneFavorite = 利用できるお気に入りモデルが 1 つだけです。
jouzu-cli-modelPicker-favoriteUnavailable = お気に入りモデルを利用できません: { $model }
jouzu-cli-modelPicker-noAuthentication = { $model } の認証がありません
jouzu-cli-modelPicker-favoriteSwitchFailed = お気に入りモデルの切り替えに失敗しました: { $message }
jouzu-cli-modelPicker-favoritesUsage = Jouzu はお気に入りでモデルをすばやく切り替えます。{ $key } で Models を開き、モデル上で { $toggle } を押してお気に入りに追加してください。
# Models 行のマーカーとピッカーの空状態、および `catch` が
# `ctx.ui.notify(…, "error")` に渡す 3 つのエラー文。行マーカーの先頭の空白は
# 値の一部であり、`{" "}` リテラルで書く。モデル ID は保護値として渡す。
jouzu-cli-modelPicker-row-unavailable = {" "}利用不可
jouzu-cli-modelPicker-row-contextSmall = {" "}コンテキスト不足
jouzu-cli-modelPicker-empty = 一致するモデルがありません
jouzu-cli-modelPicker-catalogDisabled = 選択したモデルカタログが無効か利用できません。Models を開いてモデルを選択してください。
jouzu-cli-modelPicker-modelUnavailableDetail = モデルを利用できません: { $model }
jouzu-cli-modelPicker-noAuthenticationCredential = { $model } の認証がありません。カタログを開いて資格情報を確認してください。
# Models ビューの残りの失敗文言。選択コールバックが最初の 1 つをピッカーの
# メッセージ領域へ投げ、更新コールバックが後の 2 つを更新失敗の `{ $detail }` として
# 投げる。モデル ID は保護値として渡す。
jouzu-cli-modelPicker-waitForActiveCall = 実行中のモデル呼び出しが完了するまで待ってから、圧縮して切り替えてください。
jouzu-cli-modelPicker-refreshUnavailable = モデルの更新を利用できません
jouzu-cli-modelPicker-refreshAborted = モデルの更新が中止されました
jouzu-cli-modelPicker-refreshFailedProviders = { $providers } を再取得できませんでした
jouzu-cli-modelPicker-modelsNotRefreshedDetail = モデルを再取得できませんでした: { $message }
jouzu-cli-modelPicker-providersNotRefreshedDetail = モデルプロバイダーを再取得できませんでした: { $providers }
jouzu-cli-modelPicker-catalogsNotRefreshedDetail = カタログを再取得できませんでした: { $message }
jouzu-cli-modelPicker-catalogIgnored = キャッシュされたモデルカタログを無視しました: { $message }
jouzu-cli-modelPicker-runtimeDiagnosticsUnavailable = 実行環境の診断を利用できません。

# The Workflow view's rows and confirmations.
jouzu-cli-workflow-row-subagents = サブエージェント
jouzu-cli-workflow-row-concurrency = 同時実行数
jouzu-cli-workflow-row-childWriters = 書き込み可能なサブエージェント
jouzu-cli-workflow-row-addAgent = + エージェントを追加
jouzu-cli-workflow-row-roleId = ロール ID
jouzu-cli-workflow-row-description = 説明
jouzu-cli-workflow-row-model = モデル
jouzu-cli-workflow-row-placement = 配置
jouzu-cli-workflow-row-reviewOnly = レビューのみ
jouzu-cli-workflow-row-childTools = サブエージェントのツール
jouzu-cli-workflow-row-thinking = 思考
jouzu-cli-workflow-row-timeoutSeconds = タイムアウト（秒）
jouzu-cli-workflow-row-maximumTurns = 最大ターン数
jouzu-cli-workflow-row-instructions = 指示
jouzu-cli-workflow-row-save = 保存
jouzu-cli-workflow-row-useInMainSession = メインセッションで使用
jouzu-cli-workflow-row-launchAgent = エージェントを起動…
jouzu-cli-workflow-row-duplicateAsNewAgent = 新しいエージェントとして複製
jouzu-cli-workflow-row-deleteDefinition = 定義を削除…
jouzu-cli-workflow-row-deleteConfirm = { $agent } を削除しますか？既存の実行は残ります。
jouzu-cli-workflow-row-cancel = キャンセル
jouzu-cli-workflow-row-sameAsThisSession = このセッションと同じ
jouzu-cli-workflow-row-assignment = 割り当て
jouzu-cli-workflow-row-workspace = ワークスペース
jouzu-cli-workflow-row-readOutput = 出力を読む
jouzu-cli-workflow-row-sendMessage = メッセージを送信…
jouzu-cli-workflow-row-stopAgent = エージェントを停止…
jouzu-cli-workflow-row-stopConfirm = { $agent } を停止しますか？既に行った変更は残ります。
jouzu-cli-workflow-row-resumeWithTask = タスクを指定して再開…
jouzu-cli-workflow-row-backToRuns = 実行一覧に戻る
jouzu-cli-workflow-confirm-disableSubagents = このセッションでサブエージェントを無効にし、待機中および実行中のすべてのサブエージェントを停止しますか？既に行った変更は残ります。

# ワークフロー表示の残り: 段階の接尾辞、セクションとグループの見出し、項目の値、
# パネルの状態とエラーの文言。モードとセクションの値（`browse`、`agents`、
# `runs`、`parallel`）は内部識別子でありコードに残す。表示語だけをカタログに置く。
# 件数と解決済みのキーバインドは引数として渡す。
jouzu-cli-workflow-stage-editAgent = エージェントを編集
jouzu-cli-workflow-stage-chooseModel = モデルを選択
jouzu-cli-workflow-stage-run = 実行
jouzu-cli-workflow-stage-output = 出力
jouzu-cli-workflow-stage-confirm = 確認
jouzu-cli-workflow-stage-editAssignment = 割り当てを編集
jouzu-cli-workflow-stage-editInstructions = 指示を編集
jouzu-cli-workflow-label-agents = エージェント
jouzu-cli-workflow-label-runs = 実行
jouzu-cli-workflow-label-definition = 定義
jouzu-cli-workflow-label-setting = 設定
jouzu-cli-workflow-label-actions = 操作
jouzu-cli-workflow-label-models = モデル
jouzu-cli-workflow-label-task = タスク
jouzu-cli-workflow-value-on = オン
jouzu-cli-workflow-value-off = オフ
jouzu-cli-workflow-value-yes = はい
jouzu-cli-workflow-value-no = いいえ
jouzu-cli-workflow-value-inParallel = 並列
jouzu-cli-workflow-value-oneAtATime = 1 つずつ
jouzu-cli-workflow-value-characters = { $count } 文字
jouzu-cli-workflow-value-writeTask = タスクを入力
jouzu-cli-workflow-value-unavailableSubagentsOff = 利用不可: サブエージェントはオフ
jouzu-cli-workflow-value-costUnknown = コスト不明
jouzu-cli-workflow-meta-thisSession = このセッション
jouzu-cli-workflow-meta-inSession = セッション内
jouzu-cli-workflow-headingMeta-defined = 定義 { $count } 件
jouzu-cli-workflow-headingMeta-runs = { $active ->
    [0] セッション内 { $count } 件
   *[other] { $active } 件実行中 · セッション内 { $count } 件
}
jouzu-cli-workflow-headingMeta-followsSessionModel = セッションのモデルに従います
jouzu-cli-workflow-headingMeta-more = さらに
jouzu-cli-workflow-action-enablingSubagents = サブエージェントを有効化
jouzu-cli-workflow-action-disablingSubagents = サブエージェントを無効化
jouzu-cli-workflow-action-launchAgent = エージェントを起動
jouzu-cli-workflow-action-sendMessage = メッセージを送信
jouzu-cli-workflow-action-resumeAgent = エージェントを再開
jouzu-cli-workflow-message-operationFailed = 操作に失敗しました。
jouzu-cli-workflow-message-operationFailedRetry = 操作に失敗しました。再試行してください。
jouzu-cli-workflow-message-couldNotLoad = Workflow を読み込めませんでした。
jouzu-cli-workflow-message-childWritersParallel = 書き込み可能なサブエージェントが同じワークスペースを共有する場合、同じファイルへの同時編集が競合することがあります。
jouzu-cli-workflow-message-childWritersSerial = 書き込み可能なサブエージェントはワークスペースごとに 1 つずつ実行されます。
jouzu-cli-workflow-hint-editAgent = エージェントを編集
jouzu-cli-workflow-hint-inspectRun = 実行を確認
jouzu-cli-workflow-empty-noMatchingModels = 一致するモデルがありません。検索条件を編集してください。
jouzu-cli-workflow-empty-noChildRuns = このセッションにサブエージェントの実行はありません。

# issue #53 で `perform`、`openText`、`detail` の各 API から移したワークフロー
# の文言。これらの引数はカタログ ID を取るため、呼び出し側のリテラル文は型検査
# を通らない。実行の状態とコンテキストのモードは引数で渡す保護値である。
jouzu-cli-workflow-error-formUnavailable = Workflow のフォームを利用できません。キャンセルして開き直してください。
jouzu-cli-workflow-error-saveOrCancelEdits = この定義を使用する前に、編集内容を保存するかキャンセルしてください。
jouzu-cli-workflow-error-subagentsOff = サブエージェントはオフです。作業を割り当てる前に Workflow で有効にしてください。
jouzu-cli-workflow-error-runNotFound = エージェントの実行が見つかりませんでした。
jouzu-cli-workflow-error-writeAssignment = 送信する前に割り当てを入力してください。
jouzu-cli-workflow-message-running = { $label }…
jouzu-cli-workflow-message-complete = { $label } が完了しました。
jouzu-cli-workflow-message-saved = { $agent } を保存しました。
jouzu-cli-workflow-message-concurrencySet = 同時実行数を { $value } に設定しました。
jouzu-cli-workflow-title = · Workflow{ $stage }
jouzu-cli-workflow-title-busy = · 実行中
jouzu-cli-workflow-hint-saveInForm = 変更はフォームの「保存」でのみ保存されます。
jouzu-cli-workflow-stage-editWorkspace = ワークスペースを編集
jouzu-cli-workflow-action-applyingAgent = エージェントを適用中
jouzu-cli-workflow-action-sendingTask = タスクを送信中
jouzu-cli-workflow-action-stoppingAgent = エージェントを停止中
jouzu-cli-workflow-field-agent = エージェント
jouzu-cli-workflow-field-model = モデル
jouzu-cli-workflow-field-workspace = ワークスペース
jouzu-cli-workflow-field-context = コンテキスト
jouzu-cli-workflow-field-context-lookupOn = { $mode } · 親の参照: オン
jouzu-cli-workflow-field-context-lookupOff = { $mode } · 親の参照: オフ
jouzu-cli-workflow-field-modelId = モデル ID
jouzu-cli-workflow-field-usage = 使用量
jouzu-cli-workflow-field-result = 結果

# The TextGuard review view's other-list hints. The command name is a protected
# value passed as an argument, not catalog text.
jouzu-cli-textguard-otherView-decisions = 件の項目が判断待ち · { $command }
jouzu-cli-textguard-otherView-reports = 件の検出は内容をブロックしませんでした · { $command }
# TextGuard レビュー画面の残り: 判断アクション、モードの確認、重大度と判定の
# 行、通知と承認の文面。`/textguard` コマンド、検出の種類、重大度の値は保護値
# であり引数で渡す。承認の文面は privacy/safety レビューの対象として未レビュー
# の印を付ける。
jouzu-cli-textguard-action-allowSession = このセッションで許可
jouzu-cli-textguard-action-allowAlways = この内容を常に許可
jouzu-cli-textguard-action-dismiss = レポートを破棄
jouzu-cli-textguard-action-enable = 走査を再びオンにする
jouzu-cli-textguard-action-back = 戻る
jouzu-cli-textguard-mode-guarded = TextGuard は再び走査します。フラグが付いたウェブ結果は信頼できないデータとしてラベル付けされてモデルに届きます。フラグが付いたスキルは、承認するまで差し止められます。
jouzu-cli-textguard-mode-strict = TextGuard はフラグが付いたすべての入力を、{ $command } で承認するまで差し止めます。
jouzu-cli-textguard-mode-off = TextGuard はこのセッションでオフです。{ $command } を実行するまで、内容は走査されずに受け入れられます。
jouzu-cli-textguard-banner-strict = strict モード — フラグが付いたすべての入力を差し止めます
jouzu-cli-textguard-banner-off = このセッションでは走査しません
jouzu-cli-textguard-severity-error = エラー（この内容をブロック）
jouzu-cli-textguard-severity-warn = 警告
jouzu-cli-textguard-severity-info = 情報
jouzu-cli-textguard-finding-line = { $severity }: { $name }{ $codepoint }。
jouzu-cli-textguard-finding-locatedLine = { $severity }: { $name }{ $codepoint }、{ $location }。
jouzu-cli-textguard-counts-noErrors = エラーなし
jouzu-cli-textguard-counts-blocking = { $count ->
    [one] { $count } 件のエラーが、承認するまでこの内容をブロックします
   *[other] { $count } 件のエラーが、承認するまでこの内容をブロックします
}
jouzu-cli-textguard-counts-delivered = { $count ->
    [one] { $count } 件のエラーレベルの検出。内容は信頼できないデータとしてラベル付けされてモデルに届きました
   *[other] { $count } 件のエラーレベルの検出。内容は信頼できないデータとしてラベル付けされてモデルに届きました
}
jouzu-cli-textguard-counts-warning = { $count ->
    [one] 警告 { $count } 件
   *[other] 警告 { $count } 件
}
jouzu-cli-textguard-counts-informational = { $count ->
    [one] 情報レベルの検出 { $count } 件
   *[other] 情報レベルの検出 { $count } 件
}
jouzu-cli-textguard-counts-nonBlockingBoth = { $blocking }。{ $warnings }と{ $notes }はブロックしません。
jouzu-cli-textguard-counts-nonBlockingWarnings = { $blocking }。{ $warnings }はブロックしません。
jouzu-cli-textguard-counts-nonBlockingNotes = { $blocking }。{ $notes }はブロックしません。
jouzu-cli-textguard-evidence-withheld = この内容は承認するまで差し止められたままです。
jouzu-cli-textguard-evidence-delivered = 内容は信頼できないデータとしてラベル付けされてモデルに届きました。
# 未完了の走査が終わらなかった理由。利用者はレビュー画面と通知の詳細で読み、
# モデルは保留結果のツール結果に別途ある固定の英語文を読む。このブロックは
# 利用者向けの側であり、カタログから解決する。
jouzu-cli-textguard-unavailable-inputLimit = 内容が大きすぎて TextGuard が走査できません
jouzu-cli-textguard-unavailable-unsupportedContent = 内容の一部に、画像などスキャナが確認できないものが含まれています
jouzu-cli-textguard-unavailable-findingLimit = 報告しきれないほど多くの検出がありました
jouzu-cli-textguard-unavailable-decodeLimit = 内容に含まれるエンコードされた層が多すぎて、完全にデコードできません
jouzu-cli-textguard-unavailable-outputLimit = スキャナの出力が多すぎました
jouzu-cli-textguard-unavailable-scanner = スキャナを実行できませんでした
jouzu-cli-textguard-unavailable-timeout = 走査が時間内に終わりませんでした
jouzu-cli-textguard-unavailable-process = スキャナが予期せず停止しました
jouzu-cli-textguard-unavailable-version = インストールされているスキャナのバージョンは対応していません
jouzu-cli-textguard-unavailable-protocol = スキャナが読み取れない結果を返しました
jouzu-cli-textguard-unavailable-busy = スキャナが他の作業で忙しい状態でした
jouzu-cli-textguard-unavailable-closed = レビューセッションが終了しました
jouzu-cli-textguard-unavailable-file = 内容を読み取れませんでした
jouzu-cli-textguard-unavailable-budget = 走査に割り当てられた時間がなくなりました
jouzu-cli-textguard-evidence-unavailable = 走査が完了しませんでした: { $reason }。
# 利用者が読む通知の詳細。モデルのバナーと同じ要約だが、カタログから解決して
# ローカライズできるようにする。
jouzu-cli-textguard-detail-errors = { $count ->
    [one] { $count } 件のエラーレベルの検出
   *[other] { $count } 件のエラーレベルの検出
}
jouzu-cli-textguard-detail-errorsWithKinds = { $count ->
    [one] { $count } 件のエラーレベルの検出（{ $kinds }）
   *[other] { $count } 件のエラーレベルの検出（{ $kinds }）
}
jouzu-cli-textguard-detail-warnings = { $count ->
    [one] 警告 { $count } 件
   *[other] 警告 { $count } 件
}
jouzu-cli-textguard-detail-none = 検出なし
jouzu-cli-textguard-detail-unavailable = 走査が完了しませんでした: { $reason }
jouzu-cli-textguard-detail-withheld = TextGuard レビュー — 差し止め中の内容
jouzu-cli-textguard-detail-delivered = TextGuard レビュー — 検出付きで届いた内容
jouzu-cli-textguard-detail-report = TextGuard レビュー — 走査レポート
jouzu-cli-textguard-alert-advisoryReport = 。{ $command } でレポートを表示します
jouzu-cli-textguard-alert-approveInteractive = { $command } を実行して確認し、承認してください。
jouzu-cli-textguard-alert-approveNonInteractive = 対話セッションで { $command } を使って承認してください。
jouzu-cli-textguard-alert-notApprovable = この内容は承認できません。リクエストを再試行してください。
jouzu-cli-textguard-review-pending = { $command } で確認してください。
jouzu-cli-textguard-review-pendingNonInteractive = 内容は差し止められたままです。対話セッションで { $command } を使って確認してください。
jouzu-cli-textguard-review-nothing = TextGuard には判断待ちの項目がありません。{ $extra }
jouzu-cli-textguard-review-incomplete = TextGuard は内容全体を識別できませんでした。リクエストを再試行してください。この内容は承認できません。{ $extra }
jouzu-cli-textguard-review-blockedNothing = { $count ->
    [one] 検出 { $count } 件は内容をブロックしませんでした。{ $command } を参照してください。
   *[other] 検出 { $count } 件は内容をブロックしませんでした。{ $command } を参照してください。
}
jouzu-cli-textguard-approved-persisted = 内容を承認しました。今後のセッションではこの正確なバイト列を受け入れます。変更があれば新しいレビューが必要です。リソースを再読み込みします。
jouzu-cli-textguard-approved-session = このセッションで内容を承認しました。リソースの再読み込み後にリクエストを再試行してください。
# TextGuard の通知文。ローカルの `notify` ヘルパーが表示する。`/textguard` と
# `/reload` のコマンド名とモード値は保護値であり、原文のまま置く。検出の
# 発生元と、解決済みのレポートまたは承認文は引数で渡す。
jouzu-cli-textguard-commandUsage = `/textguard` で検出を確認し、`/textguard reports` で内容をブロックしなかった検出を表示し、`/textguard on`、`strict`、`off` で走査を設定します。
jouzu-cli-textguard-mode-alreadySet = TextGuard はすでに { $mode } に設定されています。
jouzu-cli-textguard-review-pendingSummary = { $count ->
    [one] TextGuard: { $count } 件の項目がレビューを待っています。{ $advice }
   *[other] TextGuard: { $count } 件の項目がレビューを待っています。{ $advice }
}
jouzu-cli-textguard-review-requiresTerminal = TextGuard レビューには対話的なターミナルが必要です。内容は差し止められたままです。
jouzu-cli-textguard-review-requiresSize = TextGuard レビューには少なくとも 48 列と 24 行が必要です。ターミナルのサイズを調整して `/textguard` を再試行してください。
jouzu-cli-textguard-review-unavailable = このセッションでは TextGuard レビューを利用できません。内容は差し止められたままです。
jouzu-cli-textguard-reports-empty = TextGuard に、内容をブロックしなかった検出はありません。
jouzu-cli-textguard-terminalResized = ターミナルのサイズが変更されました。内容は差し止められたままです。サイズを調整して `/textguard` を再試行してください。
jouzu-cli-textguard-review-expired = この TextGuard レビューは失効しました。`/textguard` をもう一度実行してください。
jouzu-cli-textguard-reloadFailed = TextGuard を変更しましたが、リソースを再読み込みできませんでした。再試行する前に `/reload` を実行してください。
jouzu-cli-textguard-approved-reloadFailed = 内容を承認しましたが、リソースを再読み込みできませんでした。再試行する前に `/reload` を実行してください。
# ローカルのヘルパーが返す 2 つのアラート枠。発生元、証拠の詳細、解決済みの
# レポートまたは承認文は引数で渡す。ヘルパーの戻り値のテンプレートは検出器の
# 位置ではないため、この文面は検出されずにカタログへ移す。
jouzu-cli-textguard-alert-flagged = TextGuard が { $source } にフラグを付けました: { $detail }。内容は信頼できないデータとしてラベル付けされてモデルに届きました{ $report }。
jouzu-cli-textguard-alert-withheld = TextGuard が { $source } を差し止めました: { $detail }。{ $next }
# レビュー表示が描画する検出の種類と説明。種類の識別子（`bidi_control`、
# `yara:` ルール、その他のスキャナトークン）は引数で渡す保護値であり、
# この名前と説明がレビュー表示が見せる人向けの文面である。
jouzu-cli-textguard-kind-bidiControl = 双方向制御文字
jouzu-cli-textguard-kind-bidiControl-explanation = この文字はテキストの表示順を逆転させることがあるため、読む内容と処理される内容が一致しないことがあります。
jouzu-cli-textguard-kind-ansiEscape = 端末エスケープシーケンス
jouzu-cli-textguard-kind-ansiEscape-explanation = このシーケンスは端末の色を変えたり、画面上のテキストを隠したりすることがあります。
jouzu-cli-textguard-kind-invisibleChar = 不可視文字
jouzu-cli-textguard-kind-invisibleChar-explanation = この文字は画面に表示されないままテキストを変化させます。
jouzu-cli-textguard-kind-combiningAbuse = 重ねられた結合文字
jouzu-cli-textguard-kind-combiningAbuse-explanation = 結合文字を重ねると、文字が実際に何であるかを偽装できます。
jouzu-cli-textguard-kind-softHyphen = ソフトハイフン
jouzu-cli-textguard-kind-softHyphen-explanation = この不可視文字は単語を分割し、完全一致の照合を回避できます。
jouzu-cli-textguard-kind-tagCharacter = Unicode タグ文字
jouzu-cli-textguard-kind-tagCharacter-explanation = タグ文字は、一見普通の内容の中に追加のテキストを隠すことができます。
jouzu-cli-textguard-kind-variationSelector = 異体字セレクタ
jouzu-cli-textguard-kind-variationSelector-explanation = この不可視文字は、隣の文字の表示方法を変えることがあります。
jouzu-cli-textguard-kind-splitToken = 分割されたキーワード
jouzu-cli-textguard-kind-splitToken-explanation = 「system」や「instructions」のような保護されたキーワードが区切り文字で分割されています。プロンプトインジェクションを隠す一般的な手口です。
jouzu-cli-textguard-kind-decoded = エンコードされたテキスト
jouzu-cli-textguard-kind-decoded-explanation = 内容の一部はエンコードされた形で保存されており、走査前にデコードされました。
jouzu-cli-textguard-kind-normalized = 正規化による変更
jouzu-cli-textguard-kind-normalized-explanation = 内容の一部は、走査前の正規化で書き換えられました。
jouzu-cli-textguard-kind-stripped = 削除された文字
jouzu-cli-textguard-kind-stripped-explanation = 内容の一部は、走査前の正規化で削除されました。
jouzu-cli-textguard-kind-bundledRule = 同梱の検出ルール（{ $rule }）に一致
jouzu-cli-textguard-kind-bundledRule-explanation = 同梱の検出ルールが、攻撃に関連するパターンに一致しました。このルールは内容が悪意あるものかどうかを判断するものではありません。
jouzu-cli-textguard-kind-flaggedPattern = フラグが付いたパターン { $kind }
jouzu-cli-textguard-kind-flaggedPattern-explanation = スキャナが、疑わしいと判断したパターンに一致しました。
# 検出の位置。オフセット、行、列は引数で渡す保護値の数値である。
jouzu-cli-textguard-location-character = 内容の先頭から { $offset } 文字目（0 始まり）
jouzu-cli-textguard-location-line = { $line } 行 { $column } 列目
# レビュー本文の行: 発生元ラベル、内容の指紋、エスケープした本文の見出し、
# 末尾のリスク注意。発生元とダイジェストは引数で渡す保護値である。
jouzu-cli-textguard-review-source = ソース: { $source }
jouzu-cli-textguard-review-fingerprint = 内容のフィンガープリント（SHA-256）: { $digest }
jouzu-cli-textguard-review-notRetained = フラグが付いた内容自体は、ここで表示するために保持されていません。
jouzu-cli-textguard-review-flaggedHeading = フラグが付いた内容（制御文字と不可視文字はエスケープして表示）:
jouzu-cli-textguard-review-riskNotice = 走査はリスクを減らしますが、内容が安全であることを証明できません。許可するかどうかはあなたが決めます。
jouzu-cli-textguard-review-findingsTruncated = { $total } 件の検出のうち最初の { $shown } 件を表示しています。
# 他に何も挙げるものがない場合の単純な件数判定。ブロックの節は解決済みの
# カタログ値であり、末尾の句点はこのメッセージの一部として持つ。
jouzu-cli-textguard-counts-line = { $blocking }。
# レビューオーバーレイの装飾。解決済みのキーバインドヒントと件数は引数で
# 渡す。状態の語はカタログ値ではなくレンダラが固定幅に詰める。
jouzu-cli-textguard-off-title = TextGuard — このセッションでは走査しません
jouzu-cli-textguard-off-body = 内容は走査されずに受け入れられます。スキルとウェブ結果は確認されません。
jouzu-cli-textguard-hint-select = { $keys } 選択
jouzu-cli-textguard-hint-open = { $keys } 開く
jouzu-cli-textguard-hint-close = { $keys } 閉じる
jouzu-cli-textguard-hint-action = { $keys } 操作
jouzu-cli-textguard-hint-scroll = { $keys } スクロール
jouzu-cli-textguard-hint-back = { $keys } 戻る
jouzu-cli-textguard-list-header = TextGuard レビュー
jouzu-cli-textguard-list-summary = { $withheld } 件を差し止め · { $delivered } 件を配信
jouzu-cli-textguard-status-withheld = 差し止め中
jouzu-cli-textguard-status-delivered = 配信済み
jouzu-cli-textguard-status-report = レポート
jouzu-cli-textguard-list-progress = ({ $current }/{ $total })
jouzu-cli-textguard-list-notices = { $count ->
    [one] { $count } 件の確認が内容全体を識別できませんでした。その内容は承認できません。
   *[other] { $count } 件の確認が内容全体を識別できませんでした。その内容は承認できません。
}
jouzu-cli-textguard-detail-progress = （全 { $total } 行中 { $start }〜{ $end } 行）
# ホストがコマンド一覧に表示する `/textguard` コマンドの説明。
jouzu-cli-textguard-commandDescription = TextGuard の検出内容を確認するか、走査を on、strict、off に設定します
# 設定ビュー。キーヒントのラベルは狭い列に収まる短い語、行ラベルは識別列、
# メッセージはパネルの状態または確認の文面である。解決済みのキーバインドと
# キー名は引数として渡す。
jouzu-cli-settings-hint-save = 保存
jouzu-cli-settings-hint-field = 項目
jouzu-cli-settings-hint-changeAuthentication = 認証を変更
jouzu-cli-settings-hint-cancel = キャンセル
jouzu-cli-settings-hint-remove = 削除
jouzu-cli-settings-hint-signOut = サインアウト
jouzu-cli-settings-hint-move = 移動
jouzu-cli-settings-hint-dashboard = ダッシュボード
jouzu-cli-settings-hint-section = セクション
jouzu-cli-settings-hint-close = 閉じる
jouzu-cli-settings-hint-connect = 接続
jouzu-cli-settings-hint-changeView = ビューを変更
jouzu-cli-settings-hint-view = ビュー
jouzu-cli-settings-hint-autoLabels = 自動ラベル
jouzu-cli-settings-hint-displayMode = 表示モード
jouzu-cli-settings-hint-contextLimit = コンテキスト上限
jouzu-cli-settings-hint-edit = 編集
jouzu-cli-settings-hint-add = 追加
jouzu-cli-settings-hint-refresh = 更新
jouzu-cli-settings-hint-enable = 有効化
jouzu-cli-settings-hint-models = モデル

jouzu-cli-settings-label-account = Shisa AI
jouzu-cli-settings-label-contextLimit = 最大コンテキスト
jouzu-cli-settings-label-dashboard = ダッシュボード
jouzu-cli-settings-label-autoLabels = 自動ラベル
jouzu-cli-settings-label-view = ビュー
jouzu-cli-settings-offeringRow = { $provider }/{ $model }

jouzu-cli-settings-loadFailed = カタログ設定を読み込めませんでした: { $message }
jouzu-cli-settings-savedTokensUnreadable = 保存されたトークンを読み取れませんでした: { $message }
jouzu-cli-settings-saving = カタログを保存しています…
jouzu-cli-settings-savedWithNotes = { $base }{ $notes }
jouzu-cli-settings-saveCanceled = カタログの保存をキャンセルしました。
jouzu-cli-settings-refreshing = { $label } を更新しています…
jouzu-cli-settings-contextLimitNotApplied = コンテキスト上限を適用できませんでした: { $message }。モデルは宣言されたコンテキストウィンドウを使用します。
jouzu-cli-settings-contextLimitNotSaved = コンテキスト上限を保存できませんでした: { $message }
jouzu-cli-settings-autoLabelsSaved = グローバルの自動ラベルを保存しました: { $state ->
    [on] オン
   *[off] オフ
}。セッション単位のオフとペインの固定は引き続き尊重されます。
jouzu-cli-settings-autoLabelsNotSaved = 自動ラベルを保存できませんでした: { $message }
jouzu-cli-settings-dashboardSaved = ダッシュボード表示を保存しました: { $mode }。
jouzu-cli-settings-dashboardNotSaved = ダッシュボード表示を保存できませんでした: { $message }
jouzu-cli-settings-signOutConfirm = このデバイスで Shisa からサインアウトするには { $confirm } を押します。{ $cancel } でキャンセルします。保存されたカタログと音声はこのアカウントを使用しなくなります。
jouzu-cli-settings-removed = { $label } を削除しました。
jouzu-cli-settings-builtInSource = { $label } は Jouzu 組み込みのカタログソースです。{ $key } で有効または無効にします。エンドポイントと資格情報の参照は管理されたままです。
jouzu-cli-settings-builtInCannotRemove = { $label } は組み込みのため削除できません。{ $key } で無効にします。
jouzu-cli-settings-removeConfirm = このカタログソースを削除するには { $confirm } を押します。{ $cancel } でキャンセルします。
jouzu-cli-settings-sourceToggled = { $label } { $state ->
    [enabled] 有効
   *[disabled] 無効
}。
jouzu-cli-settings-loginHint = このアカウントを接続するには `/login shisa` を実行してください。
jouzu-cli-settings-signOutFailed = Shisa のサインアウトを完了できませんでした。サインインまたはサインアウトの完了を待ってから再試行してください。
jouzu-cli-settings-field-label = ラベル
jouzu-cli-settings-field-url = URL またはホスト
jouzu-cli-settings-field-auth = 認証
jouzu-cli-settings-auth-none = なし
jouzu-cli-settings-auth-bearer = bearer トークン
jouzu-cli-settings-field-credential = トークン変数
jouzu-cli-settings-field-token = トークン
jouzu-cli-settings-refresh-upToDate = カタログは最新です。
jouzu-cli-settings-refresh-status = カタログ { $status }。
jouzu-cli-settings-hint-scroll = スクロール

# 条件式が持っていた設定パネルの文言。状態語（資格情報、自動ラベル）は内部値を
# キーにした select の variant である。ビュー名はカタログの表示語に従い、
# Catalogs は「カタログ」、Settings は「設定」と表示する。`/catalogs` と
# 識別子は翻訳しない。
jouzu-cli-settings-warning = 警告: { $message }
jouzu-cli-settings-savedQuarantined = { $label } を保存しました。カタログリビジョンは隔離されました: { $reasons }。
jouzu-cli-settings-savedWithCount = { $count ->
    [one] { $label } をモデル { $count } 件で保存しました。
   *[other] { $label } をモデル { $count } 件で保存しました。
}
jouzu-cli-settings-modelCount = { $count ->
    [one] { $count } モデル
   *[other] { $count } モデル
}
jouzu-cli-settings-savedWithoutCheck = カタログを確認せずに { $label } を保存しました。
jouzu-cli-settings-contextLimitOff = コンテキスト上限はオフです。モデルは宣言されたコンテキストウィンドウを使用します。
jouzu-cli-settings-contextLimitSet = コンテキスト上限は { $limit } トークンです。これを超えるモデルは { $limit } を報告し、より早く圧縮します。
jouzu-cli-settings-dashboardOpened = Shisa ダッシュボードを開きました: { $url }
jouzu-cli-settings-dashboardAddress = Shisa ダッシュボード: { $url }
jouzu-cli-settings-form-addHeading = カタログを追加
jouzu-cli-settings-form-editHeading = { $label } を編集
jouzu-cli-settings-credential-availability = { $name } { $state ->
    [set] はこの Jouzu プロセスで設定されています。
    [saved] はこの Jouzu プロセスで設定されていません。保存されたトークンが使用されます。
   *[unset] はこの Jouzu プロセスで設定されていません。
}
jouzu-cli-settings-credential-login = · Shisa サインインを使用中
jouzu-cli-settings-credential-state = · { $name } { $state ->
    [set] 設定済み
    [stored] 未設定、保存済みトークンを使用中
   *[unset] 未設定
}
jouzu-cli-settings-account-connectedDetail = 接続済み · { $detail }
jouzu-cli-settings-account-connected = 接続済み
jouzu-cli-settings-account-connectMeta = { $key } で接続
jouzu-cli-settings-signIn-couldNotComplete = Shisa のサインインを完了できませんでした。この行から再試行するか、`/login shisa` を実行してください。
jouzu-cli-settings-autoLabelsState = { $state ->
    [error] オフ（設定エラー）
    [on] オン
   *[off] オフ
}
jouzu-cli-settings-view-about = About
jouzu-cli-settings-view-catalogs = カタログ
# Settings の「言語」ビュー。3 項目が実効値とその設定元を表示する。設定元の
# トークン（cli、env、config、os、session、project、task、builtin）と
# プレビュー印は引数または保護値として渡される。
jouzu-cli-settings-view-language = 言語
jouzu-cli-settings-heading-language = 言語
jouzu-cli-settings-label-displayLanguage = 表示言語
jouzu-cli-settings-label-responseLanguage = 回答言語
jouzu-cli-settings-label-artifactPolicy = 成果物ポリシー
jouzu-cli-settings-hint-language = 変更
jouzu-cli-settings-hint-cancelPreview = プレビューを取り消す
jouzu-cli-settings-language-sourcePreview = プレビュー
jouzu-cli-settings-language-previewNotice = プレビュー · 未保存。{ $cancel } で取り消します。
jouzu-cli-settings-language-previewCanceled = プレビューを取り消しました。保存はしていません。
# 初回の言語選択。読み違えた言語から戻れるよう、各言語はその言語自身の名前で
# 表示する。自称名はどのカタログでも同じにする。
jouzu-cli-language-self-en = English
jouzu-cli-language-self-ja = 日本語
jouzu-cli-language-self-zhHans = 简体中文
jouzu-cli-language-self-zhHant = 繁體中文
jouzu-cli-language-auto = 自動
jouzu-cli-language-choice-intro = Jouzu の表示言語を選びます。各言語はその言語自身の名前で表示します。
jouzu-cli-language-choice-unavailable = このビルドでは利用できません
jouzu-cli-language-choice-suggested = 推奨
jouzu-cli-language-choice-question = 表示言語（番号、名前、または Enter でスキップ）
jouzu-cli-language-choice-responseIntro = Jouzu が回答を書く言語を選びます。表示言語と別にできます。
jouzu-cli-language-choice-responseQuestion = 回答言語（番号、名前、または Enter で表示言語を使用）
jouzu-cli-language-choice-invalid = 一覧にない言語です: { $value }
jouzu-cli-language-choice-notShipped = このビルドでは { $language } の表示には対応していません。
jouzu-cli-language-choice-saveFailed = 言語の選択を保存できませんでした: { $message }
jouzu-cli-language-choice-skipped = 言語は選択されませんでした。Jouzu は次回も確認します。

# JA プロファイルの可逆移行。プランのプロファイル、移行元、回答言語、
# 資産の値、差分の行、バックアップのパスは引数の保護値であり、文はここに置く。
jouzu-cli-profileMigration-title = Jouzu プロファイル移行プラン
jouzu-cli-profileMigration-section = 移行
jouzu-cli-profileMigration-field-from = 移行元
jouzu-cli-profileMigration-field-to = 移行先
jouzu-cli-profileMigration-fromValue = { $profile }（{ $source }）
jouzu-cli-profileMigration-toValue = 回答言語 { $responseLanguage }、表示言語 { $uiLocale }
jouzu-cli-profileMigration-assets = アセット
jouzu-cli-profileMigration-conflicts = 競合
jouzu-cli-profileMigration-assetDeduplicate = 回答言語設定が指示を提供するため、重複した言語指示を削除します
jouzu-cli-profileMigration-assetPreserve = 編集済みファイルを保持し、重複した行を確認します
jouzu-cli-profileMigration-assetReplace = 配布管理の言語指示を削除します
jouzu-cli-profileMigration-diffKind = { $kind ->
    [remove] 削除
   *[keep] 保持
}
jouzu-cli-profileMigration-resolution-keepEdits = 重複した行を自身で削除するか、プロファイルを再適用して解消してください。
jouzu-cli-profileMigration-resolution-reapplyProfile = プロファイルを再適用して配布管理ファイルを復元してください。
jouzu-cli-profileMigration-temporary = プロファイルの選択は一時的なため、ユーザー全体の設定は変更しません。
jouzu-cli-profileMigration-conflict = プロファイル移行プランに競合があります

# issue #53 でプレーンの `string` の継ぎ目から移した設定パネルの文言: トークン
# の警告と保存時の注記、アカウント行、見出し、空の状態、タイトル、サインインの
# 報告。サインインの `report` クロージャはカタログ ID を取るため、リテラル文は
# 型検査を通らない。
jouzu-cli-settings-warning-tokenNotSet = 警告: トークン変数 { $name } が設定されておらず、このソースに保存されたトークンもありません。設定するかトークンを保存してから更新してください。
jouzu-cli-settings-note-tokenNotSet = トークン変数 { $name } が設定されておらず、保存されたトークンもありません。設定するかトークンを保存してから R で更新してください。
jouzu-cli-settings-note-tokenPrecedence = { $name } はこの Jouzu プロセスで設定されており、保存されたトークンより優先されます。
jouzu-cli-settings-account-notConnected = 未接続
jouzu-cli-settings-heading-modelCatalogs = モデルカタログ
jouzu-cli-settings-empty-noSources = カタログソースが設定されていません。
jouzu-cli-settings-empty-noOfferings = キャッシュされた提供モデルがありません。
jouzu-cli-settings-title = · 設定 / { $view }
jouzu-cli-settings-signIn-requestingCode = Shisa のデバイスコードを要求しています。{ $cancel } でキャンセルできます。
jouzu-cli-settings-signIn-deviceCode = { $uri } を開き、コード { $code } を入力してこのデバイスを承認してください。{ $cancel } でキャンセルできます。
jouzu-cli-settings-signIn-unexpectedPrompt = 想定外の Shisa サインインプロンプトです。
jouzu-cli-settings-signIn-connected = Shisa AI に接続しました。

# 音声導線。録音ウィジェットの状態語とキーヒント、マイクの選択、コマンドの通知、
# およびレビュー対象の取り込みと転送の診断。内部状態値（`starting`、`recording`、
# `finishing`）、`/voice` のサブコマンド名、`[garbled]` マーカーは保護値であり、
# カタログの文言にはしない。状態語は内部値をキーにした select の variant である。
jouzu-cli-voice-label = 音声
jouzu-cli-voice-state-connecting = 音声: 接続中…
jouzu-cli-voice-state-recording = 音声: 録音中
jouzu-cli-voice-state-finishing = 音声: 文字起こしを完了しています…
jouzu-cli-voice-hint-recording = `/voice stop` で挿入 · `/voice cancel` で破棄
jouzu-cli-voice-hint-idle = `/voice cancel` で破棄
jouzu-cli-voice-segment-final = 確定
jouzu-cli-voice-segment-pending = 確定待ち
jouzu-cli-voice-segment-live = 認識中
jouzu-cli-voice-segment-failed = 失敗
jouzu-cli-voice-segment-progress = 確定 { $finalized } 件 · 確定待ち { $pending } 件 · 失敗 { $failed } 件
jouzu-cli-voice-segment-retained = 以前のチャンク { $count } 件を保持
jouzu-cli-voice-status = 音声: { $state ->
   *[starting] 開始中
    [recording] 録音中
    [finishing] 完了処理中
}
jouzu-cli-voice-devices-default = 既定のマイク
jouzu-cli-voice-devices-title = 音声マイク（このマシン）
jouzu-cli-voice-inserted-garbled = 音声テキストを挿入しました。認識できなかった音声は [garbled] になっています。プロンプトを編集してから Enter キーを押して送信してください。
jouzu-cli-voice-inserted = 音声テキストを挿入しました。内容を確認してから Enter キーを押して送信してください。
jouzu-cli-voice-noSpeech = 音声を文字起こしできませんでした。プロンプトは変更されていません。
jouzu-cli-voice-finishFailed = 音声を完了できませんでした。プロンプトは変更されていません。もう一度録音してください。
jouzu-cli-voice-stillFinishing = 音声は準備中または完了処理中です。破棄するには `/voice cancel` を使用してください。
jouzu-cli-voice-alreadyActive = 音声はすでに実行中です。先に停止するかキャンセルしてください。
jouzu-cli-voice-signedOut = Shisa からサインアウトしています。`/voice` を使用する場合は、先に `/login shisa` を実行してください。
jouzu-cli-voice-requiresLogin = 音声には Shisa のサインインまたは SHISA_API_KEY が必要です。`/login shisa` を実行するか SHISA_API_KEY を設定してください。
jouzu-cli-voice-endpointInvalid = 保存された Shisa 音声エンドポイントが無効です。`/login shisa` をもう一度実行してください。
jouzu-cli-voice-startFailed = 音声を開始できませんでした。マイク、ネットワーク、Shisa へのアクセスを確認してください。
jouzu-cli-voice-nonInteractive = 音声入力には、マイクのあるマシン上の対話的なターミナルが必要です。
jouzu-cli-voice-cancelled = 音声をキャンセルしました。プロンプトは変更されていません。
jouzu-cli-voice-devicesBusy = マイクを選択する前に音声を停止するかキャンセルしてください。
jouzu-cli-voice-devicesFailed = マイクの一覧を取得できませんでした。オーディオデバイスとプラットフォームの対応を確認してください。
jouzu-cli-voice-languageBusy = 言語を変更する前に音声を停止するかキャンセルしてください。
jouzu-cli-voice-languageSet = 音声言語: { $language }。
jouzu-cli-voice-usage = `/voice [start|stop|cancel|devices|language auto|language ja|language en|language zh]` を使用してください。
jouzu-cli-voice-captureFailed = マイクの取り込みに失敗しました。入力デバイス、マイクの権限、プラットフォームの対応を確認してください。
jouzu-cli-voice-captureStartTimeout = マイクの起動がタイムアウトしました。オーディオデバイスを確認してください。
jouzu-cli-voice-captureStopTimeout = マイクが停止に応答しませんでした。録音をキャンセルしました。
jouzu-cli-voice-uploadSlow = 音声のネットワーク送信が遅すぎます。接続を確認して再試行してください。
jouzu-cli-voice-uploadFailed = 音声のネットワーク送信に失敗しました。接続を確認して再試行してください。
jouzu-cli-voice-authFailed = 音声の認証に失敗しました。`/login shisa` をもう一度実行するか SHISA_API_KEY を確認してください。
jouzu-cli-voice-accessDenied = 音声へのアクセスが拒否されました。Shisa キーには shisa/asr-realtime へのアクセスが必要です。
jouzu-cli-voice-connectionRejected = 音声接続が拒否されました。サービスの可用性を確認して再試行してください。
jouzu-cli-voice-connectionFailed = 音声接続に失敗しました。ネットワークと Shisa へのアクセスを確認してください。
jouzu-cli-voice-transcriptionFailed = 音声の文字起こしに失敗しました。Shisa サービスへのアクセスを確認して再試行してください。
jouzu-cli-voice-transcriptInvalid = 音声が無効または大きすぎる文字起こし結果を返しました。録音を短くしてください。
jouzu-cli-voice-connectionEnded = 文字起こしが完了する前に音声接続が終了しました。もう一度録音してください。
jouzu-cli-voice-connectionStartFailed = 音声接続を開始できませんでした。再試行してください。
jouzu-cli-voice-transcriptInvalidIdentifier = 音声が無効なセグメント識別子を返しました。
jouzu-cli-voice-transcriptInvalidAudioRange = 音声が無効な音声範囲を返しました。
jouzu-cli-voice-transcriptInvalidReplacementRange = 音声が無効な置換範囲を返しました。
jouzu-cli-voice-transcriptTooLarge = 音声の文字数またはセグメント数が上限に達しました。録音を短くしてください。
jouzu-cli-voice-commandDescription = プロンプトへ音声入力します。開始、停止、キャンセル、設定を行います
jouzu-cli-voice-shortcutDescription = 音声入力を開始または停止します
# shisa-link の認証導線、デバイスフロー、サインアウト。コマンド名
# (`/login shisa`、`/logout shisa`、`/reload`)、アカウント識別子、確認 URL、
# デバイスコードは保護値であり、引数として渡す。
#

jouzu-cli-shisa-onboarding-pointConnect = Shisa AI に接続すると、クラウドモデルや音声入力が利用できます。
jouzu-cli-shisa-onboarding-pointCredits = 無料クレジットなどの特典・利用条件はこちら: https://platform.shisa.ai/jouzu
jouzu-cli-shisa-onboarding-question = 今すぐ接続しますか？ [y/N]
jouzu-cli-shisa-onboarding-hint = （後で `/login shisa` でも接続できます）
jouzu-cli-shisa-onboarding-later = 後で `/login shisa` からでも接続できます。
jouzu-cli-shisa-onboarding-setupChoiceFailed = Shisa のセットアップ選択を保存できませんでした。Jouzu のストレージ権限を確認してください。
jouzu-cli-shisa-onboarding-openLink = 次のリンクを開き、ブラウザーでこのデバイスを承認してください。Ctrl+C でサインインをキャンセルします。
jouzu-cli-shisa-onboarding-deviceCode = デバイスコード: { $code }
jouzu-cli-shisa-onboarding-signedIn = Shisa AI にサインインしました。
jouzu-cli-shisa-onboarding-cancelled = Shisa のサインインをキャンセルしました。
jouzu-cli-shisa-onboarding-couldNotComplete = Shisa のサインインを完了できませんでした。

jouzu-cli-shisa-signIn-confirmFailed = Shisa のサインインは保存されましたが、確認に失敗しました。確認期限を過ぎるとアクセスできなくなるため、もう一度サインインしてください。
jouzu-cli-shisa-signIn-confirmInterrupted = Shisa のサインインは保存されましたが、確認が中断されました。確認期限を過ぎるとアクセスできなくなるため、もう一度サインインしてください。
jouzu-cli-shisa-signIn-unexpectedResponse = Shisa のサインインが想定外の応答を返しました。サインインをやり直してください。
jouzu-cli-shisa-signIn-expired = サインイン要求の有効期限が切れました。サインインをやり直してください。
jouzu-cli-shisa-signIn-declined = サインイン要求はブラウザーで拒否されました。再試行するにはサインインをやり直してください。
jouzu-cli-shisa-signIn-notRecognized = サインイン要求を認識できませんでした。サインインをやり直してください。
jouzu-cli-shisa-signIn-alreadyDelivered = このサインインはすでに API キーを発行済みです。このデバイスをリンクするには新しいサインインを開始してください。
jouzu-cli-shisa-signIn-httpFailed = Shisa のサインインに失敗しました（HTTP { $status }）。サインインをやり直してください。
jouzu-cli-shisa-signIn-storageFailed = Shisa のサインインを保存できませんでした。Jouzu のストレージ権限を確認して、もう一度サインインしてください。
jouzu-cli-shisa-signIn-platformUnreachable = Shisa プラットフォームに接続できませんでした: { $message }
jouzu-cli-shisa-signIn-startFailed = Shisa プラットフォームがサインイン要求を開始できませんでした（HTTP { $status }）。
jouzu-cli-shisa-signIn-unexpectedStart = Shisa プラットフォームが想定外のサインイン応答を返しました。もう一度お試しください。
jouzu-cli-shisa-signIn-timedOut = 要求が承認される前にサインインがタイムアウトしました。サインインをやり直してください。
jouzu-cli-shisa-signIn-cancelled = サインインをキャンセルしました

jouzu-cli-shisa-logout-busy = Shisa のサインインまたはサインアウトがすでに実行中です。完了を待ってください。
jouzu-cli-shisa-logout-couldNotRemove = 保存された Shisa の資格情報を削除できませんでした。Jouzu のストレージ権限を確認して、`/logout shisa` を再試行してください。
jouzu-cli-shisa-logout-signedOutLocally = ローカルでサインアウトしました。キーを取り消すには、Shisa ダッシュボードでこのデバイスを切断してください。
jouzu-cli-shisa-logout-signedOut = Shisa からサインアウトしました。
jouzu-cli-shisa-logout-serverUnconfirmed = サーバー側の取り消しは確認できていません。キーを取り消すには、Shisa ダッシュボードでこのデバイスを切断してください。
jouzu-cli-shisa-logout-envKeyRemains = { $message } SHISA_API_KEY は設定されたままですが、再度サインインするまで Jouzu はこのプロセスで Shisa を使用しません。サインアウトしたままにするには、再起動前にこの変数を解除してください。

jouzu-cli-shisa-refreshFailed = Shisa のモデル可用性を更新できませんでした。`/reload` を実行してください。
jouzu-cli-shisa-signOutFailed = Shisa のサインアウトを完了できませんでした。サインインまたはサインアウトの完了を待ってから、`/logout shisa` を再試行してください。
jouzu-cli-shisa-signedOutReconnect = Shisa からサインアウトしました。再接続するには `/login shisa` を実行してください。
# サブエージェントの結果レンダラー。状態表は内部の実行状態を表示語へ対応付け、
# 状態値は表のキーであり変更しない。実行 ID、パス、モデル ID、ツール名、
# 件数、オフセットは引数として渡す。
jouzu-cli-subagent-status-queued = 待機中
jouzu-cli-subagent-status-starting = 開始中
jouzu-cli-subagent-status-running = 実行中
jouzu-cli-subagent-status-completed = 完了
jouzu-cli-subagent-status-failed = 失敗
jouzu-cli-subagent-status-cancelled = キャンセル
jouzu-cli-subagent-status-interrupted = 中断
jouzu-cli-subagent-status-unknown = 不明
jouzu-cli-subagent-roleFallback = エージェント
jouzu-cli-subagent-runLabel = 実行 { $id }
jouzu-cli-subagent-workspaceLabel = ワークスペース:
jouzu-cli-subagent-elapsed = 経過 { $minutes }分 { $seconds }秒（待機を含む）
jouzu-cli-subagent-modelIdLabel = モデル ID:
jouzu-cli-subagent-tokensLabel = トークン:
jouzu-cli-subagent-cost = コスト: { $amount }
jouzu-cli-subagent-costUnknown = コスト: 不明
jouzu-cli-subagent-candidateIdentityLabel = 候補の識別:
jouzu-cli-subagent-candidateHeadLabel = 候補の HEAD:
jouzu-cli-subagent-identityStability = 識別の安定性はレビューの承認ではありません。
jouzu-cli-subagent-moreRuns = 他に { $count } 件の実行があります。展開するか list を使用してください
jouzu-cli-subagent-noChildRuns = サブエージェントの実行はありません。
jouzu-cli-subagent-nextOffset = 次のオフセット: { $offset }
jouzu-cli-subagent-enabled-on = サブエージェント: オン
jouzu-cli-subagent-enabled-off = サブエージェント: オフ
jouzu-cli-subagent-placementLabel = 配置:
jouzu-cli-subagent-toolsLabel = ツール:
jouzu-cli-subagent-moreRoles = 他に { $count } 件のロールがあります。展開して表示してください
jouzu-cli-subagent-outputPage = 出力ページ
jouzu-cli-subagent-eventOnPage = { $heading } · このページのイベント 1 件
jouzu-cli-subagent-eventsOnPage = { $heading } · このページのイベント { $count } 件
jouzu-cli-subagent-resultLabel = 結果:
jouzu-cli-subagent-assistantLabel = アシスタント:
jouzu-cli-subagent-messageFallback = メッセージ
jouzu-cli-subagent-outputReceived = { $role } · 出力を受信しました
jouzu-cli-subagent-result = 結果
jouzu-cli-subagent-toolLabel = ツール: { $tool }
jouzu-cli-subagent-childSessionReady = 子セッションの準備完了
jouzu-cli-subagent-messageLabel = メッセージ: { $status }
jouzu-cli-subagent-runEnded = 実行終了
jouzu-cli-subagent-assignmentLabel = 割り当て:
jouzu-cli-subagent-event = イベント: { $type }
jouzu-cli-subagent-earlierEvents = このページの以前のイベント { $count } 件
jouzu-cli-subagent-noOutputYet = まだ出力はありません。
jouzu-cli-subagent-partialRecords = 不完全なレコードはプレビューから省略しました。
jouzu-cli-subagent-moreOutput = さらに出力があります。
jouzu-cli-subagent-nextByteOffset = 次のバイトオフセット: { $offset }
jouzu-cli-subagent-endOfOutput = 利用可能な出力の終わりです。
jouzu-cli-subagent-messageAccepted = メッセージはコントローラーに受け付けられました
jouzu-cli-subagent-deliveryUnconfirmed = サブエージェントへの配信はまだ確認されていません。
jouzu-cli-subagent-receiptLabel = 受付記録:
jouzu-cli-subagent-cancellationRequested = サブエージェントのキャンセルを要求しました
jouzu-cli-subagent-noResult = 結果なし
jouzu-cli-subagent-operationFailed = サブエージェントの操作に失敗しました

# Session UI: セッション行、ステータスバー、Palette のショートカットヒント、
# ワークダッシュボード。Same message IDs and placeholders as `en/cli.ftl`.
# Terminology follows the localization glossary. ダッシュボードのセクションと
# 注意のキーは内部の識別値であり、ここには解決後の語だけを置く。No message
# here carries authentication, destructive, privacy, or billing wording.
jouzu-cli-session-line-noModel = モデルなし
jouzu-cli-session-line-attention = 要確認
jouzu-cli-session-status-health = ! 状態
jouzu-cli-session-status-contextUnknown = コンテキスト ?
jouzu-cli-session-status-detached = 切り離し
jouzu-cli-session-hint-paletteShortcuts = { $select } モデル · { $cycle } お気に入り · { $help } ヘルプ
jouzu-cli-session-dashboard-section-agent = エージェント
jouzu-cli-session-dashboard-section-job = ジョブ
jouzu-cli-session-dashboard-section-task = タスク
jouzu-cli-session-dashboard-section-loop = ループ
jouzu-cli-session-dashboard-section-goal = ゴール
jouzu-cli-session-dashboard-section-prompt = スケジュール済み
jouzu-cli-session-dashboard-section-flow = フロー
jouzu-cli-session-dashboard-attention-result = 未読の結果
jouzu-cli-session-dashboard-attention-input = 入力待ち
jouzu-cli-session-dashboard-attention-recovery = 復旧が必要
jouzu-cli-session-dashboard-attention-authority = 判断待ち
jouzu-cli-session-dashboard-stale = { $status } [未更新]
jouzu-cli-session-dashboard-elapsed-seconds = { $count }秒
jouzu-cli-session-dashboard-elapsed-minutes = { $count }分
jouzu-cli-session-dashboard-elapsed-hours = { $count }時間
jouzu-cli-session-dashboard-elapsed-hoursMinutes = { $hours }時間{ $minutes }分
# サブエージェントのコマンド、ワークフロー、ダッシュボードの通知。コマンド名、
# オプション語、JSON 操作の断片、実行 ID、パス、件数は引数として渡し、
# ここには文だけを置く。
jouzu-cli-subagent-commandHint = `/subagents`、`/subagents show`、`/subagents hide` のいずれかを使用してください。
jouzu-cli-subagent-dashboardRestored = ダッシュボードを保存された表示モードに戻しました。
jouzu-cli-subagent-dashboardHidden = このセッションではダッシュボードを非表示にしました。戻すには `/subagents show` を使用してください。
jouzu-cli-subagent-paneEnabled = サブエージェントのペインを有効にしました。このセッションにサブエージェントの実行があると表示されます。
jouzu-cli-subagent-paneHidden = サブエージェントのペインを非表示にしました。表示するには `/subagents show` を使用してください。
jouzu-cli-subagent-enabledNotice = このセッションではサブエージェントをオンにしました。
jouzu-cli-subagent-disabledNotice = このセッションではサブエージェントをオフにしました。待機中および実行中のサブエージェントは停止しましたが、既存の変更は残ります。
jouzu-cli-subagent-workflowCommandHint = `/workflow`、`/workflow on`、`/workflow off`、`/workflow toggle` のいずれかを使用してください。
jouzu-cli-subagent-settingChangeFailed = サブエージェントの設定を変更できませんでした。
jouzu-cli-subagent-workflowStorageUnavailable = Workflow の保存領域を利用できません。
jouzu-cli-subagent-workflowAgentsUnreadable = Workflow: `agents.json` を読み込めませんでした。エージェントを起動する前に設定を修正してください。
jouzu-cli-subagent-notificationDeliveryFailed = エージェント通知の配信に失敗しました。保持されている結果は `subagent` の list と read で読んでください。待機状態になったら再読み込みして再試行してください。
jouzu-cli-subagent-rolesDisabledReason = このセッションではユーザーがサブエージェントを無効にしています。直接作業してください。再度有効にできるのはユーザーだけです。
jouzu-cli-subagent-fieldRequired = subagent { $op } には空でない { $field } が必要です。{ $hint } 無関係なフィールドは省略してください。インターフェースが要求する場合に限り null を使用してください。
jouzu-cli-subagent-fieldHint-role = { $command } を呼び出し、返されたサブエージェントとして実行可能なロールを使用してください。
jouzu-cli-subagent-fieldHint-runId = { $command } を呼び出し、返された実行 ID を使用してください。
jouzu-cli-subagent-fieldHint-batchId = この実行で配信された完了通知の batchId を使用してください。
jouzu-cli-subagent-fieldHint-task = task に割り当てまたは追加指示を指定してください。
jouzu-cli-subagent-dashboardMore = · 他に { $count } 件
jouzu-cli-subagent-batchSummary = エージェント: { $total } 件が終了 — 完了 { $completed }、失敗 { $failed }、キャンセル { $cancelled }、中断 { $interrupted }。
jouzu-cli-subagent-batchOmitted = { $count } 件を省略しました。ID には `subagent` の list、出力には `subagent` の read を使用してください。
jouzu-cli-subagent-reviewCandidateWarning = レビュー候補 { $status }。この結果は最終的なワークスペース状態を示すものではありません。
jouzu-cli-subagent-workspaceError = ワークスペース: { $path } は{ $reason }。Jouzu からアクセスできる既存のディレクトリを選んでください。再起動は不要です。
jouzu-cli-subagent-workspaceMissing = 存在しません
jouzu-cli-subagent-workspaceInaccessible = アクセスできません
jouzu-cli-subagent-workspaceNotDirectory = アクセス可能なディレクトリではありません
jouzu-cli-subagent-modelUnavailable = モデル: { $selector } は利用できません。Workflow で利用可能なモデルを選んでください。
jouzu-cli-subagent-modelAmbiguous = モデル: { $selector } は { $count } 件のプロバイダーに一致します: { $providers }。provider/model 全体で再試行してください。
jouzu-cli-subagent-modelAmbiguousMore = 、ほか { $count } 件
jouzu-cli-subagent-validationLength = 検証: { $label } は 1–{ $max } 文字でなければなりません。
jouzu-cli-subagent-validationLengthMax = 検証: { $label } は最大 { $max } 文字でなければなりません。
# 検出器が到達できないサブエージェントの起動・再開・読み取り・トレースの失敗と
# 復旧の文面、およびコマンドの説明と呼び出しのプレビュー。モデル、プロバイダー、
# ロール、ワークスペース、実行 ID、バイトオフセット、JSON 操作の断片は引数と
# して渡し、ここには文だけを置く。
jouzu-cli-subagent-workflowRequiresSession = Workflow にはアクティブなセッションが必要です。
jouzu-cli-subagent-sameModelNoSession = モデル: ロールのモデルは "{ $model }" ですが、このセッションにはモデルが選択されていません。モデルを選択するか、ロールに明示的な provider/model を指定してください。
jouzu-cli-subagent-agentDefinitionNotFound = エージェント定義が見つかりませんでした。
jouzu-cli-subagent-disabledForSession = このセッションではサブエージェントがオフです。ユーザーは Workflow または `/workflow on` で有効にできます。
jouzu-cli-subagent-providerInProcess = モデル: このプロバイダーはインプロセス拡張を使用します。サブエージェント用に組み込み API を持つプロバイダーを選んでください。
jouzu-cli-subagent-sessionChangedBeforeStart = エージェントを起動する前にセッションが変わりました。このセッションで再試行してください。
jouzu-cli-subagent-settingChangedBeforeLaunch = 起動前にサブエージェントの設定が変わりました。割り当てを再試行してください。
jouzu-cli-subagent-authenticationSignIn = 認証: 選択したエージェントプロバイダーにサインインして再試行してください。
jouzu-cli-subagent-authenticationApiKeyProvider = 認証: サブエージェントには API キーまたはトークンのプロバイダーを選んでください。
jouzu-cli-subagent-cacheWarmingSettingsUnreadable = サブエージェントのキャッシュウォーミング設定を読み込めませんでした。再試行する前に `settings.json` を確認してください。
jouzu-cli-subagent-settingChangeInProgress = サブエージェントの設定変更が終わるまで待ってください。
jouzu-cli-subagent-parentTranscriptUnavailable = トレース: 親セッションにはまだ保存された会話記録がありません。
jouzu-cli-subagent-mainPlacementRequired = メインセッションでの使用を許可する定義を選んでください。
jouzu-cli-subagent-mainRoleIdleRequired = メインエージェントのロールを変更する前に、メインエージェントの終了を待ってください。
jouzu-cli-subagent-roleAuthenticationUnavailable = モデル: このロールの認証を利用できません。
jouzu-cli-subagent-modelArgumentUserOnly = サブエージェントのモデルを Workflow で変更できるのはユーザーだけです。model 引数は省略してください。
jouzu-cli-subagent-resumeContextOmit = 再開は元のコンテキストを維持します。起動専用の context、entryIds、parentContext は省略してください（インターフェースが要求する場合は null）。
jouzu-cli-subagent-resumeWorkspaceKeep = 再開は元のワークスペースを維持します。別のディレクトリを使うには新しいエージェントを起動してください。
jouzu-cli-subagent-offsetNonnegative = offset は 0 以上の整数でなければなりません。
jouzu-cli-subagent-operationUnsupported = サポートされているサブエージェント操作を選んでください。
jouzu-cli-subagent-commandDescription = サブエージェントの実行を開く。ダッシュボードには show または hide を使用
jouzu-cli-subagent-workflowCommandDescription = エージェントと実行を開く。on/off/toggle でこのセッションのサブエージェントを制御
jouzu-cli-subagent-callLabel = サブエージェント · { $operation }
jouzu-cli-subagent-callPreparing = 準備中
jouzu-cli-subagent-agentNotRunning = エージェントはすでに実行されていません。
jouzu-cli-subagent-storageRecordUnreadable = 保存領域: エージェントの記録を読み込めませんでした。再試行する前に保存されたセッションを確認してください。
jouzu-cli-subagent-sessionClosed = このエージェントセッションは終了しています。
jouzu-cli-subagent-agentsOwnedByAnotherProcess = このセッションのエージェントは別の Jouzu プロセスが制御しています。さらに作業を始める前にそのプロセスを閉じてください。
jouzu-cli-subagent-invalidRunDirectory = 保存領域: 実行ディレクトリが無効です。
jouzu-cli-subagent-invalidEventFile = 保存領域: エージェントのイベントファイルが無効です。
jouzu-cli-subagent-runNotFoundInSession = エージェントの実行がこの親セッションに見つかりませんでした。
jouzu-cli-subagent-completionRecordNotFound = エージェントの完了記録が見つかりませんでした。
jouzu-cli-subagent-readBounds = 読み取り: 0 以上のバイトオフセットと 1–32000 バイトの limit を使用してください。
jouzu-cli-subagent-readPastEnd = 読み取りオフセットがエージェント出力の末尾を超えています。
jouzu-cli-subagent-readCharacterBoundary = 読み取りオフセットは UTF-8 文字の境界から始める必要があります。前のページの nextOffset を使用してください。
jouzu-cli-subagent-childSessionUnavailable = トレース: 保存された子セッションを利用できません。
jouzu-cli-subagent-taskLength = タスク: 1–32000 文字で入力してください。
jouzu-cli-subagent-childPlacementRequired = サブエージェントとして実行できるロールを選んでください。
jouzu-cli-subagent-queueFull = エージェントのキューが満杯です。作業の終了を待ってください。
jouzu-cli-subagent-resumeParentContextKeep = 再開は元の親コンテキストを維持します。変更するには新しいエージェントを起動してください。
jouzu-cli-subagent-resumeActiveRun = 再開する前にこのエージェントを停止または終了してください。
jouzu-cli-subagent-resumeIdentityRequired = 再開には元のワークスペース、ロールのリビジョン、明示的に選択したモデルが必要です。
jouzu-cli-subagent-parentContextUnavailable = 保存された親コンテキストを利用できません。
jouzu-cli-subagent-childFollowUpActive = この子セッションにはすでにアクティブな追加指示があります。
jouzu-cli-subagent-childSessionMissing = 保存された子セッションを利用できません。
jouzu-cli-subagent-parentSnapshotTooLarge = コンテキスト: 親のスナップショットが 32 MB を超えています。fresh コンテキストで parentContext: false を使うか、絞り込んだ splice を使用してください。
jouzu-cli-subagent-messageLength = メッセージ: 1–16000 文字で入力してください。
jouzu-cli-subagent-notRunningUseResume = このエージェントは実行されていません。追加指示には Resume を使用してください。
jouzu-cli-subagent-runNotFound = エージェントの実行が見つかりません。
jouzu-cli-subagent-stopIncomplete = 一部のサブエージェントを停止できませんでした。Runs を確認し、実行中の各サブエージェントに対して Stop を再試行してください。
jouzu-cli-subagent-storageSaveFailed = エージェント結果の保存中に保存領域で失敗しました。
jouzu-cli-subagent-lockReleaseFailed = プロセスロックの解放に失敗しました。さらにエージェントを起動する前に Jouzu を再起動してください。{ $detail }
jouzu-cli-subagent-traceBounds = トレース: offset は 0 以上のバイトカーソル、limit は 1–100 でなければなりません。
jouzu-cli-subagent-traceKind = トレース: all、messages、tools、errors、compaction のいずれかを選んでください。
jouzu-cli-subagent-traceQuery = トレース: 最大 2000 文字のテキストクエリと文字列の entryId を使用してください。
jouzu-cli-subagent-traceNotRegularFile = トレース: セッションのパスが通常ファイルではありません。
jouzu-cli-subagent-tracePastEnd = トレース: offset がセッションの末尾を超えています。
jouzu-cli-subagent-traceLineBoundary = トレース: offset は JSONL 行の先頭でなければなりません。前のページの nextOffset を使用してください。
jouzu-cli-subagent-traceMalformedEntry = トレース: バイト { $offset } に壊れた完全な JSONL エントリがあります。保存されたセッションファイルを確認してください。
jouzu-cli-subagent-traceEntryTooLarge = トレース: 1 つのエントリが 8 MB の走査上限を超えています。保存されたセッションファイルを直接読んでください。
jouzu-cli-subagent-contextMode = コンテキスト: fresh、fork、splice のいずれかを選んでください。
jouzu-cli-subagent-contextParentLookup = コンテキスト: parentContext は true か false でなければなりません。
jouzu-cli-subagent-contextEntryIdsMode = コンテキスト: entryIds は context: splice の場合にのみ有効ですが、この起動では { $mode } を使用しています。entryIds を省略するか、インターフェースが要求する場合は null を送ってください。選択した親エントリを共有する意図がない限り splice に切り替えないでください。
jouzu-cli-subagent-contextSpliceIds = コンテキスト: splice にはアクティブな親ブランチのメッセージまたは圧縮のエントリ ID が 1–100 件必要です。`subagent` を { $command } で呼び出して ID を取得し、その ID で再試行してください。新しい割り当てでは context と entryIds の両方を省略してください（または null を送ってください）。

# フロー制御の状態表示と通知。状態値、待機トークン、依存ハンドル、プロバイダー/
# モデル ID は引数で渡し、ここには保存しない。段階の語は表示テキストであり、
# 未知の内部段階はプロデューサーが名付けたまま表示する。
jouzu-cli-flow-stage-contextPreparation = コンテキストの準備
jouzu-cli-flow-stage-modelConversion = モデル変換
jouzu-cli-flow-input-continueAfterCompaction = 圧縮後の継続
jouzu-cli-flow-input-multiloopResume = 切り離されたゴールの再開通知
jouzu-cli-flow-status-blockedOneRequest = ブロック中: リクエスト { $count } 件を送信しませんでした。
jouzu-cli-flow-status-blockedManyRequests = ブロック中: リクエスト { $count } 件を送信しませんでした。
jouzu-cli-flow-status-requestEndedDuring = { $stage } の途中でリクエストが終了しました。ペイロードは受け付けられませんでした。
jouzu-cli-flow-status-requestEndedBeforeAdmission = ペイロードの受け付け前にリクエストが終了しました。送信は記録されておらず、受付記録から原因は特定できません。
jouzu-cli-flow-status-requiredInputRemovedBeforeSending = 必要な入力が送信前に削除または変更されました。
jouzu-cli-flow-status-requiredContextRemovedBeforeSending = 必要なコンテキストが送信前に削除または変更されました。
jouzu-cli-flow-status-requiredInputRemovedDuring = 必要な入力が { $stage } 中に削除または変更されました。
jouzu-cli-flow-status-requiredContextRemovedDuring = 必要なコンテキストが { $stage } 中に削除または変更されました。
jouzu-cli-flow-status-commandNotRun = コマンドは実行されませんでした。まだ必要ならもう一度実行してください。
jouzu-cli-flow-status-extensionNoticeNotDelivered = 拡張機能の通知は配信されませんでした。再送用にキューへ戻されることはありません。
jouzu-cli-flow-status-notQueuedForReplay = 再送用にキューへ戻されることはありません。まだ必要ならもう一度送信してください。
jouzu-cli-flow-status-savedStateBlocksInput = 保存されたフロー状態がこの入力をまだブロックしています。リセットする前に `/flow details` で確認してください。
jouzu-cli-flow-status-waitingForRequestBlock = 上のリクエストのブロックが解除されるのを待っています。
jouzu-cli-flow-status-heldBehindBlocker = ブロッカーの背後で保留中
jouzu-cli-flow-status-heldInput = 保留中の入力
jouzu-cli-flow-status-inputDetailsUnavailable = 入力の詳細を利用できません
jouzu-cli-flow-status-taskDetailsUnavailable = タスク: 詳細を利用できません
jouzu-cli-flow-status-taskLabel = タスク #{ $id }: { $subject }
jouzu-cli-flow-status-showingEntries = { $total } 件中 { $from }-{ $to } 件を表示しています。
jouzu-cli-flow-status-noEntriesOnPage = ページ { $page } に項目はありません。
jouzu-cli-flow-status-waitUnmetDeadline = 未達 { $unmet } 件。期限まで { $minutes }分。
jouzu-cli-flow-status-waitUnmetPastDeadline = 未達 { $unmet } 件。期限を過ぎています。
jouzu-cli-flow-status-ageJustNow = たった今
jouzu-cli-flow-status-ageMinutes = { $minutes }分前
jouzu-cli-flow-status-ageHoursMinutes = { $hours }時間{ $minutes }分前
jouzu-cli-flow-status-eligibleForAutomation = 自動実行の対象です。
jouzu-cli-flow-status-eligibleForAutomationWithStatus = 自動実行の対象です。タスクの状態: { $status }。
jouzu-cli-flow-status-taskCompleted = タスクは完了しました。
jouzu-cli-flow-status-taskState = タスクの状態: { $state }
jouzu-cli-flow-status-taskDetailsChanged = タスクの詳細が変更されました。フロー状態はまだ同期していません。
jouzu-cli-flow-status-liveWaitOne = 有効な待機 { $count } 件
jouzu-cli-flow-status-liveWaitMany = 有効な待機 { $count } 件
jouzu-cli-flow-status-noLiveWait = 有効な待機なし
jouzu-cli-flow-status-deadlineExpiresIn = あと { $duration } で期限切れ
jouzu-cli-flow-status-deadlinePast = 期限を過ぎています
jouzu-cli-flow-status-repairCauseClear = 原因を修正してから `/flow clear` を実行し、新しいメッセージを送信してください。
jouzu-cli-flow-status-resumeNow = `/flow resume` で今すぐ再開できます
jouzu-cli-flow-status-durationUnderMinute = 1分未満
jouzu-cli-flow-status-durationMinutes = { $minutes }分
jouzu-cli-flow-status-durationHours = { $hours }時間
jouzu-cli-flow-status-durationHoursMinutes = { $hours }時間{ $minutes }分
jouzu-cli-flow-status-senderExtension = 拡張機能
jouzu-cli-flow-status-customMessage = カスタムメッセージ
jouzu-cli-flow-status-messageWithNonTextContent = テキスト以外の内容のメッセージ
jouzu-cli-flow-status-stageRequestPreparation = リクエストの準備
jouzu-cli-flow-status-titleUnavailable = タイトルを利用できません
jouzu-cli-flow-status-workFallback = 作業
jouzu-cli-flow-status-requestsNotSentHeading = 送信されなかったリクエスト
jouzu-cli-flow-status-correctCauseThenClear = 報告された原因を修正してから `/flow clear` を実行し、保存された保留を解除してください。
jouzu-cli-flow-status-automationAlsoPaused = 自動実行も一時停止しています: { $reason }。`/flow resume` だけではリクエストのブロックを解除できません。
jouzu-cli-flow-status-inputLine = 入力: { $id }
jouzu-cli-flow-status-moreRequiredInputs = このリクエストを共有する必須入力がさらに { $count } 件あります。
jouzu-cli-flow-status-requiredContextUnlinked = - 必須コンテキスト（送信済みメッセージがリンクされていません）
jouzu-cli-flow-status-reasonLine = 理由: { $reason }
jouzu-cli-flow-status-failureLine = 失敗: { $code }、記録日時 { $recordedAt }
jouzu-cli-flow-status-destinationLine = 送信先: { $provider } / { $model }
jouzu-cli-flow-status-providerFallback = プロバイダー
jouzu-cli-flow-status-modelFallback = モデル
jouzu-cli-flow-status-requestLine = リクエスト: { $id }
jouzu-cli-flow-status-retryAfterCorrection = 修正後の再試行: `/flow retry { $id }`
jouzu-cli-flow-status-resetPreservesRecords = リセットしてもこれらの記録は保持され、失敗したリクエストは再送されません。
jouzu-cli-flow-status-blockedRecoveryDecision = ブロック中: 保存された作業に復旧の判断が必要です。
jouzu-cli-flow-status-turnInProgress = モデルのターンが実行中です。
jouzu-cli-flow-status-furtherAutomationPaused = 以降の自動実行は一時停止しています: { $reason }
jouzu-cli-flow-status-pausedLine = 一時停止中: { $reason }
jouzu-cli-flow-status-resumeAutomation = `/flow resume` で自動実行を再開するか、新しいメッセージを送信してください。
jouzu-cli-flow-status-otherRecoveryBlockersHeading = その他の復旧ブロッカー
jouzu-cli-flow-status-statusIncompleteHeading = 状態が不完全
jouzu-cli-flow-status-unreadableState = 読み取れない状態はまだ解消されていません。ビルドの詳細は `/flow runtime` で確認してください。
jouzu-cli-flow-status-sentOutcomeUnknownHeading = 送信済み、結果不明
jouzu-cli-flow-status-sendAgain = 再送する（作業が繰り返される可能性あり）: `/flow resolve { $id } retry`
jouzu-cli-flow-status-doNotResend = 再送しない: `/flow resolve { $id } discard`
jouzu-cli-flow-status-waitingOnJobsHeading = ジョブの待機中
jouzu-cli-flow-status-waitingForDependency = { $dependency } を待機中
jouzu-cli-flow-status-moreJobDependencies = ジョブの依存関係がさらに { $count } 件あります。
jouzu-cli-flow-status-cancelWaitOnly = 待機のみをキャンセル: `/flow cancel { $token }`
jouzu-cli-flow-status-undeliveredInputHeading = 未配信の入力
jouzu-cli-flow-status-workEligibilityHeading = 作業の実行可否
jouzu-cli-flow-status-workLine = 作業: { $id }
jouzu-cli-flow-status-pauseLine = 一時停止: `/flow pause { $id }`
jouzu-cli-flow-status-stopLine = 停止: `/flow stop { $id }`
jouzu-cli-flow-status-notAttachedHeading = このセッションに紐付いていない項目
jouzu-cli-flow-status-nothingHeld = 保留、差し止め、待機、未解決のいずれもありません。
jouzu-cli-flow-status-fullIdentifiers = 完全な識別子と操作: `/flow details`
jouzu-cli-flow-status-moreEntries = 次の項目: `/flow details { $page }`
jouzu-cli-flow-status-previousEntries = 前の項目: `/flow details { $page }`
jouzu-cli-flow-notice-pauseAfterInterrupt = 割り込みによりフロー制御を一時停止しました。自動実行は次のメッセージで再開します。詳細は `/flow` で確認してください。
jouzu-cli-flow-notice-pauseAfterAdmissionFailure = 受け付けの失敗によりフロー制御を一時停止しました。保留中の処理はそのまま保持されます。詳細は `/flow`、保留の解除は `/flow clear`、配信のリセットは `/flow reset` で行えます。
jouzu-cli-flow-notice-pausedAfterReopen = このセッションを開き直したためフロー制御は一時停止しています。`/flow` で確認し、`/flow resume` または次のメッセージで自動実行を再開してください。
jouzu-cli-flow-notice-flowOffHeadline = フロー制御はオフです。
jouzu-cli-flow-notice-flowOnHeadline = フロー制御は再びオンです。
jouzu-cli-flow-notice-flowResetHeadline = フロー制御をリセットしました。
jouzu-cli-flow-notice-flowOffTail = ジョブ、タスク、レーンはそれぞれの配信経路で実行と報告を行うようになりました。
jouzu-cli-flow-notice-flowOnTail = 保留された結果と待機は有効になり、次のアイドル境界から実行されます。
jouzu-cli-flow-notice-withheldRequestNeedsClear = 差し止められたリクエストには `/flow clear` が必要です。
jouzu-cli-flow-notice-flowOffCommandUnavailable = `/flow { $verb }` は `/flow on` の後に再び機能します。
jouzu-cli-flow-notice-alreadyPaused = すでに一時停止中です: { $reason }。`/flow resume` で解除してください。
jouzu-cli-flow-notice-pausedEveryTurn = このセッションのすべての自動ターンを一時停止しました。`/flow resume` で解除してください。
jouzu-cli-flow-notice-resolvedSpent = { $target } を消費済みとして解決しました。この試行でその処理が再び実行されることはありません。
jouzu-cli-flow-notice-resolvedUndelivered = { $target } を未配信として解決しました。その処理は再び対象となり、プロバイダーがすでに応答したターンを繰り返す可能性があります。
jouzu-cli-flow-notice-stoppedWork = { $target } を停止しました。その待機は取り消され、これ以上自動ターンは実行されません。開始済みのジョブは実行を続けます。
jouzu-cli-flow-notice-pausedWork = { $target } を一時停止しました。その自動ターンは `/flow resume { $target }` まで保留されます。
jouzu-cli-flow-notice-resumedWork = { $target } を再開しました。その自動ターンを再び実行できます。
jouzu-cli-flow-notice-flowClearReleasedOne = フロー制御の解除により、リクエストの保留 { $count } 件を解除しました。受付記録は保持されています。新しいメッセージで続行してください。
jouzu-cli-flow-notice-flowClearReleasedMany = フロー制御の解除により、リクエストの保留 { $count } 件を解除しました。受付記録は保持されています。新しいメッセージで続行してください。
jouzu-cli-flow-notice-flowClearReleasedOneReservation = フロー制御の解除により、リクエストの保留 { $count } 件と予約 { $attemptId } を解除しました。受付記録は保持されています。新しいメッセージで続行してください。
jouzu-cli-flow-notice-flowClearReleasedManyReservation = フロー制御の解除により、リクエストの保留 { $count } 件と予約 { $attemptId } を解除しました。受付記録は保持されています。新しいメッセージで続行してください。
jouzu-cli-flow-compaction-label = コンテキストを圧縮
jouzu-cli-flow-message-work = ▶ 作業
jouzu-cli-flow-message-alert = ⚠ 警告
jouzu-cli-flow-registry-rebuilt = このセッションのフロー登録情報は現在のバージョンと互換性がなかったため破棄されました。フロー状態は会話記録から再構築されました。
jouzu-cli-flow-registry-rebuiltSaved = このセッションのフロー登録情報は現在のバージョンと互換性がなかったため破棄されました。フロー状態は会話記録から再構築されました。破棄された状態は { $path } に保存されました。
jouzu-cli-flow-noReply-label = 返信せずにターンを終了
jouzu-cli-flow-ownership-busy = このセッションブランチは既に別の接続が使用しています。
jouzu-cli-flow-ownership-failed = フローの所有権を取得できませんでした。
jouzu-cli-flow-native-editedInput = ネイティブ入力を編集したため、状態の再確認が必要です。
jouzu-cli-flow-native-observationRetained = ネイティブ入力の状態記録を保持できませんでした。
jouzu-cli-flow-native-queueAdmission = キューの受け付けを完了できませんでした。
jouzu-cli-flow-native-queueHeld = キュー内の入力はセッションポリシーにより保留されています。
jouzu-cli-flow-native-compactionProviderFailed = ペイロードの受け付け前に圧縮プロバイダーが失敗しました: { $message }
jouzu-cli-flow-native-maintenanceNoAdmission = メンテナンスプロバイダーがペイロードを受け付けずに戻りました。
jouzu-cli-flow-native-providerNoAdmission = ネイティブプロバイダーがペイロードを受け付けずに戻りました。復旧オプションは `/flow` を実行してください。
jouzu-cli-flow-native-providerFailed = ペイロードの受け付け前にプロバイダー要求が失敗しました（{ $provider } / { $model }）: { $message }。復旧オプションは `/flow` を実行してください。
jouzu-cli-flow-native-noFailureDescription = 失敗の説明が返されませんでした。
jouzu-cli-flow-ingress-hostAdmission = 入力はホストの受付ポリシーにより保留されています。
jouzu-cli-flow-ingress-recoveryReconciliation = 入力は復旧状態の同期を待っています。
jouzu-cli-flow-ingress-semanticAdmission = 入力は受付条件の再確認を待っています。
jouzu-cli-flow-ingress-providerOutcomeUnknown = プロバイダーの結果が不明です。
jouzu-cli-flow-service-resolvedSpent = `/flow` から消費済みとして解決しました。
jouzu-cli-flow-service-resolvedUndelivered = `/flow` から未配信として解決しました。
jouzu-cli-flow-ledger-invalidRequestSummary = 要求サマリーが無効です。
jouzu-cli-flow-ledger-invalidRetiredAttempts = 終了済み試行の記録が無効です。
jouzu-cli-flow-ledger-noComposedInput = フィルタリング後に残った構成済み入力がありません。
jouzu-cli-flow-ledger-outcomeUnknown = 接続が切れたため、要求の結果は不明です。
jouzu-cli-flow-ledger-requiredFiltered = 必須入力または完全な集約メタデータがフィルタリングされました。
jouzu-cli-flow-ledger-handoffCancelled = 未送信の引き渡しは再接続時にキャンセルされました。
jouzu-cli-flow-results-label = 完了結果を読む
jouzu-cli-flow-submission-deferredContextCancellation = 遅延されたコンテキストのキャンセルには削除状態の同期が必要です。
jouzu-cli-flow-submission-queueCancellation = キューのキャンセルには削除状態の同期が必要です。
jouzu-cli-flow-submission-deliveryUnknown = 送信されましたが、モデルが受信したかは不明です。
jouzu-cli-flow-submission-unavailable = 入力は送信されず、配信できません。実行するにはもう一度送信してください。
jouzu-cli-flow-task-continuationSkipped = タスクが変更されたため、タスクの継続をスキップしました。
jouzu-cli-flow-wait-label = 依存関係を待機
jouzu-cli-flow-wait-cancelLabel = 依存関係の待機をキャンセル
jouzu-cli-selfUpdate-lockBusy = 別の Jouzu 更新が実行中です
jouzu-cli-flow-message-reviewNote = 完了はレビュー承認を意味しません。
jouzu-cli-flow-controller-producerInput = プロデューサーの入力を取得できません。
jouzu-cli-flow-controller-producerState = プロデューサーの状態を取得できません。
jouzu-cli-flow-controller-resultInput = 結果の入力を取得できません。
jouzu-cli-flow-controller-resultMetadata = 結果メタデータを取得できません。
jouzu-cli-flow-controller-waitDecisionInput = 待機決定の入力を取得できません。
jouzu-cli-flow-controller-aggregateCapacity = 集約メタデータが利用可能な容量を超えています。
jouzu-cli-flow-controller-resultCapacity = 結果が残りの構成済み入力容量を超えています。

# セッションラベル: /labels の状態表示、コマンド一覧、コマンド説明、および
# コマンド通知。状態を表す語はロケール変更で翻訳されるようカタログの文言とし、
# プロバイダー/モデルの識別子は引数で渡す保護値とする。
jouzu-cli-sessionLabels-status-automaticNaming = 自動命名: { $state }。全体: { $global }、セッション: { $session }。
jouzu-cli-sessionLabels-status-namingModel = 命名モデル: { $model }。
jouzu-cli-sessionLabels-status-sessionNamePane = セッション名: { $name }。ペイン: { $pane }。
jouzu-cli-sessionLabels-status-namingRequests = 命名リクエスト: { $count }/20。
jouzu-cli-sessionLabels-status-globalInvalid = 全体のラベル設定が無効です。設定ファイルを修復するまで命名は無効になります。
jouzu-cli-sessionLabels-status-revisit = タスクが曖昧です: 完了したユーザーのターンがさらに { $count } 回必要です。
jouzu-cli-sessionLabels-status-runsAfterTurn = 命名は完了したタスクターンの後に実行されます。保存済みのラベルは再開時に確認されます。
jouzu-cli-sessionLabels-command-show = /labels — 状態とコマンドを表示します。
jouzu-cli-sessionLabels-command-global = /labels global on|off — 全体の命名設定を保存します。
jouzu-cli-sessionLabels-command-on = /labels on — 選択中のモデルで命名を有効にします。
jouzu-cli-sessionLabels-command-off = /labels off — 保留中の命名を取り消し、リクエストを停止します。
jouzu-cli-sessionLabels-command-pin = /labels pin — セッション名を保護します。
jouzu-cli-sessionLabels-command-auto = /labels auto — セッション名の自動変更を許可します。
jouzu-cli-sessionLabels-command-panePin = /labels pane pin — このペインのタイトルを保護します。
jouzu-cli-sessionLabels-command-paneAuto = /labels pane auto — この tmux ペインのタイトルを置き換えられるようにします。
jouzu-cli-sessionLabels-command-description = セッション名の自動設定と tmux ペインラベルを構成します
jouzu-cli-sessionLabels-notify-requiresInteractive = セッションラベルには対話セッションが必要です。
jouzu-cli-sessionLabels-notify-globalUnavailable = 全体のラベル設定を利用できません。
jouzu-cli-sessionLabels-notify-selectModel = 先にモデルを選択してください。
jouzu-cli-sessionLabels-notify-enableBeforePane = ペインを確保する前に、セッションと全体のラベルを有効にしてください。
jouzu-cli-sessionLabels-notify-paneUnavailable = ペインを利用できないか、別の接続が使用しています。タイトルは保護されました。
jouzu-cli-sessionLabels-notify-useCommand = 状態とコマンドを確認するには `/labels` を使用してください。
jouzu-cli-sessionLabels-value-on = オン
jouzu-cli-sessionLabels-value-off = オフ
jouzu-cli-sessionLabels-value-pinned = 固定
jouzu-cli-sessionLabels-value-automatic = 自動
jouzu-cli-sessionLabels-value-guarded = 保護（不明なタイトルは保護されます）
jouzu-cli-sessionLabels-value-selectedModel = 最初の命名リクエスト時の選択モデル
jouzu-cli-sessionLabels-value-none = なし

# ダッシュボードポリシーの復旧。ポリシーのエラー文は引数で渡す保護値とする。
jouzu-cli-settings-dashboardUnreadable = ダッシュボード設定を読み込めませんでした: { $message }
# ブラウザと委譲の Jouzu 所有ツールのラベル、および Camoufox のツール結果の
# スクリーンショット行。ツール名、ツール ID、パラメーター名はコードに残し、
# 表示テキストだけをここへ移す。
jouzu-cli-tool-fetchUrl-label = URL を取得
jouzu-cli-tool-searchWeb-label = ウェブを検索
jouzu-cli-tool-parentContext-label = 親コンテキスト
jouzu-cli-tool-subagent-label = サブエージェント
jouzu-cli-camoufox-result-screenshotOmitted = スクリーンショットを省略: { $size } が添付上限 { $limit } を超えています。screenshot.full_page=false で再試行するか、screenshot.quality を下げてください。
jouzu-cli-camoufox-result-screenshotAttached = スクリーンショット: { $mimeType }、{ $size } をこの結果に添付しました。
# 起動前 CLI 文言の残り: バナーと status コマンド、classic-host の MCP 通知、
# キーバインドとプロファイルのロック、プロセスロックのエラー、実行環境の
# 再起動サフィックス、コンテキスト圧縮の結果、リリース拡張の警告。
# ロックファイル名、CLI オプション名、ツール名、保存済み診断値は保護値として
# 引数で渡す。

jouzu-cli-keybindings-lockBusy = 別のキーバインド操作が進行中です
jouzu-cli-profile-lockBusy = 別のプロファイル操作が進行中です
jouzu-cli-processLock-busy = プロセスロックは別のプロセスが保持しています: { $path }
jouzu-cli-processLock-unavailable = プロセスロックを取得できませんでした: { $path }
# `/flow runtime` レポート、About 表示、起動時の警告。パッケージ名、パス、
# バージョン、開始時刻、SHA-256 ハッシュは保護値として引数で渡す。
jouzu-cli-runtime-patchDiffers = { $package }: 必須のフローパッチが { $path } で一致しません。インストールを修復して再起動し、パスは `/flow runtime` で確認してください。
jouzu-cli-runtime-patchUnavailable = 実行環境のパッチ診断を利用できません。インストールを修復して `/flow runtime` の検査を復元してください。
jouzu-cli-runtime-running = 実行中の Jouzu { $version }
jouzu-cli-runtime-pi = Pi { $version }
jouzu-cli-runtime-started = 開始 { $started }
jouzu-cli-runtime-installed = インストール済み Jouzu { $version }
jouzu-cli-runtime-versionUnavailable = 利用できません
jouzu-cli-runtime-installedDiffers = インストール済みビルドが異なります。読み込むには Jouzu を再起動してください。
jouzu-cli-runtime-summary = 実行環境: Jouzu { $version } · Pi { $pi }
jouzu-cli-runtime-reportHeading = 起動時に取得したパッケージのパスと SHA-256 ハッシュ:
jouzu-cli-runtime-buildChanged = インストール済みの Jouzu ビルドが変更されています。読み込むには Jouzu を再起動してください。`/flow runtime` で実行中とインストール済みのバージョンを確認できます。
jouzu-cli-runtime-restartAvailable = · 再起動可能
jouzu-cli-presentation-windowTitle = Jouzu - { $workspace }
jouzu-cli-presentation-windowTitle-session = Jouzu - { $session } - { $workspace }
jouzu-cli-presentation-bannerVersion-jouzu = jouzu { $version }
jouzu-cli-presentation-bannerVersion-pi = pi { $version }
jouzu-cli-presentation-status-modelNotSelected = 未選択
jouzu-cli-presentation-status-profileNotApplied = 未適用
jouzu-cli-presentation-status-scopedModelsAll = すべて利用可能
jouzu-cli-presentation-status-contextUsage = { $tokens }/{ $window } トークン（{ $percent }%）
jouzu-cli-presentation-status-heading = Jouzu セッションの状態
jouzu-cli-presentation-status-session = セッション: { $id }
jouzu-cli-presentation-status-workspace = ワークスペース: { $name }
jouzu-cli-presentation-status-model = モデル: { $model }
jouzu-cli-presentation-status-thinking = 思考: { $level }
jouzu-cli-presentation-status-context = コンテキスト: { $context }
jouzu-cli-presentation-status-scopedModels = 対象モデル: { $models }
jouzu-cli-presentation-status-profile = プロファイル: { $id }（{ $state }）
jouzu-cli-presentation-status-runtime = 実行環境: Jouzu { $jouzu } · Pi { $pi }
jouzu-cli-presentation-status-profileApplied = 適用済み
jouzu-cli-presentation-command-statusDescription = 現在の Jouzu セッション、モデル、コンテキスト、プロファイルの状態を表示します
jouzu-cli-classicHost-mcpUnavailable = 組み込みの Model Context Protocol（MCP）接続はこのセッションでは有効になっていません。代わりに Jouzu のファイルツールとウェブツールを使用してください。
jouzu-cli-keybindings-action-conflictDetail = 、{ $action } と競合
jouzu-cli-keybindings-action-currentDetail = 、設定値 { $binding }
jouzu-cli-compaction-outcome = エージェントの要求でコンテキストを圧縮しました。以前のメッセージは引き続き検索できます。
jouzu-cli-compaction-outcome-piVcc = エージェントの要求でコンテキストを圧縮しました（pi-vcc 要約）。以前のメッセージは引き続き検索できます。
jouzu-cli-compaction-continueFailed = 圧縮後に続行できませんでした: { $message }
jouzu-cli-releaseExtensions-disabledTools = 無効化されたツール: { $tools }。
jouzu-cli-releaseExtensions-unavailable = 任意の拡張機能 { $package }@{ $version } は利用できません。{ $tools } { $error } `jz doctor` で詳細を確認してください。
jouzu-cli-releaseExtensions-requiredUnavailable = 同梱の拡張機能を利用できません: { $errors }
jouzu-cli-releaseExtensions-warning = Jouzu 警告: { $message }
jouzu-cli-releaseExtensions-conflict-one = Jouzu の標準ツール "{ $tool }" と競合します。`jz config` でこの拡張またはそのパッケージを無効化してください
jouzu-cli-releaseExtensions-conflict-many = Jouzu の標準ツール { $tools } と競合します。`jz config` でこの拡張またはそのパッケージを無効化してください
jouzu-cli-flow-runtimeError = Jouzu フロー制御: { $message }
jouzu-cli-flow-runtimeDiagnosticsUnavailable = このセッションでは実行環境の診断を利用できません。
