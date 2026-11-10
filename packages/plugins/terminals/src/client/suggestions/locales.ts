/** Retained first-party AI suggestion feedback. */
export const suggestionDictionaries = {
  en: {
    'app.aiSuggestionsTimeout': 'The AI command-suggestion request timed out.',
    'app.aiSuggestionsFailed': 'AI command suggestions failed{detail}.',
  },
  'zh-CN': {
    'app.aiSuggestionsTimeout': 'AI 命令建议请求超时。',
    'app.aiSuggestionsFailed': 'AI 命令建议失败{detail}。',
  },
  ja: {
    'app.aiSuggestionsTimeout': 'AI コマンド提案のリクエストがタイムアウトしました。',
    'app.aiSuggestionsFailed': 'AI コマンド提案に失敗しました{detail}。',
  },
  'zh-TW': {
    'app.aiSuggestionsTimeout': 'AI 命令建議請求已逾時。',
    'app.aiSuggestionsFailed': 'AI 命令建議失敗{detail}。',
  },
} as const;
