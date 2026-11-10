export const dictionaries = {
  en: {
    reconnect: 'Reconnect',
    connected: 'Connected',
    interrupted: 'Connection interrupted',
    ready: 'Runtime Ready',
    connecting: 'Connecting to Runtime',
    degraded: 'Runtime Degraded',
    details: 'Runtime details',
    close: 'Close',
    generation: 'Generation',
    process: 'Process ID',
    version: 'Version',
  },
  ja: {
    reconnect: '再接続',
    connected: '接続済み',
    interrupted: '接続が中断されました',
    ready: 'Runtime の準備ができました',
    connecting: 'Runtime に接続中',
    degraded: 'Runtime への接続が中断されました',
    details: 'Runtime の詳細',
    close: '閉じる',
    generation: 'Generation',
    process: 'プロセス ID',
    version: 'バージョン',
  },
  'zh-CN': {
    reconnect: '重新连接',
    connected: '已连接',
    interrupted: '连接中断',
    ready: 'Runtime 已就绪',
    connecting: '正在连接 Runtime',
    degraded: 'Runtime 连接中断',
    details: 'Runtime 详情',
    close: '关闭',
    generation: 'Generation',
    process: '进程 ID',
    version: '版本',
  },
  'zh-TW': {
    reconnect: '重新連線',
    connected: '已連線',
    interrupted: '連線中斷',
    ready: 'Runtime 已就緒',
    connecting: '正在連線 Runtime',
    degraded: 'Runtime 連線中斷',
    details: 'Runtime 詳情',
    close: '關閉',
    generation: 'Generation',
    process: '處理程序 ID',
    version: '版本',
  },
} as const;
declare module '@axterm/ui' {
  interface LocaleNamespaceMap {
    runtimeStatus: keyof typeof dictionaries.en;
  }
}
