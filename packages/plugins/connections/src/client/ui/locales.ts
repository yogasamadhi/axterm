import type {} from '@axterm/ui';
// Retained Axterm interaction text. Manual localization review remains separate.
export const dictionaries = {
  en: {
    'panels.reject': 'Reject',
    'interaction.confirmChangedHostKey':
      'I verified the new fingerprint and want to replace the saved host key',
    'interaction.confirmChangedHostKeyRequired':
      'Verify the new fingerprint and select the confirmation checkbox before replacing the saved host key.',
    'interaction.rememberHostKey': 'Save and remember this host key',
    'interaction.unknownHostKeyTitle': 'First connection to this host',
    'interaction.changedHostKeyTitle': 'Remote host key changed',
    'interaction.hostKeyUnknownSummary': 'No identity is saved for this SSH host.',
    'interaction.hostKeyChangedSummary': 'The remote identity does not match the saved host key.',
    'interaction.hostKeyHighRisk': 'High risk',
    'interaction.hostKeyTarget': 'Target',
    'interaction.hostKeyAlgorithm': 'Algorithm',
    'interaction.hostKeyFingerprint': 'SHA256 fingerprint',
    'interaction.hostKeySavedFingerprint': 'Saved fingerprint',
    'interaction.hostKeyPresentedFingerprint': 'Presented fingerprint',
    'interaction.hostKeyVerifyGuidance':
      'Verify this fingerprint through a trusted channel before connecting.',
    'interaction.hostKeyChangedGuidance':
      'The server may have been reinstalled, or this connection may be intercepted. Verify the presented fingerprint through a trusted channel before replacing the saved key.',
    'interaction.keyboardTitle': '{name} · Challenge {attempt}',
    'interaction.keyboardDefaultName': 'SSH interactive authentication',
    'interaction.keyboardSummary':
      'Response fields requested: {count}. If another step is required, Axterm will show the next challenge separately.',
    'interaction.submitting': 'Submitting…',
    'interaction.replaceAndConnect': 'Replace key and connect',
    'interaction.trustAndConnect': 'Trust and connect',
    'interaction.confirm': 'Confirm',
    'common.operationFailed': 'Operation failed',
  },
  'zh-CN': {
    'panels.reject': '拒绝',
    'interaction.confirmChangedHostKey': '我已核对新指纹，替换已保存的主机密钥',
    'interaction.confirmChangedHostKeyRequired':
      '请先核对新指纹并勾选确认框，再替换已保存的主机密钥。',
    'interaction.rememberHostKey': '保存并记住此主机密钥',
    'interaction.unknownHostKeyTitle': '首次连接此主机',
    'interaction.changedHostKeyTitle': '远程主机密钥已改变',
    'interaction.hostKeyUnknownSummary': '尚未保存此 SSH 主机的身份。',
    'interaction.hostKeyChangedSummary': '远程主机身份与已保存的主机密钥不一致。',
    'interaction.hostKeyHighRisk': '高风险',
    'interaction.hostKeyTarget': '目标',
    'interaction.hostKeyAlgorithm': '算法',
    'interaction.hostKeyFingerprint': 'SHA256 指纹',
    'interaction.hostKeySavedFingerprint': '已保存指纹',
    'interaction.hostKeyPresentedFingerprint': '本次指纹',
    'interaction.hostKeyVerifyGuidance': '请通过可信渠道核对指纹后再连接。',
    'interaction.hostKeyChangedGuidance':
      '服务器可能已重装，也可能存在连接被拦截的风险。请通过可信渠道核对本次指纹，再替换已保存的密钥。',
    'interaction.keyboardTitle': '{name} · 挑战 {attempt}',
    'interaction.keyboardDefaultName': 'SSH 交互式认证',
    'interaction.keyboardSummary':
      '服务端请求 {count} 项应答；如果仍有后续步骤，Axterm 会单独显示下一项挑战。',
    'interaction.submitting': '提交中…',
    'interaction.replaceAndConnect': '替换密钥并连接',
    'interaction.trustAndConnect': '信任并连接',
    'interaction.confirm': '确认',
    'common.operationFailed': '操作失败',
  },
  ja: {
    'panels.reject': '拒否',
    'interaction.confirmChangedHostKey':
      '新しいフィンガープリントを確認し、保存済みホスト鍵を置き換えます',
    'interaction.confirmChangedHostKeyRequired':
      '新しいフィンガープリントを確認し、確認チェックボックスを選択してから保存済みホスト鍵を置き換えてください。',
    'interaction.rememberHostKey': 'このホスト鍵を保存して記憶',
    'interaction.unknownHostKeyTitle': 'このホストへの初回接続',
    'interaction.changedHostKeyTitle': 'リモートホスト鍵が変更されました',
    'interaction.hostKeyUnknownSummary': 'この SSH ホストの識別情報は保存されていません。',
    'interaction.hostKeyChangedSummary': 'リモートの識別情報が保存済みホスト鍵と一致しません。',
    'interaction.hostKeyHighRisk': '高リスク',
    'interaction.hostKeyTarget': '接続先',
    'interaction.hostKeyAlgorithm': 'アルゴリズム',
    'interaction.hostKeyFingerprint': 'SHA256 フィンガープリント',
    'interaction.hostKeySavedFingerprint': '保存済みフィンガープリント',
    'interaction.hostKeyPresentedFingerprint': '提示されたフィンガープリント',
    'interaction.hostKeyVerifyGuidance':
      '接続する前に、信頼できる経路でこのフィンガープリントを確認してください。',
    'interaction.hostKeyChangedGuidance':
      'サーバーが再インストールされたか、接続が傍受されている可能性があります。保存済みの鍵を置き換える前に、信頼できる経路で提示されたフィンガープリントを確認してください。',
    'interaction.keyboardTitle': '{name} · チャレンジ {attempt}',
    'interaction.keyboardDefaultName': 'SSH 対話型認証',
    'interaction.keyboardSummary':
      '応答項目は {count} 件です。後続の手順が必要な場合、Axterm は次のチャレンジを個別に表示します。',
    'interaction.submitting': '送信中…',
    'interaction.replaceAndConnect': '鍵を置き換えて接続',
    'interaction.trustAndConnect': '信頼して接続',
    'interaction.confirm': '確認',
    'common.operationFailed': '操作に失敗しました',
  },
  'zh-TW': {
    'panels.reject': '拒絕',
    'interaction.confirmChangedHostKey': '我已驗證新指紋，並要取代已儲存的主機金鑰',
    'interaction.confirmChangedHostKeyRequired':
      '請先核對新指紋並勾選確認方塊，再取代已儲存的主機金鑰。',
    'interaction.rememberHostKey': '儲存並記住此主機金鑰',
    'interaction.unknownHostKeyTitle': '首次連線至此主機',
    'interaction.changedHostKeyTitle': '遠端主機金鑰已變更',
    'interaction.hostKeyUnknownSummary': '尚未儲存此 SSH 主機的身分。',
    'interaction.hostKeyChangedSummary': '遠端主機身分與已儲存的主機金鑰不一致。',
    'interaction.hostKeyHighRisk': '高風險',
    'interaction.hostKeyTarget': '目標',
    'interaction.hostKeyAlgorithm': '演算法',
    'interaction.hostKeyFingerprint': 'SHA256 指紋',
    'interaction.hostKeySavedFingerprint': '已儲存指紋',
    'interaction.hostKeyPresentedFingerprint': '本次指紋',
    'interaction.hostKeyVerifyGuidance': '請透過可信管道核對指紋後再連線。',
    'interaction.hostKeyChangedGuidance':
      '伺服器可能已重新安裝，也可能存在連線遭攔截的風險。請透過可信管道核對本次指紋，再取代已儲存的金鑰。',
    'interaction.keyboardTitle': '{name} · 挑戰 {attempt}',
    'interaction.keyboardDefaultName': 'SSH 互動式驗證',
    'interaction.keyboardSummary':
      '伺服器要求 {count} 個回應欄位；若仍有後續步驟，Axterm 會個別顯示下一項挑戰。',
    'interaction.submitting': '正在提交…',
    'interaction.replaceAndConnect': '取代金鑰並連線',
    'interaction.trustAndConnect': '信任並連線',
    'interaction.confirm': '確認',
    'common.operationFailed': '操作失敗',
  },
} as const;
declare module '@axterm/ui' {
  interface LocaleNamespaceMap {
    connections: keyof typeof dictionaries.en;
  }
}
