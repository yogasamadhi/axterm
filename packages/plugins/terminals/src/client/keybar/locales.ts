/** Terminal key-bar helper/recovery copy; new wording awaits owner review. */
export const keybarDictionaries = {
  en: {
    'keybar.collapse': 'Collapse',
    'keybar.edit': 'Edit',
    'keybar.search': 'Search',
    'keybar.unknown':
      'The previous change has an unknown outcome. Retry the original request before editing again.',
  },
  ja: {
    'keybar.collapse': '折りたたむ',
    'keybar.edit': '編集',
    'keybar.search': '検索',
    'keybar.unknown':
      '前の変更結果を確認できません。同じリクエストを再試行してから編集してください。',
  },
  'zh-CN': {
    'keybar.collapse': '折叠',
    'keybar.edit': '编辑',
    'keybar.search': '搜索',
    'keybar.unknown': '上次更改的结果尚未确认。请先重试原请求，再继续编辑。',
  },
  'zh-TW': {
    'keybar.collapse': '摺疊',
    'keybar.edit': '編輯',
    'keybar.search': '搜尋',
    'keybar.unknown': '上次變更的結果尚未確認。請先重試原請求，再繼續編輯。',
  },
} as const;
