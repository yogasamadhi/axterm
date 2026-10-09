import { describe, expect, it } from 'vitest';
import {
  APP_LOCALES,
  AXTERM_NAVIGATION_KEY_COUNT,
  AXTERM_NAVIGATION_SOURCE,
  languageDirection,
  normalizeAppLanguage,
  resolveAppLanguage,
  translateAxterm,
  translateNavigation,
} from '../../apps/desktop/src/renderer/src/i18n/core';

describe('desktop localization', () => {
  it('keeps four Axterm navigation catalogs with identical used-key coverage', () => {
    expect(AXTERM_NAVIGATION_SOURCE).toEqual({
      project: 'Axterm',
      catalog: 'navigation',
      reviewStatus: 'draft',
    });
    expect(APP_LOCALES.map(({ id }) => id)).toEqual(['en', 'ja', 'zh-CN', 'zh-TW']);
    expect(AXTERM_NAVIGATION_KEY_COUNT).toBe(42);
    const englishKeys = Object.keys(APP_LOCALES.find(({ id }) => id === 'en')!.messages);
    for (const locale of APP_LOCALES) {
      expect(Object.keys(locale.messages)).toEqual(englishKeys);
      for (const key of englishKeys) expect(translateNavigation(locale.id, key)).not.toBe('');
    }
  });

  it('normalizes browser languages and exposes the correct document direction', () => {
    expect(normalizeAppLanguage('zh_HK')).toBe('zh-TW');
    expect(normalizeAppLanguage('zh-SG')).toBe('zh-CN');
    expect(normalizeAppLanguage('pt-PT')).toBeUndefined();
    expect(normalizeAppLanguage('ja-JP')).toBe('ja');
    expect(normalizeAppLanguage('unknown')).toBeUndefined();
    expect(resolveAppLanguage(['unknown', 'de-DE'])).toBe('en');
    expect(resolveAppLanguage([])).toBe('en');
    expect(languageDirection('ja')).toBe('ltr');
    expect(languageDirection('zh-CN')).toBe('ltr');
  });

  it('uses per-key English fallback and interpolates as inert text', () => {
    expect(translateAxterm('en', 'axtermConfig.title')).toBe('Axterm configuration snapshot');
    expect(translateAxterm('ja', 'axtermConfig.title')).toBe('Axterm 設定スナップショット');
    expect(translateNavigation('ja', 'setting')).toBe('設定');
    expect(translateNavigation('zh-TW', 'bookmarks')).not.toBe('Bookmarks');
    expect(translateAxterm('ja', 'language.description')).toBe(
      'アプリケーションの表示言語を選択します。変更はすぐに反映され、保存されます。',
    );
    expect(translateAxterm('zh-CN', 'language.description')).toContain('应用界面语言');
    expect(translateAxterm('zh-TW', 'language.description')).toBe(
      '選擇應用程式介面語言；變更會立即生效並保存。',
    );
    expect(translateAxterm('ja', 'settings.updaterInstall')).toBe('インストーラーを開く');
    expect(translateAxterm('zh-TW', 'shell.allTabs')).toBe('所有分頁');
    expect(translateAxterm('ja', 'shell.deleteWorkspace', { name: 'sandbox' })).toBe(
      'ワークスペース sandbox を削除',
    );
    expect(translateAxterm('zh-TW', 'settings.updaterProgress', { progress: 42 })).toBe(
      '已下載 42%',
    );
    expect(translateAxterm('ja', 'behaviorSettings.externalEditorHint')).toBe(
      '実行ファイルの絶対パスを使用してください。Axterm はシェルを起動せず、許可された一時ファイルを 1 つの引数として渡します。',
    );
    expect(translateAxterm('zh-TW', 'behaviorSettings.screenReaderHint')).toBe(
      '立即更新已開啟的 xterm 工作階段，並套用到所有新終端機。',
    );
    expect(translateAxterm('ja', 'settings.aiManagedInInspector')).toBe(
      'AI プロバイダー、モデル、承認の設定は AI アシスタントで管理します。',
    );
    expect(translateAxterm('zh-TW', 'settings.openAiInspector')).toBe('開啟 AI 助手');
    expect(translateAxterm('ja', 'connectionProfiles.deleteConfirm', { name: 'production' })).toBe(
      '接続プロファイル「production」を削除しますか？',
    );
    expect(
      translateAxterm('zh-TW', 'connectionProfiles.protocolCredentials', { protocol: 'SSH' }),
    ).toBe('SSH 憑證');
    expect(translateAxterm('ja', 'connectionProfiles.hideSecret', { label: 'パスワード' })).toBe(
      'パスワード を隠す',
    );
    expect(translateAxterm('zh-TW', 'connectionProfiles.clearSaved', { label: '密碼' })).toBe(
      '清除已儲存的 密碼',
    );
    expect(
      translateAxterm('ja', 'terminalProfile.summary', {
        shell: '/bin/zsh',
        term: 'xterm-256color',
        fontSize: 14,
        lineHeight: 1.2,
        encoding: 'utf-8',
        raw: 'オン',
        paste: 'オン',
        osc52: 'オフ',
      }),
    ).toBe(
      '/bin/zsh · xterm-256color · 14px / 1.2 · utf-8 · 生の出力 オン · 貼り付け保護 オン · OSC 52 オフ',
    );
    expect(translateAxterm('zh-TW', 'terminalProfile.osc52Hint')).toContain(
      '僅在信任的工作階段啟用',
    );
    expect(translateAxterm('ja', 'hosts.vncSummary', { quality: 'high', compression: 'low' })).toBe(
      'VNC · 品質 high · 圧縮 low',
    );
    expect(translateAxterm('zh-TW', 'hosts.optionalColorPlaceholder')).toBe('#2fc7a1（選填）');
    expect(translateAxterm('ja', 'hosts.connectTitle', { name: 'production' })).toBe(
      'production に接続',
    );
    expect(translateAxterm('zh-TW', 'hosts.environmentLineInvalid', { line: 3 })).toBe(
      '環境變數第 3 行必須使用 NAME=value 格式。',
    );
    expect(translateAxterm('ja', 'protocolBookmark.serialEnumerationCount', { count: 2 })).toBe(
      '2 個のシリアルポートが見つかりました。デバイスパスを手動で入力することもできます。',
    );
    expect(translateAxterm('zh-TW', 'protocolBookmark.webSecurityHint')).toContain(
      'HTTP/HTTPS 位址',
    );
    expect(translateAxterm('ja', 'terminal.osc52UnsupportedTarget')).toBe(
      'OSC 52 はシステムクリップボードターゲット c にのみアクセスできます。',
    );
    expect(translateAxterm('zh-TW', 'terminal.currentFontSize', { size: 14 })).toBe(
      '目前終端機字型：14px',
    );
    expect(
      translateAxterm('ja', 'dataSync.previewSummary', {
        source: 'Axterm',
        create: 2,
        unchanged: 1,
        skip: 0,
      }),
    ).toBe('Axterm · 作成 2 · 変更なし 1 · スキップ 0');
    expect(translateAxterm('zh-TW', 'dataSync.accessCredentialLabel', { provider: 'GitHub' })).toBe(
      'GitHub 同步憑證',
    );
    expect(translateAxterm('ja', 'axtermConfig.importCount', { count: 3 })).toBe(
      '3 項目をインポート',
    );
    expect(
      translateAxterm('zh-TW', 'axtermConfig.inspectSummary', {
        bytes: '12 KiB',
        entities: 4,
        issues: 0,
      }),
    ).toBe('12 KiB · 4 個項目 · 0 個問題');
    expect(
      translateAxterm('ja', 'sshConfigImport.previewSummary', {
        imported: 2,
        linked: 1,
        unchanged: 0,
        skipped: 0,
        selected: 3,
        warnings: 1,
      }),
    ).toBe(
      'SSH Config インポートプレビュー: インポート 2、ブックマーク作成 1、変更なし 0、スキップ 0、選択 3、警告 1',
    );
    expect(translateAxterm('zh-TW', 'sshConfigImport.atomicCommit')).toBe(
      '目前的書籤樹版本會以原子方式提交。失敗時不會留下部分主機或書籤。',
    );
    expect(translateAxterm('ja', 'batchOperations.selected', { count: 3 })).toBe('3 件選択');
    expect(translateAxterm('zh-TW', 'batchOperations.executionHint')).toBe(
      '每個目標會依序執行；同時連線數受並行設定上限控制。',
    );
    expect(translateAxterm('ja', 'triggers.copyName', { name: 'sudo 通知' })).toBe(
      'sudo 通知（コピー）',
    );
    expect(
      translateAxterm('zh-TW', 'triggers.sendSummary', { value: 'yes', enter: ' + Enter' }),
    ).toBe('傳送 yes + Enter');
    expect(translateAxterm('ja', 'terminalThemes.perPage', { count: 12 })).toBe('12 / ページ');
    expect(translateAxterm('ja', 'terminalThemes.aiGenerate')).toBe('プレビューを生成');
    expect(translateAxterm('zh-TW', 'terminalThemes.aiSafety')).toBe(
      '生成色彩必須通過嚴格格式與 4.5:1 前景對比檢查，才能進入預覽。',
    );
    expect(translateAxterm('ja', 'activityRail.moveUp', { item: 'ウィジェット' })).toBe(
      'ウィジェット を上へ移動',
    );
    expect(translateAxterm('zh-TW', 'activityRail.title')).toBe('活動列');
    expect(translateAxterm('ja', 'widgets.fileServerBoundary')).toContain('シンボリックリンク');
    expect(translateAxterm('zh-TW', 'widgets.ftpLimits')).toBe(
      '僅限本機連線；最多 16 個用戶端、64 個被動連接埠。若要進行加密的網路共享，請使用 SSH 伺服器。',
    );
    expect(translateAxterm('ja', 'widgets.mcpInstanceStatus', { tools: 3, sessions: 1 })).toBe(
      '3 ツール・1 セッション',
    );
    expect(translateAxterm('zh-TW', 'widgets.confirmRename', { count: 4 })).toBe(
      '確認並重新命名 4 個檔案',
    );
    expect(
      translateAxterm('ja', 'windowPreferences.boundsValue', {
        width: 1440,
        height: 900,
        x: 0,
        y: 0,
      }),
    ).toBe('1440 × 900、位置 0, 0');
    expect(translateAxterm('zh-TW', 'windowPreferences.allowMultipleInstances')).toBe(
      '允許多個 Axterm 執行個體',
    );
    expect(
      translateAxterm('ja', 'remoteDesktop.securityFailure', {
        protocol: 'VNC',
        status: ' (timeout)',
      }),
    ).toBe('VNC のセキュリティネゴシエーションに失敗しました (timeout)');
    expect(translateAxterm('zh-TW', 'remoteDesktop.scaleToFit')).toBe('縮放以符合畫面');
    expect(translateAxterm('ja', 'history.reconnectTarget', { target: 'prod-db' })).toBe(
      'prod-db に再接続',
    );
    expect(translateAxterm('zh-TW', 'history.secretNotSaved')).toBe(
      '僅用於此次連線，不會儲存至歷史、設定或瀏覽器儲存空間。',
    );
    expect(
      translateAxterm('ja', 'fileManager.chmodSuccess', {
        path: '/tmp/demo',
        mode: '0755',
      }),
    ).toBe('/tmp/demo の権限を 0755 に変更しました。');
    expect(translateAxterm('zh-TW', 'fileManager.transferPartiallyQueued', { count: 3 })).toBe(
      '已將 3 個項目加入佇列。其餘項目無法加入；請再次選取後重試。',
    );
    expect(translateAxterm('ja', 'fileManager.copyRemoteSelected', { count: 2 })).toBe(
      '別のリモートホストにコピー（2）…',
    );
    expect(translateAxterm('zh-TW', 'fileManager.returnToGrantRoot')).toBe('返回已授權目錄');
    expect(translateAxterm('ja', 'fileManager.remoteCopyHint')).toContain('SFTP チャネル');
    expect(translateAxterm('zh-TW', 'fileManager.remotePathInvalid')).toBe(
      '遠端路徑必須是以 / 開頭的絕對路徑。',
    );
    expect(translateAxterm('ja', 'app.protocolConnectError', { protocol: 'VNC' })).toBe(
      'VNC 接続に失敗しました。',
    );
    expect(translateAxterm('zh-TW', 'app.recovery.offline.title')).toBe('網路連線已中斷');
    expect(translateAxterm('ja', 'app.protocolBookmarkReconnect', { protocol: 'RDP' })).toBe(
      'この RDP セッションには復元に使用できるブックマークがありません。ブックマークから再接続してください。',
    );
    expect(translateAxterm('zh-TW', 'app.boundedContextHint')).toBe(
      '只有在您開始 AI 工作時，才會傳送有上限且已遮蔽的內容。',
    );
    expect(
      translateAxterm('ja', 'app.transferTaskSummary', { count: 2, active: '（実行中）' }),
    ).toBe('2 件のタスク（実行中）');
    expect(translateAxterm('zh-TW', 'app.commandPalettePlaceholder')).toBe('輸入命令或功能…');
    expect(translateAxterm('ja', 'ai.codeInserted')).toBe(
      '確認用に挿入しました。実行するには Enter を押してください',
    );
    expect(translateAxterm('zh-TW', 'ai.emptyConversationHint')).toBe(
      '您可以要求說明、產生命令，或診斷選取的輸出。傳送前會限制內容範圍並遮蔽祕密資訊。',
    );
    expect(translateAxterm('ja', 'ai.providerTestPassed', { latency: 42, models: 3 })).toBe(
      '42 ms で接続 · 3 個のモデルを検出',
    );
    expect(translateAxterm('zh-TW', 'ai.attachmentPreviewHint')).toBe(
      'UTF-8 文字 · 已遮蔽祕密資訊 · 每個檔案 50 KB',
    );
    expect(translateAxterm('ja', 'ai.riskDestructive')).toBe('破壊的');
    expect(translateAxterm('zh-TW', 'ai.approvalApproved')).toBe('已單次核准');
    expect(translateAxterm('ja', 'aiBookmark.noSecrets')).toContain('秘密鍵');
    expect(translateAxterm('zh-TW', 'aiBookmark.reviewHint')).toBe(
      '請檢查並編輯每個值。在您選擇儲存書籤前，不會儲存任何內容。',
    );
    expect(translateAxterm('ja', 'knownHosts.revokeConfirm', { host: 'prod', port: 22 })).toBe(
      'prod:22 の保存済みホスト鍵を取り消しますか？次回の接続時にサーバーフィンガープリントを再確認する必要があります。',
    );
    expect(translateAxterm('zh-TW', 'knownHosts.empty')).toBe(
      '尚未儲存主機金鑰。首次 SSH 連線時會要求您驗證。',
    );
    expect(translateAxterm('ja', 'tunnels.allowNonLoopback')).toBe(
      'ループバック以外のアドレスへのバインドを許可',
    );
    expect(translateAxterm('zh-TW', 'tunnels.portInUse')).toBe('啟動失敗：連接埠已被使用');
    expect(translateAxterm('ja', 'quickCommands.inserted')).toBe(
      '現在のターミナルに挿入しました。実行するには Enter を押してください。',
    );
    expect(translateAxterm('zh-TW', 'quickCommands.stepsHint')).toBe(
      '會依序儲存。插入時會建立多行文字，不會自動執行。',
    );
    expect(translateAxterm('ja', 'quickCommands.clipboardSendFailed')).toContain('{{clipboard}}');
    expect(translateAxterm('zh-TW', 'quickCommands.inputMode')).toContain('永遠不會執行命令');
    expect(translateAxterm('ja', 'quickCommands.stepName', { number: 2 })).toBe('手順 2 の名前');
    expect(translateAxterm('zh-TW', 'panels.quickCommandsDescription')).toContain('先插入供檢閱');
    expect(translateAxterm('ja', 'batchCli.invalidFormat')).toContain('Axterm 形式');
    expect(translateAxterm('zh-TW', 'batchCli.invalidFormat')).toBe(
      '批次操作檔案必須使用 Axterm 格式。',
    );
    expect(translateAxterm('ja', 'batchInput.partiallySent', { count: 2, total: 3 })).toBe(
      '2/3 個のターミナルに送信しました。残りのターミナルは準備ができていません。',
    );
    expect(translateAxterm('zh-TW', 'batchInput.sendTo', { count: 3 })).toBe('傳送至 3 個終端機');
    expect(translateAxterm('ja', 'bookmarkTree.matches', { count: 2 })).toBe('2 件一致');
    expect(translateAxterm('zh-TW', 'bookmarkTree.newChildGroupIn', { title: 'Production' })).toBe(
      '在 Production 中建立子群組',
    );
    expect(translateAxterm('ja', 'bookmarkGroup.selectColor', { color: '#2fc7a1' })).toBe(
      'グループの色 #2fc7a1 を選択',
    );
    expect(translateAxterm('zh-TW', 'bookmarkCommands.limits', { count: 2 })).toBe(
      '2/64 ・名稱最多 60 個字元，命令最多 16 KiB。',
    );
    expect(
      translateAxterm('ja', 'fileInfo.permissionAria', {
        operation: '読み取り',
        subject: '所有者',
      }),
    ).toBe('所有者 の 読み取り 権限');
    expect(translateAxterm('zh-TW', 'fileTable.selectedCount', { count: 3 })).toBe('已選取 3 項');
    expect(translateAxterm('ja', 'externalEditor.openedHint')).toContain(
      'システム既定のエディター',
    );
    expect(translateAxterm('zh-TW', 'externalEditor.copyUnavailable')).toBe('暫存副本無法使用');
    expect(translateAxterm('ja', 'fileComparison.localNamed', { name: 'notes.txt' })).toBe(
      'ローカル・notes.txt',
    );
    expect(translateAxterm('zh-TW', 'fileComparison.utf8Only')).toContain('UTF-8');
    expect(translateAxterm('ja', 'remoteEditor.conflict')).toContain('現在の下書きは保持されます');
    expect(translateAxterm('zh-TW', 'remoteEditor.closeDirtyConfirm')).toBe(
      '目前草稿尚未儲存。要關閉編輯器嗎？',
    );
    expect(translateAxterm('ja', 'hostTunnel.allowNonLoopback')).toContain('ループバック外');
    expect(translateAxterm('zh-TW', 'sshStartup.environmentHint')).toContain('不會儲存');
    expect(translateAxterm('ja', 'jumpChain.hint')).toContain('最大 8 個');
    expect(translateAxterm('zh-TW', 'jumpChain.moveUp', { name: 'bastion' })).toBe(
      '將跳板主機 bastion 上移',
    );
    expect(translateAxterm('ja', 'legal.electronRuntimeLicenseDescription')).toContain(
      '読み取り専用',
    );
    expect(translateAxterm('zh-TW', 'tabPreferences.description')).toContain('立即套用');
    expect(translateAxterm('ja', 'webSession.copyAddress', { url: 'https://example.com' })).toBe(
      'https://example.com\nクリックしてアドレスをコピー',
    );
    expect(translateAxterm('zh-TW', 'webSession.credentialsTemporary')).toContain('不會儲存');
    expect(translateAxterm('ja', 'commandHistory.description')).toContain(
      '明示的に送信した安全な 1 行コマンド',
    );
    expect(translateAxterm('zh-TW', 'commandHistory.privacyDescription')).toContain('OSC 633');
    expect(translateAxterm('ja', 'commandHistory.inserted')).toContain('Enter を押してください');
    expect(translateAxterm('zh-TW', 'bookmarkTriggers.description')).toBe(
      '這些規則只會在從此書籤開啟的終端機中執行，並會與全域觸發器一同運作。',
    );
    expect(translateAxterm('ja', 'bookmarkTriggers.safety', { count: 2 })).toBe(
      '2/32 ・正規表現は Runtime で安全性を再検証します。',
    );
    expect(translateAxterm('ja', 'panels.aiDescription')).toBe(
      '上限を設け、機密情報をマスクしたコンテキストで説明、生成、診断を行います。',
    );
    expect(translateAxterm('zh-TW', 'panels.argumentsHash', { hash: 'abc' })).toBe('引數雜湊 abc');
    expect(translateAxterm('ja', 'interaction.confirmChangedHostKey')).toContain(
      'フィンガープリント',
    );
    expect(translateAxterm('zh-TW', 'interaction.replaceAndConnect')).toBe('取代金鑰並連線');
    expect(translateAxterm('ja', 'credentials.description')).toContain(
      'シークレット値は表示されません',
    );
    expect(translateAxterm('zh-TW', 'credentials.kindPrivateKey')).toBe('SSH 私密金鑰');
    expect(
      translateAxterm('ja', 'proxy.availableVia', {
        protocol: 'SOCKS5',
        host: 'proxy.example',
        port: 1080,
        latency: 42,
      }),
    ).toBe('SOCKS5 プロキシ proxy.example:1080 が利用可能です（42 ms）。');
    expect(translateAxterm('zh-TW', 'proxy.commandDescription')).toContain('不經過 shell');
    expect(translateAxterm('ja', 'proxy.passwordTestRequired')).toBe(
      'プロキシパスワードを入力してください。このテストリクエストでのみ使用されます。',
    );
    expect(translateAxterm('ja', 'shortcuts.conflict', { chord: 'Ctrl+K', owner: '検索' })).toBe(
      'Ctrl+K はすでに「検索」で使われています',
    );
    expect(translateAxterm('zh-TW', 'shortcuts.captureHint')).toContain('Backspace');
    expect(translateAxterm('ja', 'shortcuts.globalDescription')).toContain(
      'ほかのアプリケーション',
    );
    expect(translateAxterm('zh-TW', 'shortcuts.globalRegistrationFailed')).toBe(
      '系統無法註冊這個全域快速鍵；可能已被其他應用程式使用。',
    );
    expect(translateAxterm('ja', 'shortcuts.globalApplied')).toBe(
      'グローバルショートカットを登録し、直ちに適用しました。',
    );
    expect(
      translateAxterm('ja', 'remoteMonitor.itemSummary', {
        label: 'CPU',
        summary: '42%',
        level: '警告',
      }),
    ).toBe('CPU：42%；警告');
    expect(translateAxterm('zh-TW', 'remoteMonitor.cpuHistorySummary', { percent: 42 })).toBe(
      'CPU 歷程：42%',
    );
    expect(translateAxterm('ja', 'remoteMonitor.unavailable')).toBe(
      'モニタリングデータは利用できません',
    );
    expect(translateAxterm('zh-TW', 'remoteMonitor.detail', { label: 'CPU' })).toBe('CPU 詳細資料');
    expect(translateAxterm('ja', 'terminalInfo.filter', { selected: 3, total: 8 })).toBe(
      'フィルター（3/8）',
    );
    expect(translateAxterm('zh-TW', 'terminalInfo.type', { type: 'SSH' })).toBe('類型：SSH');
    expect(translateAxterm('ja', 'terminalInfo.disconnected')).toBe(
      'セッションが切断され、モニタリングは停止しました。',
    );
    expect(translateAxterm('zh-TW', 'terminalInfo.usedPercent', { percent: 42 })).toBe('已用 42%');
    expect(translateAxterm('ja', 'terminalInfo.hours', { count: 2 })).toBe('2時間');
    expect(translateAxterm('ja', 'terminalRecovery.description')).toContain(
      '確立済みの SSH セッションが予期せず切断された後にのみ',
    );
    expect(translateAxterm('zh-TW', 'terminalRecovery.description')).toContain(
      '只會在已建立的 SSH 工作階段意外中斷後套用',
    );
    expect(translateAxterm('ja', 'terminalRecovery.moveUp', { item: 'CPU' })).toBe(
      'CPU を上へ移動',
    );
    expect(translateAxterm('zh-TW', 'terminalRecovery.restoreOnReload')).toBe(
      '重新載入 SSH 時復原畫面與工作目錄',
    );
    expect(translateAxterm('ja', 'terminalRecovery.dragPath')).toBe(
      '一時的なローカルパスを挿入する',
    );
    expect(translateAxterm('ja', 'axtermConfig.importCount', { count: 4 })).toBe(
      '4 項目をインポート',
    );
    expect(translateAxterm('ja', 'terminal.pasteStats', { characters: 120, lines: 3 })).toBe(
      '120 文字・3 行',
    );
    expect(translateAxterm('ja', 'terminal.searchNoMatch')).toBe('一致なし');
    expect(translateAxterm('zh-TW', 'terminal.connectionLost', { detail: '：逾時' })).toBe(
      '連線已中斷：逾時',
    );
    expect(translateAxterm('zh-TW', 'terminal.shortcutCount', { count: 2 })).toBe('2 個快速鍵');
    expect(translateAxterm('zh-TW', 'dataSync.title')).toBe('設定同步');
    expect(translateAxterm('ja', 'dataSync.title')).toBe('設定の同期');
    expect(
      translateNavigation('en', 'missing-message', 'Hello {name}', {
        name: '<img src=x onerror=alert(1)>',
      }),
    ).toBe('Hello <img src=x onerror=alert(1)>');
  });

  it('describes current translation coverage without old-product claims on normal UI surfaces', () => {
    expect(translateAxterm('zh-CN', 'language.fallback')).toBe(
      '导航标签支持全部 4 种语言；其他文案在缺少翻译时回退到英文。',
    );
    expect(translateAxterm('ja', 'language.fallback')).toBe(
      'ナビゲーションのラベルは、対応する4言語すべてで利用できます。翻訳がないその他のテキストは英語で表示されます。',
    );
    expect(translateAxterm('zh-TW', 'language.fallback')).toBe(
      '導覽標籤支援全部 4 種語言；其他文案在沒有翻譯時會回退為英文。',
    );
    for (const language of ['en', 'zh-CN'] as const) {
      for (const key of [
        'settings.categoryDescription',
        'behaviorSettings.description',
        'terminalProfile.keySequenceHint',
        'triggers.editorEmpty',
        'activityRail.hint',
        'language.fallback',
      ] as const)
        expect(translateAxterm(language, key)).not.toMatch(/Legacy Prototype/u);
      expect(translateAxterm(language, 'axtermConfig.title')).not.toMatch(/Legacy Prototype/u);
    }
  });

  it('uses native Simplified Chinese wording throughout connection-configuration surfaces', () => {
    const keys = [
      'credentials.description',
      'connectionProfiles.eyebrow',
      'connectionProfiles.title',
      'connectionProfiles.description',
      'connectionProfiles.updated',
      'connectionProfiles.saved',
      'connectionProfiles.deleteConfirm',
      'connectionProfiles.deleted',
      'connectionProfiles.savedList',
      'connectionProfiles.searchProfiles',
      'connectionProfiles.defaultProfile',
      'connectionProfiles.empty',
      'connectionProfiles.noMatches',
      'connectionProfiles.name',
      'connectionProfiles.nameAria',
      'connectionProfiles.defaultHint',
      'connectionProfiles.setDefault',
      'connectionProfiles.protocols',
      'connectionProfiles.update',
      'connectionProfiles.save',
      'connectionProfiles.protocolOverrideHint',
      'connectionProfiles.operationFailed',
      'dataSync.categoryProfiles',
    ] as const;
    for (const key of keys) expect(translateAxterm('zh-CN', key)).not.toMatch(/Profile/u);
    expect(translateAxterm('zh-CN', 'connectionProfiles.title')).toBe('连接配置');
    expect(translateAxterm('zh-CN', 'connectionProfiles.nameAria')).toBe('连接配置名称');
    expect(translateAxterm('zh-CN', 'dataSync.categoryProfiles')).toBe('连接配置');
  });
});
