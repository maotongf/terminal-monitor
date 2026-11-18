window.terminalMonitorCopy = Object.freeze({
  status: {
    running: '进行中', waiting: '待你处理', waitingTool: '等待工具', quiet: '暂无输出',
    idle: '空闲', completed: '已完成', failed: '失败', interrupted: '已中断', unknown: '未知'
  },
  source: { vscode: 'VS Code', cli: '命令行', exec: '命令行', other: 'Codex' },
  section: { codex: 'Codex', active: '活动终端', idle: '空闲终端', history: '最近任务' },
  ui: {
    brand: 'Terminal Monitor', connecting: '连接中', connected: '已连接', disconnected: '连接中断',
    running: '进行中', waiting: '待你处理', failed: '异常', codexScope: '当前工作区',
    live: '实时状态', noActiveTasks: '暂无活动任务', incomplete: '会话列表未完整加载',
    noCodex: '暂无 Codex 任务', noActive: '没有活动终端', noIdle: '没有空闲终端', noHistory: '暂无最近任务',
    noWorkspace: '无工作区', showingLastSync: '上次同步 {time}', showingCached: '显示上次数据',
    codexUnavailable: 'Codex 未连接', codexDisconnected: '连接中断',
    waitingForTerminals: '等待终端', summary: '{running} 项进行中 · {idle} 个空闲终端',
    autoSync: '自动同步', moreHistory: '查看更多（{count}）', collapseHistory: '收起', failureScope: '最近保留的终端失败与当前 Codex 失败'
  },
  tooltip: {
    recentReply: '最近回复', codexUpdated: 'Codex · 更新于 {time}',
    changeTerminal: '右键更改', closedInList: '原终端已关闭', closedWithCwd: '原终端已关闭，点击后会在原目录打开新终端。',
    closedNoCwd: '原终端已关闭，且没有可用的工作目录。', exitCode: '退出码 {code}',
    terminal: '终端 · {name}', shell: 'Shell', bindingManual: '手动关联',
    bindingTitle: '标题与目录匹配', bindingTask: 'CLI 任务时间匹配', bindingFolder: '同目录任务推测',
    bindingRecent: '按最近活动推测'
  },
  time: { secondsAgo: '{count} 秒前', minutesAgo: '{count} 分钟前', hoursAgo: '{count} 小时前', daysAgo: '{count} 天前' },
  duration: { hours: '{hours}小时{minutes}分', minutes: '{minutes}分{seconds}秒' }
});
