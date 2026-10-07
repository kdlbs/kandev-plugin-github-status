// kandev-plugin-github-status UI bundle (no-build ES module).
//
// Quiet when healthy, loud when not:
//   • app-status-bar-right — always. A compact GitHub icon, muted while all
//     is well and colored when a component kandev depends on degrades.
//   • main-top-bar        — only during a degradation, so Home/Kanban/Tasks
//     carry an unmissable indicator.
//   • chat-top-bar        — the same incident indicator on an open task.
//   • click either        — a modal with the six components that matter, the
//     unresolved incident, and upcoming maintenance.
//   • toast               — only on a transition, acknowledged by id so a
//     page reload never replays it.
//   • plugin-settings     — the notification toggle.
//
// Data flow: everything reads one module-level store, which polls
//   host.api.fetch("webhooks/status")
//   (= GET /api/plugins/kandev-plugin-github-status/webhooks/status)
// -> kandev relays over gRPC HandleWebhook -> the plugin backend answers from
// its own 60s poller's cache. One request per interval for the whole SPA, not
// one per mounted surface. Colors live in /ui/plugin.css and are all derived
// from host theme tokens.

(function () {
  const PLUGIN_ID = "kandev-plugin-github-status";
  // Matches the backend's own poll cadence — polling the relay faster than
  // the poller refills its cache would just re-read the same bytes.
  const POLL_MS = 60000;
  const TOAST_MS = 15000;

  // ── vocabulary ───────────────────────────────────────────────────────────
  // Keys are the severity names the backend marshals (server/statuspage.go).
  const SEVERITY = {
    operational: {
      cls: "ghs-ok",
      label: "Operational",
      headline: "All systems operational",
    },
    maintenance: {
      cls: "ghs-mnt",
      label: "Maintenance",
      headline: "Maintenance in progress",
    },
    minor: {
      cls: "ghs-min",
      label: "Degraded",
      headline: "Degraded performance",
    },
    major: {
      cls: "ghs-maj",
      label: "Partial outage",
      headline: "Partial outage",
    },
    critical: {
      cls: "ghs-crit",
      label: "Major outage",
      headline: "Major outage",
    },
  };
  const sev = (name) => SEVERITY[name] || SEVERITY.operational;

  // Raw Statuspage component statuses -> the same visual vocabulary.
  const COMPONENT_LABEL = {
    operational: "Operational",
    degraded_performance: "Degraded",
    partial_outage: "Partial outage",
    major_outage: "Major outage",
    under_maintenance: "Maintenance",
  };
  const componentLabel = (status) => COMPONENT_LABEL[status] || "Unknown";

  // Plugin-authored copy follows the host locale; older hosts use English. Provider
  // names and incident updates remain provider data.
  const PLUGIN_TRANSLATIONS = {
    en: {
      actionLabel: "GitHub status",
      actionProvider: "GitHub",
      actionOperational: "Operational",
      actionMaintenance: "Maintenance",
      actionMinor: "Degraded",
      actionMajor: "Partial outage",
      actionCritical: "Major outage",
      actionHeadlineOperational: "All systems operational",
      actionHeadlineMaintenance: "Maintenance in progress",
      actionHeadlineMinor: "Degraded performance",
      actionHeadlineMajor: "Partial outage",
      actionHeadlineCritical: "Major outage",
      actionStale: "Stale",
      actionStaleQualifier: " (stale data)",
      actionCheckingTooltip: "Checking GitHub status",
      actionUnavailableTooltip:
        "GitHub status is unavailable. Open status details.",
      actionOperationalTooltip:
        "All systems operational. Open GitHub status details.",
      actionTooltip:
        "{{status}}{{details}}{{stale}}. Open GitHub status details.",
      checking: "Checking GitHub status...",
      unavailable: "GitHub status is unavailable.",
      serviceUnavailable: "Service status unavailable",
      fetchTimeUnavailable: "Fetch time unavailable",
      healthyHeadline: "All monitored services operational",
      activeHeadline: "Active GitHub incident",
      maintenanceHeadline: "GitHub maintenance in progress",
      affectedHeadline_one: "{{count}} GitHub service affected",
      affectedHeadline_other: "{{count}} GitHub services affected",
      unknownHeadline: "Some service statuses are unknown",
      affectedServices: "Services needing attention",
      healthyServices: "Healthy services",
      latestIncident: "Latest incidents",
      maintenanceSection: "Scheduled maintenance",
      refresh: "Refresh",
      refreshing: "Refreshing...",
      refreshLabel: "Refresh GitHub status",
      details: "Show details for {{service}}",
      history: "View incident history",
      checked: "Checked {{time}}",
      updated: "Updated {{time}}",
      timeJustNow: "just now",
      timeMinutes: "{{count}}m ago",
      timeHours: "{{count}}h ago",
      timeDays: "{{count}}d ago",
      staleWarning:
        "Showing the last known status. GitHub could not be reached.",
      refreshFailed:
        "Could not recheck status. Showing the last available snapshot.",
      otherHealthy_one: "{{count}} other service operational",
      otherHealthy_other: "{{count}} other services operational",
      otherAffected: "Also affected: {{services}}",
      unknownStatus: "Unknown",
      impactGit: "git operations",
      impactActions: "workflow runs",
      impactApi: "API requests",
      impactWebhooks: "webhook delivery",
      impactPullRequests: "pull requests",
      impactIssues: "issue access",
      impactOther: "{{service}}",
      impactHint: "May affect {{services}}.",
      maintenanceHint: "Some monitored services are undergoing maintenance.",
      noIncidentUpdate: "No provider update is available yet.",
      incident_investigating: "Investigating",
      incident_identified: "Identified",
      incident_monitoring: "Monitoring",
      incident_resolved: "Resolved",
      incident_scheduled: "Scheduled",
      incident_in_progress: "In progress",
      incident_verifying: "Verifying",
      incident_completed: "Completed",
    },
    "pt-pt": {
      actionLabel: "Estado do GitHub",
      actionProvider: "GitHub",
      actionOperational: "Operacional",
      actionMaintenance: "Manutenção",
      actionMinor: "Desempenho degradado",
      actionMajor: "Interrupção parcial",
      actionCritical: "Interrupção grave",
      actionHeadlineOperational: "Todos os sistemas operacionais",
      actionHeadlineMaintenance: "Manutenção em curso",
      actionHeadlineMinor: "Desempenho degradado",
      actionHeadlineMajor: "Interrupção parcial",
      actionHeadlineCritical: "Interrupção grave",
      actionStale: "Desatualizado",
      actionStaleQualifier: " (dados desatualizados)",
      actionCheckingTooltip: "A verificar o estado do GitHub",
      actionUnavailableTooltip:
        "O estado do GitHub não está disponível. Abrir detalhes do estado.",
      actionOperationalTooltip:
        "Todos os sistemas operacionais. Abrir detalhes do estado do GitHub.",
      actionTooltip:
        "{{status}}{{details}}{{stale}}. Abrir detalhes do estado do GitHub.",
      checking: "A verificar o estado do GitHub...",
      unavailable: "O estado do GitHub não está disponível.",
      serviceUnavailable: "Estado dos serviços indisponível",
      fetchTimeUnavailable: "Hora de obtenção indisponível",
      healthyHeadline: "Todos os serviços monitorizados estão operacionais",
      activeHeadline: "Incidente ativo no GitHub",
      maintenanceHeadline: "Manutenção do GitHub em curso",
      affectedHeadline_one: "{{count}} serviço do GitHub afetado",
      affectedHeadline_other: "{{count}} serviços do GitHub afetados",
      unknownHeadline: "O estado de alguns serviços é desconhecido",
      affectedServices: "Serviços que precisam de atenção",
      healthyServices: "Serviços operacionais",
      latestIncident: "Incidentes mais recentes",
      maintenanceSection: "Manutenção agendada",
      refresh: "Atualizar",
      refreshing: "A atualizar...",
      refreshLabel: "Atualizar o estado do GitHub",
      details: "Mostrar detalhes de {{service}}",
      history: "Ver histórico do incidente",
      checked: "Verificado {{time}}",
      updated: "Atualizado {{time}}",
      timeJustNow: "agora mesmo",
      timeMinutes: "há {{count}} min",
      timeHours: "há {{count}} h",
      timeDays: "há {{count}} d",
      staleWarning:
        "A mostrar o último estado conhecido. Não foi possível contactar o GitHub.",
      refreshFailed:
        "Não foi possível voltar a verificar o estado. A mostrar o último estado disponível.",
      otherHealthy_one: "{{count}} outro serviço operacional",
      otherHealthy_other: "{{count}} outros serviços operacionais",
      otherAffected: "Também afetados: {{services}}",
      unknownStatus: "Desconhecido",
      impactGit: "operações Git",
      impactActions: "execuções de workflows",
      impactApi: "pedidos à API",
      impactWebhooks: "entrega de webhooks",
      impactPullRequests: "pull requests",
      impactIssues: "acesso a issues",
      impactOther: "{{service}}",
      impactHint: "Pode afetar {{services}}.",
      maintenanceHint: "Alguns serviços monitorizados estão em manutenção.",
      noIncidentUpdate:
        "Ainda não está disponível uma atualização do fornecedor.",
      incident_investigating: "A investigar",
      incident_identified: "Identificado",
      incident_monitoring: "A monitorizar",
      incident_resolved: "Resolvido",
      incident_scheduled: "Agendado",
      incident_in_progress: "Em curso",
      incident_verifying: "A verificar",
      incident_completed: "Concluído",
    },
    "zh-cn": {
      actionLabel: "GitHub 状态",
      actionProvider: "GitHub",
      actionOperational: "运行正常",
      actionMaintenance: "维护中",
      actionMinor: "性能下降",
      actionMajor: "部分中断",
      actionCritical: "重大中断",
      actionHeadlineOperational: "所有系统均运行正常",
      actionHeadlineMaintenance: "维护进行中",
      actionHeadlineMinor: "性能下降",
      actionHeadlineMajor: "部分中断",
      actionHeadlineCritical: "重大中断",
      actionStale: "数据过期",
      actionStaleQualifier: "（数据过期）",
      actionCheckingTooltip: "正在检查 GitHub 状态",
      actionUnavailableTooltip: "GitHub 状态不可用。打开状态详情。",
      actionOperationalTooltip: "所有系统均运行正常。打开 GitHub 状态详情。",
      actionTooltip: "{{status}}{{details}}{{stale}}。打开 GitHub 状态详情。",
      checking: "正在检查 GitHub 状态...",
      unavailable: "无法获取 GitHub 状态。",
      serviceUnavailable: "服务状态不可用",
      fetchTimeUnavailable: "获取时间不可用",
      healthyHeadline: "所有受监控服务均运行正常",
      activeHeadline: "GitHub 存在正在处理的事件",
      maintenanceHeadline: "GitHub 正在维护",
      affectedHeadline_one: "{{count}} 项 GitHub 服务受影响",
      affectedHeadline_other: "{{count}} 项 GitHub 服务受影响",
      unknownHeadline: "部分服务状态未知",
      affectedServices: "需要关注的服务",
      healthyServices: "正常服务",
      latestIncident: "最新事件",
      maintenanceSection: "计划维护",
      refresh: "刷新",
      refreshing: "正在刷新...",
      refreshLabel: "刷新 GitHub 状态",
      details: "显示 {{service}} 的详情",
      history: "查看事件历史",
      checked: "检查于{{time}}",
      updated: "更新于{{time}}",
      timeJustNow: "刚刚",
      timeMinutes: "{{count}} 分钟前",
      timeHours: "{{count}} 小时前",
      timeDays: "{{count}} 天前",
      staleWarning: "正在显示上次已知状态。无法连接 GitHub。",
      refreshFailed: "无法重新检查状态。正在显示上次可用的状态。",
      otherHealthy_one: "其他 {{count}} 项服务运行正常",
      otherHealthy_other: "其他 {{count}} 项服务运行正常",
      otherAffected: "其他受影响服务：{{services}}",
      unknownStatus: "未知",
      impactGit: "Git 操作",
      impactActions: "工作流运行",
      impactApi: "API 请求",
      impactWebhooks: "Webhook 投递",
      impactPullRequests: "拉取请求",
      impactIssues: "议题访问",
      impactOther: "{{service}}",
      impactHint: "可能影响{{services}}。",
      maintenanceHint: "部分受监控服务正在维护。",
      noIncidentUpdate: "提供商尚未发布更新。",
      incident_investigating: "调查中",
      incident_identified: "已定位",
      incident_monitoring: "监控中",
      incident_resolved: "已解决",
      incident_scheduled: "已计划",
      incident_in_progress: "进行中",
      incident_verifying: "验证中",
      incident_completed: "已完成",
    },
    "zh-hk": {
      actionLabel: "GitHub 狀態",
      actionProvider: "GitHub",
      actionOperational: "運作正常",
      actionMaintenance: "維護中",
      actionMinor: "效能下降",
      actionMajor: "部分中斷",
      actionCritical: "嚴重中斷",
      actionHeadlineOperational: "所有系統均運作正常",
      actionHeadlineMaintenance: "維護進行中",
      actionHeadlineMinor: "效能下降",
      actionHeadlineMajor: "部分中斷",
      actionHeadlineCritical: "嚴重中斷",
      actionStale: "資料過時",
      actionStaleQualifier: "（資料過時）",
      actionCheckingTooltip: "正在檢查 GitHub 狀態",
      actionUnavailableTooltip: "GitHub 狀態無法取得。開啟狀態詳情。",
      actionOperationalTooltip: "所有系統均運作正常。開啟 GitHub 狀態詳情。",
      actionTooltip: "{{status}}{{details}}{{stale}}。開啟 GitHub 狀態詳情。",
      checking: "正在檢查 GitHub 狀態...",
      unavailable: "無法取得 GitHub 狀態。",
      serviceUnavailable: "服務狀態無法取得",
      fetchTimeUnavailable: "無法取得擷取時間",
      healthyHeadline: "所有受監察服務均運作正常",
      activeHeadline: "GitHub 有正在處理的事故",
      maintenanceHeadline: "GitHub 正在維護",
      affectedHeadline_one: "{{count}} 項 GitHub 服務受影響",
      affectedHeadline_other: "{{count}} 項 GitHub 服務受影響",
      unknownHeadline: "部分服務狀態不明",
      affectedServices: "需要留意的服務",
      healthyServices: "正常服務",
      latestIncident: "最新事故",
      maintenanceSection: "已排程維護",
      refresh: "重新整理",
      refreshing: "正在重新整理...",
      refreshLabel: "重新整理 GitHub 狀態",
      details: "顯示 {{service}} 的詳情",
      history: "查看事故記錄",
      checked: "檢查於{{time}}",
      updated: "更新於{{time}}",
      timeJustNow: "剛剛",
      timeMinutes: "{{count}} 分鐘前",
      timeHours: "{{count}} 小時前",
      timeDays: "{{count}} 日前",
      staleWarning: "正在顯示上次已知狀態。無法連接 GitHub。",
      refreshFailed: "無法重新檢查狀態。正在顯示上次可用的狀態。",
      otherHealthy_one: "其餘 {{count}} 項服務運作正常",
      otherHealthy_other: "其餘 {{count}} 項服務運作正常",
      otherAffected: "其他受影響服務：{{services}}",
      unknownStatus: "不明",
      impactGit: "Git 操作",
      impactActions: "工作流程執行",
      impactApi: "API 請求",
      impactWebhooks: "Webhook 傳送",
      impactPullRequests: "提取請求",
      impactIssues: "議題存取",
      impactOther: "{{service}}",
      impactHint: "可能影響{{services}}。",
      maintenanceHint: "部分受監察服務正在維護。",
      noIncidentUpdate: "服務供應商尚未發佈更新。",
      incident_investigating: "調查中",
      incident_identified: "已確認原因",
      incident_monitoring: "監察中",
      incident_resolved: "已解決",
      incident_scheduled: "已排程",
      incident_in_progress: "進行中",
      incident_verifying: "驗證中",
      incident_completed: "已完成",
    },
    "zh-tw": {
      actionLabel: "GitHub 狀態",
      actionProvider: "GitHub",
      actionOperational: "正常運作",
      actionMaintenance: "維護中",
      actionMinor: "效能下降",
      actionMajor: "部分中斷",
      actionCritical: "重大中斷",
      actionHeadlineOperational: "所有系統均正常運作",
      actionHeadlineMaintenance: "維護進行中",
      actionHeadlineMinor: "效能下降",
      actionHeadlineMajor: "部分中斷",
      actionHeadlineCritical: "重大中斷",
      actionStale: "資料過期",
      actionStaleQualifier: "（資料過期）",
      actionCheckingTooltip: "正在檢查 GitHub 狀態",
      actionUnavailableTooltip: "GitHub 狀態無法取得。開啟狀態詳細資訊。",
      actionOperationalTooltip:
        "所有系統均正常運作。開啟 GitHub 狀態詳細資訊。",
      actionTooltip:
        "{{status}}{{details}}{{stale}}。開啟 GitHub 狀態詳細資訊。",
      checking: "正在檢查 GitHub 狀態...",
      unavailable: "無法取得 GitHub 狀態。",
      serviceUnavailable: "服務狀態無法取得",
      fetchTimeUnavailable: "無法取得擷取時間",
      healthyHeadline: "所有受監控服務均正常運作",
      activeHeadline: "GitHub 有處理中的事件",
      maintenanceHeadline: "GitHub 正在維護",
      affectedHeadline_one: "{{count}} 項 GitHub 服務受影響",
      affectedHeadline_other: "{{count}} 項 GitHub 服務受影響",
      unknownHeadline: "部分服務狀態不明",
      affectedServices: "需要注意的服務",
      healthyServices: "正常服務",
      latestIncident: "最新事件",
      maintenanceSection: "排程維護",
      refresh: "重新整理",
      refreshing: "正在重新整理...",
      refreshLabel: "重新整理 GitHub 狀態",
      details: "顯示 {{service}} 的詳細資訊",
      history: "查看事件記錄",
      checked: "檢查於{{time}}",
      updated: "更新於{{time}}",
      timeJustNow: "剛剛",
      timeMinutes: "{{count}} 分鐘前",
      timeHours: "{{count}} 小時前",
      timeDays: "{{count}} 天前",
      staleWarning: "正在顯示上次已知狀態。無法連線至 GitHub。",
      refreshFailed: "無法重新檢查狀態。正在顯示上次可用的狀態。",
      otherHealthy_one: "其他 {{count}} 項服務正常運作",
      otherHealthy_other: "其他 {{count}} 項服務正常運作",
      otherAffected: "其他受影響服務：{{services}}",
      unknownStatus: "不明",
      impactGit: "Git 操作",
      impactActions: "工作流程執行",
      impactApi: "API 請求",
      impactWebhooks: "Webhook 傳送",
      impactPullRequests: "提取請求",
      impactIssues: "議題存取",
      impactOther: "{{service}}",
      impactHint: "可能影響{{services}}。",
      maintenanceHint: "部分受監控服務正在維護。",
      noIncidentUpdate: "服務供應商尚未發布更新。",
      incident_investigating: "調查中",
      incident_identified: "已確認原因",
      incident_monitoring: "監控中",
      incident_resolved: "已解決",
      incident_scheduled: "已排程",
      incident_in_progress: "進行中",
      incident_verifying: "驗證中",
      incident_completed: "已完成",
    },
    ja: {
      actionLabel: "GitHub の状態",
      actionProvider: "GitHub",
      actionOperational: "正常",
      actionMaintenance: "メンテナンス",
      actionMinor: "性能低下",
      actionMajor: "一部停止",
      actionCritical: "大規模停止",
      actionHeadlineOperational: "すべてのシステムが正常",
      actionHeadlineMaintenance: "メンテナンス中",
      actionHeadlineMinor: "性能低下",
      actionHeadlineMajor: "一部停止",
      actionHeadlineCritical: "大規模停止",
      actionStale: "古い情報",
      actionStaleQualifier: "（古い情報）",
      actionCheckingTooltip: "GitHub の状態を確認中",
      actionUnavailableTooltip:
        "GitHub の状態を取得できません。状態の詳細を開きます。",
      actionOperationalTooltip:
        "すべてのシステムが正常です。GitHub の状態の詳細を開きます。",
      actionTooltip:
        "{{status}}{{details}}{{stale}}。GitHub の状態の詳細を開きます。",
      checking: "GitHub の状態を確認中...",
      unavailable: "GitHub の状態を取得できません。",
      serviceUnavailable: "サービスの状態を取得できません",
      fetchTimeUnavailable: "取得時刻が不明です",
      healthyHeadline: "監視対象のすべてのサービスが正常です",
      activeHeadline: "GitHub でインシデントが発生中",
      maintenanceHeadline: "GitHub はメンテナンス中です",
      affectedHeadline_one: "GitHub の {{count}} 個のサービスに影響",
      affectedHeadline_other: "GitHub の {{count}} 個のサービスに影響",
      unknownHeadline: "一部のサービスの状態が不明です",
      affectedServices: "注意が必要なサービス",
      healthyServices: "正常なサービス",
      latestIncident: "最新のインシデント",
      maintenanceSection: "メンテナンス予定",
      refresh: "更新",
      refreshing: "更新中...",
      refreshLabel: "GitHub の状態を更新",
      details: "{{service}} の詳細を表示",
      history: "インシデントの履歴を表示",
      checked: "確認: {{time}}",
      updated: "更新: {{time}}",
      timeJustNow: "たった今",
      timeMinutes: "{{count}} 分前",
      timeHours: "{{count}} 時間前",
      timeDays: "{{count}} 日前",
      staleWarning:
        "最後に確認できた状態を表示しています。GitHub に接続できませんでした。",
      refreshFailed:
        "状態を再確認できませんでした。最後に取得した状態を表示しています。",
      otherHealthy_one: "ほか {{count}} 個のサービスが正常",
      otherHealthy_other: "ほか {{count}} 個のサービスが正常",
      otherAffected: "ほかに影響を受けているサービス: {{services}}",
      unknownStatus: "不明",
      impactGit: "Git 操作",
      impactActions: "ワークフローの実行",
      impactApi: "API リクエスト",
      impactWebhooks: "Webhook の配信",
      impactPullRequests: "プルリクエスト",
      impactIssues: "Issue へのアクセス",
      impactOther: "{{service}}",
      impactHint: "{{services}}に影響する可能性があります。",
      maintenanceHint: "一部の監視対象サービスはメンテナンス中です。",
      noIncidentUpdate: "プロバイダーからの更新情報はまだありません。",
      incident_investigating: "調査中",
      incident_identified: "原因特定済み",
      incident_monitoring: "経過観察中",
      incident_resolved: "解決済み",
      incident_scheduled: "予定済み",
      incident_in_progress: "実施中",
      incident_verifying: "確認中",
      incident_completed: "完了",
    },
    ko: {
      actionLabel: "GitHub 상태",
      actionProvider: "GitHub",
      actionOperational: "정상",
      actionMaintenance: "유지보수",
      actionMinor: "성능 저하",
      actionMajor: "일부 중단",
      actionCritical: "주요 중단",
      actionHeadlineOperational: "모든 시스템 정상",
      actionHeadlineMaintenance: "유지보수 진행 중",
      actionHeadlineMinor: "성능 저하",
      actionHeadlineMajor: "일부 중단",
      actionHeadlineCritical: "주요 중단",
      actionStale: "오래된 정보",
      actionStaleQualifier: " (오래된 정보)",
      actionCheckingTooltip: "GitHub 상태 확인 중",
      actionUnavailableTooltip:
        "GitHub 상태를 확인할 수 없습니다. 상태 세부 정보를 여세요.",
      actionOperationalTooltip:
        "모든 시스템이 정상입니다. GitHub 상태 세부 정보를 여세요.",
      actionTooltip:
        "{{status}}{{details}}{{stale}}. GitHub 상태 세부 정보를 여세요.",
      checking: "GitHub 상태 확인 중...",
      unavailable: "GitHub 상태를 확인할 수 없습니다.",
      serviceUnavailable: "서비스 상태를 확인할 수 없음",
      fetchTimeUnavailable: "조회 시간을 확인할 수 없음",
      healthyHeadline: "모니터링 중인 모든 서비스가 정상입니다",
      activeHeadline: "GitHub 인시던트 진행 중",
      maintenanceHeadline: "GitHub 유지보수 진행 중",
      affectedHeadline_one: "GitHub 서비스 {{count}}개에 영향",
      affectedHeadline_other: "GitHub 서비스 {{count}}개에 영향",
      unknownHeadline: "일부 서비스 상태를 알 수 없습니다",
      affectedServices: "주의가 필요한 서비스",
      healthyServices: "정상 서비스",
      latestIncident: "최근 인시던트",
      maintenanceSection: "예정된 유지보수",
      refresh: "새로고침",
      refreshing: "새로고침 중...",
      refreshLabel: "GitHub 상태 새로고침",
      details: "{{service}} 세부 정보 표시",
      history: "인시던트 기록 보기",
      checked: "확인: {{time}}",
      updated: "업데이트: {{time}}",
      timeJustNow: "방금",
      timeMinutes: "{{count}}분 전",
      timeHours: "{{count}}시간 전",
      timeDays: "{{count}}일 전",
      staleWarning:
        "마지막으로 확인된 상태를 표시합니다. GitHub에 연결할 수 없습니다.",
      refreshFailed:
        "상태를 다시 확인할 수 없습니다. 마지막으로 확인된 상태를 표시합니다.",
      otherHealthy_one: "다른 서비스 {{count}}개 정상",
      otherHealthy_other: "다른 서비스 {{count}}개 정상",
      otherAffected: "추가 영향: {{services}}",
      unknownStatus: "알 수 없음",
      impactGit: "Git 작업",
      impactActions: "워크플로 실행",
      impactApi: "API 요청",
      impactWebhooks: "웹훅 전달",
      impactPullRequests: "풀 리퀘스트",
      impactIssues: "이슈 접근",
      impactOther: "{{service}}",
      impactHint: "{{services}}에 영향을 줄 수 있습니다.",
      maintenanceHint: "일부 모니터링 서비스가 유지보수 중입니다.",
      noIncidentUpdate: "아직 공급자의 업데이트가 없습니다.",
      incident_investigating: "조사 중",
      incident_identified: "원인 확인됨",
      incident_monitoring: "모니터링 중",
      incident_resolved: "해결됨",
      incident_scheduled: "예정됨",
      incident_in_progress: "진행 중",
      incident_verifying: "검증 중",
      incident_completed: "완료",
    },
  };

  const ACTION_HEADLINE_COPY = {
    operational: ["actionHeadlineOperational", "All systems operational"],
    maintenance: ["actionHeadlineMaintenance", "Maintenance in progress"],
    minor: ["actionHeadlineMinor", "Degraded performance"],
    major: ["actionHeadlineMajor", "Partial outage"],
    critical: ["actionHeadlineCritical", "Major outage"],
  };

  function useActionTranslator(host) {
    const useTranslation = host.i18n && host.i18n.useTranslation;
    const translation =
      typeof useTranslation === "function" ? useTranslation() : null;
    return (key, fallback, values, count) => {
      if (!translation || typeof translation.t !== "function") {
        return fallback.replace(/\{\{([^}]+)\}\}/g, (placeholder, name) =>
          values && Object.prototype.hasOwnProperty.call(values, name)
            ? String(values[name])
            : placeholder,
        );
      }
      return translation.t(key, { defaultValue: fallback, values, count });
    };
  }

  function actionSeverityHeadline(t, severity) {
    const [key, fallback] =
      ACTION_HEADLINE_COPY[severity] || ACTION_HEADLINE_COPY.operational;
    return t(key, fallback);
  }

  function actionTone(severity) {
    if (severity === "minor") return "warning";
    if (severity === "major" || severity === "critical") return "danger";
    return "neutral";
  }

  function statusActionDetails(payload) {
    const snapshot = payload && payload.snapshot;
    const incidents = (snapshot && snapshot.incidents) || [];
    if (incidents.length && incidents[0].name) return incidents[0].name;
    return ((snapshot && snapshot.keyComponents) || [])
      .filter((component) => component.severity !== "operational")
      .map((component) => component.name)
      .join(", ");
  }

  function statusActionTooltip(t, payload, loading) {
    if (loading && !payload)
      return t("actionCheckingTooltip", "Checking GitHub status");
    if (!payload) {
      return t(
        "actionUnavailableTooltip",
        "GitHub status is unavailable. Open status details.",
      );
    }
    if (payload.overall === "operational" && !payload.stale) {
      return t(
        "actionOperationalTooltip",
        "All systems operational. Open GitHub status details.",
      );
    }
    const stale = payload.stale
      ? t("actionStaleQualifier", " (stale data)")
      : "";
    return t(
      "actionTooltip",
      "{{status}}{{details}}{{stale}}. Open GitHub status details.",
      {
        status: actionSeverityHeadline(t, payload.overall),
        details: statusActionDetails(payload)
          ? " — " + statusActionDetails(payload)
          : "",
        stale,
      },
    );
  }

  const INCIDENT_STATUS_LABEL = {
    investigating: "Investigating",
    identified: "Identified",
    monitoring: "Monitoring",
    resolved: "Resolved",
    scheduled: "Scheduled",
    in_progress: "In progress",
    verifying: "Verifying",
    completed: "Completed",
  };
  const incidentStatusLabel = (status) =>
    INCIDENT_STATUS_LABEL[status] || (status ? status.replace(/_/g, " ") : "");

  function relTime(iso) {
    if (!iso) return "";
    const t = new Date(iso).getTime();
    if (Number.isNaN(t)) return "";
    const secs = Math.round((Date.now() - t) / 1000);
    if (secs < 0) return "just now";
    if (secs < 45) return "just now";
    const mins = Math.round(secs / 60);
    if (mins < 60) return `${mins}m ago`;
    const hrs = Math.round(mins / 60);
    if (hrs < 24) return `${hrs}h ago`;
    return `${Math.round(hrs / 24)}d ago`;
  }

  // Absolute local time for a maintenance window, where "in 2 days" is less
  // useful than the actual clock time the user has to plan around.
  function windowLabel(from, until, locale) {
    const start = from ? new Date(from) : null;
    const end = until ? new Date(until) : null;
    if (!start || Number.isNaN(start.getTime())) return "";
    const opts = {
      month: "short",
      day: "numeric",
      hour: "2-digit",
      minute: "2-digit",
    };
    const startText = start.toLocaleString(locale, opts);
    if (!end || Number.isNaN(end.getTime())) return startText;
    const sameDay = start.toDateString() === end.toDateString();
    const endText = end.toLocaleString(
      locale,
      sameDay ? { hour: "2-digit", minute: "2-digit" } : opts,
    );
    return `${startText} – ${endText}`;
  }

  // ── store ────────────────────────────────────────────────────────────────
  // One poll for the whole SPA. Every surface subscribes to this.
  function useBriefingTranslator(host) {
    const translate = useActionTranslator(host);
    return (key, values, count) => {
      const pluralKey =
        count === undefined ? key : `${key}_${count === 1 ? "one" : "other"}`;
      const fallback =
        PLUGIN_TRANSLATIONS.en[pluralKey] || PLUGIN_TRANSLATIONS.en[key];
      return translate(key, fallback, { count, ...values }, count);
    };
  }

  function briefingProjection(payload) {
    const snapshot = payload.snapshot || {};
    const components = snapshot.keyComponents || [];
    const healthy = components.filter((c) => c.status === "operational");
    const affected = components.filter((c) => c.status !== "operational");
    const knownAffected = affected.filter((c) =>
      Object.prototype.hasOwnProperty.call(COMPONENT_LABEL, c.status),
    );
    const incidents = snapshot.incidents || [];
    let headline = "healthyHeadline";
    if (!components.length) headline = "serviceUnavailable";
    else if (knownAffected.some((c) => c.status !== "under_maintenance"))
      headline = "affectedHeadline";
    else if (knownAffected.length) headline = "maintenanceHeadline";
    else if (affected.length) headline = "unknownHeadline";
    else if (incidents.some((i) => i.affectsKey)) headline = "activeHeadline";
    return { healthy, affected, knownAffected, incidents, headline };
  }

  function briefingTime(iso, t) {
    const timestamp = new Date(iso).getTime();
    if (!iso || Number.isNaN(timestamp)) return "";
    const seconds = Math.max(0, Math.round((Date.now() - timestamp) / 1000));
    if (seconds < 45) return t("timeJustNow");
    const minutes = Math.round(seconds / 60);
    if (minutes < 60) return t("timeMinutes", { count: minutes });
    const hours = Math.round(minutes / 60);
    if (hours < 24) return t("timeHours", { count: hours });
    return t("timeDays", { count: Math.round(hours / 24) });
  }

  const COMPONENT_COPY = {
    operational: "actionOperational",
    degraded_performance: "actionMinor",
    partial_outage: "actionMajor",
    major_outage: "actionCritical",
    under_maintenance: "actionMaintenance",
  };
  const IMPACT_COPY = {
    "Git Operations": "impactGit",
    Actions: "impactActions",
    "API Requests": "impactApi",
    Webhooks: "impactWebhooks",
    "Pull Requests": "impactPullRequests",
    Issues: "impactIssues",
  };

  function createStore(host) {
    let state = {
      loading: true,
      refreshing: false,
      error: null,
      payload: null,
    };
    const listeners = new Set();
    let timer = null;
    let inFlight = null;
    // The demo fixture to render instead of live data, driven by the
    // ?ghsDemo= URL parameter. See README "Seeing the degraded states".
    let demo = "";

    function readDemoParam() {
      try {
        return new URLSearchParams(window.location.search).get("ghsDemo") || "";
      } catch (_) {
        return "";
      }
    }

    function emit() {
      listeners.forEach((fn) => {
        try {
          fn(state);
        } catch (err) {
          console.error(`[${PLUGIN_ID}] listener failed`, err);
        }
      });
    }

    function set(next) {
      state = { ...state, ...next };
      emit();
    }

    function load() {
      if (inFlight) return inFlight;
      const nextDemo = readDemoParam();
      if (nextDemo !== demo) demo = nextDemo;
      const path = demo
        ? `webhooks/status?demo=${encodeURIComponent(demo)}`
        : "webhooks/status";
      inFlight = Promise.resolve()
        .then(() => host.api.fetch(path))
        .then(async (res) => {
          const body = await res.json();
          if (!res.ok) throw new Error(body.error || `HTTP ${res.status}`);
          set({ loading: false, error: null, payload: body });
        })
        .catch((err) => {
          // Keep the last good payload on screen. A single failed relay call
          // must not flap the chip to "unknown" — the same rule the backend
          // applies to githubstatus.com itself.
          set({ loading: false, error: String((err && err.message) || err) });
        })
        .finally(() => {
          inFlight = null;
          set({ refreshing: false });
        });
      set({ refreshing: true });
      return inFlight;
    }

    function start() {
      if (timer) return;
      load();
      timer = setInterval(load, POLL_MS);
    }

    function stop() {
      if (timer) clearInterval(timer);
      timer = null;
    }

    // acknowledge tells the backend a toast was shown, so it is not delivered
    // again after a reload.
    function acknowledge(sourceId, transitionId) {
      return host.api
        .fetch("webhooks/ack", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ sourceId, transitionId }),
        })
        .catch((err) => console.error(`[${PLUGIN_ID}] ack failed`, err));
    }

    function saveSettings(patch) {
      return host.api
        .fetch("webhooks/settings", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(patch),
        })
        .then((res) => res.json())
        .then((settings) => {
          if (state.payload) set({ payload: { ...state.payload, settings } });
          return settings;
        });
    }

    return {
      getState: () => state,
      subscribe(fn) {
        listeners.add(fn);
        start();
        return () => {
          listeners.delete(fn);
          if (listeners.size === 0) stop();
        };
      },
      refresh: load,
      acknowledge,
      saveSettings,
      stop,
    };
  }

  // ── shared building blocks ───────────────────────────────────────────────
  function makeUI(host, store) {
    const { React, jsx: h } = host;

    // useStatus subscribes a component to the shared store.
    function useStatus() {
      const [snapshot, setSnapshot] = React.useState(store.getState);
      React.useEffect(() => store.subscribe(setSnapshot), []);
      return snapshot;
    }

    // Pill is the shared status token: a dot plus a label, tinted by severity.
    function Pill({ severity, label, size }) {
      const meta = sev(severity);
      return h(
        "span",
        {
          className: `ghs-pill ${meta.cls}${size === "sm" ? " ghs-pill-sm" : ""}`,
        },
        h("span", { className: "ghs-dot" }),
        label || meta.label,
      );
    }

    function SmallIcon({ kind }) {
      const paths = {
        refresh:
          "M20 7v5h-5M4 17v-5h5M6.2 7a7 7 0 0 1 11.4-.8L20 9M4 15l2.4 2.8A7 7 0 0 0 17.8 17",
        chevron: "m6 9 6 6 6-6",
        external: "M8 4h12v12M20 4 4 20",
      };
      return h(
        "svg",
        {
          className: `ghs-icon ghs-icon-${kind}`,
          viewBox: "0 0 24 24",
          fill: "none",
          stroke: "currentColor",
          strokeWidth: 1.8,
          "aria-hidden": "true",
          focusable: "false",
        },
        h("path", { d: paths[kind] }),
      );
    }

    function ComponentRow({ component }) {
      const t = useBriefingTranslator(host);
      const healthy = component.status === "operational";
      const statusKey = COMPONENT_COPY[component.status];
      const color = statusKey ? sev(component.severity).cls : "ghs-unknown";
      const content = [
        h("span", { className: "ghs-comp-name", key: "name" }, component.name),
        h(
          "span",
          { className: "ghs-comp-status", key: "status" },
          h("span", { className: "ghs-dot" }),
          t(statusKey || "unknownStatus"),
        ),
      ];
      const props = {
        className: `ghs-comp ${color}${healthy ? " ghs-comp-healthy" : ""}`,
      };
      if (!component.description)
        return h(
          "div",
          props,
          h("div", { className: "ghs-comp-summary" }, content),
        );
      return h(
        "details",
        props,
        h(
          "summary",
          { className: "ghs-comp-summary" },
          content,
          h(
            "span",
            { className: "ghs-sr-only" },
            t("details", { service: component.name }),
          ),
          h(SmallIcon, { kind: "chevron" }),
        ),
        h("p", { className: "ghs-comp-desc" }, component.description),
      );
    }

    function ServiceGroup({ components, kind }) {
      const t = useBriefingTranslator(host);
      if (!components.length) return null;
      return h(
        "section",
        { className: "ghs-section", "data-service-group": kind },
        h(
          "h3",
          { className: "ghs-h3" },
          t(kind === "healthy" ? "healthyServices" : "affectedServices"),
        ),
        h(
          "div",
          { className: "ghs-comps" },
          components.map((c) => h(ComponentRow, { key: c.name, component: c })),
        ),
      );
    }

    function IncidentCard({ incident, kind }) {
      const t = useBriefingTranslator(host);
      const maintenance = kind === "maintenance";
      const when = maintenance
        ? windowLabel(
            incident.scheduledFor,
            incident.scheduledUntil,
            host.i18n && host.i18n.locale,
          )
        : briefingTime(incident.latestUpdateAt || incident.startedAt, t);
      const statusKey = "incident_" + incident.status;
      return h(
        "article",
        {
          className: `ghs-inc ${sev(maintenance ? "maintenance" : incident.severity).cls}`,
        },
        h(
          "div",
          { className: "ghs-inc-meta" },
          h(
            "span",
            { className: "ghs-inc-phase" },
            h("span", { className: "ghs-dot" }),
            PLUGIN_TRANSLATIONS.en[statusKey]
              ? t(statusKey)
              : incidentStatusLabel(incident.status),
          ),
          when
            ? h(
                "span",
                { className: "ghs-inc-when" },
                maintenance ? when : t("updated", { time: when }),
              )
            : null,
        ),
        h("h4", { className: "ghs-inc-title" }, incident.name),
        h(
          "p",
          { className: "ghs-inc-body" },
          incident.latestUpdate || t("noIncidentUpdate"),
        ),
        incident.url
          ? h(
              "a",
              {
                className: "ghs-history",
                href: incident.url,
                target: "_blank",
                rel: "noreferrer",
              },
              t("history"),
              h(SmallIcon, { kind: "external" }),
            )
          : null,
      );
    }

    function FreshnessToolbar({ payload, refreshing }) {
      const t = useBriefingTranslator(host);
      const Button = host.ui.Button || "button";
      const time = briefingTime(payload.fetchedAt, t);
      return h(
        "div",
        { className: "ghs-toolbar" },
        h(
          "div",
          { className: "ghs-freshness" },
          payload.stale
            ? h("span", { className: "ghs-stale" }, t("actionStale"))
            : null,
          h(
            "span",
            { className: "ghs-checked" },
            time ? t("checked", { time }) : t("fetchTimeUnavailable"),
          ),
        ),
        h(
          Button,
          {
            type: "button",
            className: "ghs-refresh",
            onClick: () => store.refresh(),
            disabled: refreshing,
            "aria-busy": refreshing,
            "aria-label": t("refreshLabel"),
          },
          h(SmallIcon, { kind: "refresh" }),
          t(refreshing ? "refreshing" : "refresh"),
        ),
      );
    }

    function ImpactSummary({ payload, briefing }) {
      const severityCopy = {
        minor: "actionMinor",
        major: "actionMajor",
        critical: "actionCritical",
      };
      const t = useBriefingTranslator(host);
      const impacts = briefing.knownAffected.map((c) =>
        t(IMPACT_COPY[c.name] || "impactOther", { service: c.name }),
      );
      const locale = host.i18n && host.i18n.locale;
      const list = impacts.length
        ? new Intl.ListFormat(locale, {
            style: "long",
            type: "conjunction",
          }).format(impacts)
        : "";
      const hint =
        briefing.headline === "maintenanceHeadline"
          ? t("maintenanceHint")
          : list
            ? t("impactHint", { services: list })
            : null;
      return h(
        "section",
        { className: `ghs-hero ${sev(payload.overall).cls}` },
        h(
          "div",
          { className: "ghs-hero-heading" },
          h(
            "h2",
            { className: "ghs-hero-title" },
            t(
              briefing.headline,
              null,
              briefing.headline === "affectedHeadline"
                ? briefing.knownAffected.length
                : undefined,
            ),
          ),
          briefing.headline === "affectedHeadline" ||
            briefing.headline === "activeHeadline"
            ? h(Pill, {
                severity: payload.overall,
                label: t(severityCopy[payload.overall] || "actionMinor"),
                size: "sm",
              })
            : null,
        ),
        hint ? h("p", { className: "ghs-hero-sub" }, hint) : null,
      );
    }

    function IncidentSection({ incidents, maintenance }) {
      const t = useBriefingTranslator(host);
      if (!incidents.length) return null;
      return h(
        "section",
        { className: "ghs-section" },
        h(
          "h3",
          { className: "ghs-h3" },
          t(maintenance ? "maintenanceSection" : "latestIncident"),
        ),
        h(
          "div",
          { className: "ghs-incs" },
          incidents.map((i) =>
            h(IncidentCard, {
              key: i.id,
              incident: i,
              kind: maintenance ? "maintenance" : undefined,
            }),
          ),
        ),
      );
    }

    function StatusFooter({ payload }) {
      const t = useBriefingTranslator(host);
      const others =
        (payload.snapshot && payload.snapshot.otherComponents) || [];
      const affected = others.filter((c) => c.status !== "operational");
      return h(
        "footer",
        { className: "ghs-foot" },
        h(
          "span",
          { className: "ghs-foot-others" },
          affected.length
            ? t("otherAffected", {
                services: affected
                  .map(
                    (c) =>
                      `${c.name} (${t(COMPONENT_COPY[c.status] || "unknownStatus")})`,
                  )
                  .join(", "),
              })
            : others.length
              ? t("otherHealthy", null, others.length)
              : null,
        ),
        h(
          "a",
          {
            className: "ghs-foot-link",
            href: payload.pageUrl,
            target: "_blank",
            rel: "noreferrer",
          },
          "githubstatus.com",
          h(SmallIcon, { kind: "external" }),
        ),
      );
    }

    // The glyph is plugin content inside the host-owned Action icon box. The
    // host controls the box and outer button geometry on every surface.
    function StatusActionIcon({ active, stale }) {
      let indicatorClass = "ghs-action-indicator";
      if (active && !stale) indicatorClass += " ghs-action-indicator-active";
      if (stale) indicatorClass += " ghs-action-indicator-stale";
      return h(
        "svg",
        {
          className: "ghs-action-mark",
          viewBox: "0 0 16 16",
          "aria-hidden": "true",
          focusable: "false",
        },
        h("path", {
          fill: "currentColor",
          d: "M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.01 8.01 0 0 0 16 8c0-4.42-3.58-8-8-8Z",
        }),
        h("circle", {
          cx: "13",
          cy: "3",
          r: "2.35",
          className: indicatorClass,
        }),
      );
    }

    // ── modal panel ────────────────────────────────────────────────────────
    // Note: host.ui has no TooltipProvider inside modal content, so nothing
    // here relies on a tooltip — every label is rendered inline instead.
    function StatusPanel() {
      const { loading, refreshing, error, payload } = useStatus();
      const t = useBriefingTranslator(host);
      if (loading && !payload)
        return h(
          "div",
          { className: "ghs-root ghs-empty", role: "status" },
          t("checking"),
        );
      if (!payload)
        return h(
          "div",
          { className: "ghs-root ghs-error", role: "alert" },
          t("unavailable"),
        );
      const briefing = briefingProjection(payload);
      const maintenances = (
        (payload.snapshot && payload.snapshot.maintenances) ||
        []
      ).filter((m) => m.status !== "completed");
      return h(
        "div",
        { className: "ghs-root" },
        h(FreshnessToolbar, { payload, refreshing }),
        payload.stale
          ? h(
              "div",
              { className: "ghs-notice", role: "status" },
              t("staleWarning"),
            )
          : null,
        error
          ? h(
              "div",
              { className: "ghs-notice ghs-recheck-error", role: "alert" },
              t("refreshFailed"),
            )
          : null,
        h(ImpactSummary, { payload, briefing }),
        h(ServiceGroup, { components: briefing.affected, kind: "affected" }),
        h(ServiceGroup, { components: briefing.healthy, kind: "healthy" }),
        h(IncidentSection, { incidents: briefing.incidents }),
        h(IncidentSection, { incidents: maintenances, maintenance: true }),
        h(StatusFooter, { payload }),
      );
    }

    function openStatusModal() {
      if (typeof host.openModal === "function") {
        const title =
          host.i18n && host.i18n.t
            ? host.i18n.t("actionLabel", { defaultValue: "GitHub Status" })
            : "GitHub Status";
        return host.openModal({ title, content: StatusPanel, size: "lg" });
      }
      // No host modal on this build: fall back to the source of truth rather
      // than silently doing nothing.
      const state = store.getState();
      const url =
        (state.payload && state.payload.pageUrl) ||
        "https://www.githubstatus.com";
      window.open(url, "_blank", "noopener");
      return null;
    }

    // ── toast stack ────────────────────────────────────────────────────────
    // Rendered by the status-bar chip so there is no extra mount point, and
    // the toasts follow the app rather than a route. Only ONE chip instance
    // owns it (desktop bar and mobile drawer can both be mounted).
    let toastOwner = null;

    function useToasts(instanceId) {
      const { payload } = useStatus();
      const [toasts, setToasts] = React.useState([]);
      const seen = React.useRef(new Set());

      const owns = toastOwner === instanceId;
      React.useEffect(() => {
        if (toastOwner === null) toastOwner = instanceId;
        return () => {
          if (toastOwner === instanceId) toastOwner = null;
        };
      }, [instanceId]);

      const transition = payload && payload.transition;
      React.useEffect(() => {
        if (!owns || !transition || seen.current.has(transition.id))
          return undefined;
        seen.current.add(transition.id);
        setToasts((prev) => [...prev, transition]);
        // Acknowledge immediately: the backend's job is "deliver once", the
        // dismiss timer below is purely cosmetic.
        store.acknowledge(transition.sourceId, transition.id);
        const timer = setTimeout(
          () => setToasts((prev) => prev.filter((t) => t.id !== transition.id)),
          TOAST_MS,
        );
        return () => clearTimeout(timer);
      }, [owns, transition && transition.id]);

      const dismiss = React.useCallback(
        (id) => setToasts((prev) => prev.filter((t) => t.id !== id)),
        [],
      );
      return { toasts: owns ? toasts : [], dismiss };
    }

    function ToastStack({ toasts, dismiss }) {
      if (!toasts.length) return null;
      return h(
        "div",
        { className: "ghs-toasts" },
        toasts.map((t) =>
          h(
            "div",
            {
              key: t.id,
              className: `ghs-toast ${sev(t.to).cls}`,
              role: "status",
            },
            h("span", { className: "ghs-dot" }),
            h(
              "div",
              { className: "ghs-toast-text" },
              h("div", { className: "ghs-toast-title" }, t.title),
              t.detail
                ? h("div", { className: "ghs-toast-detail" }, t.detail)
                : null,
            ),
            h(
              "button",
              {
                type: "button",
                className: "ghs-toast-open",
                onClick: () => {
                  dismiss(t.id);
                  openStatusModal();
                },
              },
              "Details",
            ),
            h(
              "button",
              {
                type: "button",
                className: "ghs-toast-x",
                onClick: () => dismiss(t.id),
                "aria-label": "Dismiss",
              },
              "×",
            ),
          ),
        ),
      );
    }

    // ── status-bar chip ────────────────────────────────────────────────────
    let nextInstanceId = 0;

    function StatusChip({ slotProps }) {
      const instanceId = React.useRef(++nextInstanceId).current;
      const { payload, loading } = useStatus();
      const { toasts, dismiss } = useToasts(instanceId);
      const t = useActionTranslator(host);
      const mobile = slotProps && slotProps.presentation === "mobile-drawer";

      const severity = (payload && payload.overall) || "operational";
      const loud = Boolean(payload && payload.loud);
      const meta = sev(severity);
      const stale = Boolean(payload && payload.stale);

      const Action = host.ui && host.ui.Action;
      if (typeof Action === "function") {
        return h(
          React.Fragment,
          null,
          h(Action, {
            label: t("actionLabel", "GitHub status"),
            icon: h(StatusActionIcon, { active: loud, stale }),
            tone: actionTone(severity),
            tooltip: statusActionTooltip(t, payload, loading),
            onClick: () => openStatusModal(),
            "data-testid": "github-status-chip",
          }),
          h(ToastStack, { toasts, dismiss }),
        );
      }

      const title = statusActionTooltip(t, payload, loading);

      return h(
        React.Fragment,
        null,
        h(
          "button",
          {
            type: "button",
            className: `ghs-chip ${meta.cls}`,
            "data-loud": String(loud),
            "data-stale": String(stale),
            style: mobile
              ? {
                  minHeight: "2.75rem",
                  width: "100%",
                  justifyContent: "flex-start",
                  padding: "0 0.75rem",
                  fontSize: "0.85rem",
                }
              : null,
            onClick: () => openStatusModal(),
            "aria-label": `GitHub status: ${meta.headline}${stale ? ", stale data" : ""}`,
            title,
          },
          h(GitHubMark, { stale }),
        ),
        h(ToastStack, { toasts, dismiss }),
      );
    }

    // ── main top bar banner ────────────────────────────────────────────────
    // Renders nothing at all while GitHub is healthy. That silence is the
    // feature: this slot is only worth its pixels during an incident.
    //
    // When it does render it is a 32x32 icon button, the same footprint as
    // every other control in the host's top-bar actions row. A labelled pill
    // here is ~190px in a row that is otherwise all icons — it crowds the
    // bar and covers the task search. The severity colour on a GitHub mark
    // carries the signal; the words live in the hover title and the modal.
    function GitHubMark({ stale = false } = {}) {
      // GitHub's Invertocat, inlined so the button needs no asset request and
      // inherits currentColor from the severity token.
      return h(
        "svg",
        {
          className: "ghs-mark",
          viewBox: "0 0 16 16",
          "aria-hidden": "true",
          focusable: "false",
        },
        h("path", {
          fill: "currentColor",
          d: "M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.01 8.01 0 0 0 16 8c0-4.42-3.58-8-8-8Z",
        }),
        stale
          ? h("circle", {
              cx: "13",
              cy: "3",
              r: "2.35",
              className: "ghs-mark-stale-indicator",
            })
          : null,
      );
    }

    function StatusBanner() {
      const { payload } = useStatus();
      const t = useActionTranslator(host);
      if (!payload || !payload.loud) return null;

      const meta = sev(payload.overall);
      const Action = host.ui && host.ui.Action;
      if (typeof Action === "function") {
        return h(Action, {
          label: t("actionLabel", "GitHub status"),
          icon: h(StatusActionIcon, {
            active: true,
            stale: Boolean(payload.stale),
          }),
          tone: actionTone(payload.overall),
          tooltip: statusActionTooltip(t, payload, false),
          onClick: () => openStatusModal(),
          "data-testid": "github-status-topbar-action",
        });
      }

      const snap = payload.snapshot;
      const incident = ((snap && snap.incidents) || [])[0];
      const affected = ((snap && snap.keyComponents) || [])
        .filter((c) => c.severity !== "operational")
        .map((c) => c.name);
      const detail = incident ? incident.name : affected.join(", ");
      const label = `GitHub — ${meta.headline}${detail ? ` · ${detail}` : ""}${payload.stale ? " (stale)" : ""}`;

      return h(
        "button",
        {
          type: "button",
          className: `ghs-banner ${meta.cls}`,
          "data-stale": String(Boolean(payload.stale)),
          onClick: () => openStatusModal(),
          // A native title, not host.ui Tooltip — this is top-bar chrome, and
          // the host's TooltipProvider is not something a plugin slot can
          // count on.
          title: label,
          "aria-label": `${label}. Open details.`,
        },
        h(GitHubMark),
        h("span", { className: "ghs-banner-pip" }),
      );
    }

    // ── plugin settings ────────────────────────────────────────────────────
    function SettingsPanel() {
      const { payload } = useStatus();
      const [saving, setSaving] = React.useState(false);
      const [error, setError] = React.useState(null);
      const enabled =
        payload && payload.settings
          ? payload.settings.notifyOnTransition
          : true;

      const Switch = host.ui && host.ui.Switch;
      const Label = host.ui && host.ui.Label;

      const toggle = (next) => {
        setSaving(true);
        setError(null);
        store
          .saveSettings({ notifyOnTransition: next })
          .catch((err) => setError(String((err && err.message) || err)))
          .finally(() => setSaving(false));
      };

      const control = Switch
        ? h(Switch, {
            id: "ghs-notify",
            checked: enabled,
            disabled: saving,
            onCheckedChange: toggle,
          })
        : h("input", {
            id: "ghs-notify",
            type: "checkbox",
            checked: enabled,
            disabled: saving,
            onChange: (e) => toggle(e.target.checked),
          });

      const text = h(
        "div",
        { className: "ghs-set-text" },
        Label
          ? h(
              Label,
              { htmlFor: "ghs-notify", className: "ghs-set-title" },
              "Notify on status changes",
            )
          : h(
              "span",
              { className: "ghs-set-title" },
              "Notify on status changes",
            ),
        h(
          "p",
          { className: "ghs-set-desc" },
          "Show a toast when GitHub degrades or recovers. Only on a change — a steady outage is announced once, not every minute. The status-bar chip and the top-bar banner are always live.",
        ),
      );

      return h(
        "div",
        { className: "ghs-settings" },
        h(
          "div",
          { className: "ghs-set-row" },
          text,
          h("span", { className: "ghs-spacer" }),
          control,
        ),
        error ? h("div", { className: "ghs-set-error" }, error) : null,
      );
    }

    return {
      StatusChip,
      StatusBanner,
      SettingsPanel,
      StatusPanel,
      openStatusModal,
    };
  }

  // ── registration ─────────────────────────────────────────────────────────
  let activeStore = null;

  window.registerKandevPlugin(PLUGIN_ID, {
    initialize(registry, host) {
      // initialize can run again across disable/enable cycles in the same
      // tab; drop the previous store's interval before creating a new one.
      if (activeStore) activeStore.stop();
      activeStore = createStore(host);

      const ui = makeUI(host, activeStore);

      if (typeof registry.registerTranslations === "function") {
        registry.registerTranslations(PLUGIN_TRANSLATIONS);
      }
      registry.registerComponent("app-status-bar-right", ui.StatusChip);
      registry.registerComponent("main-top-bar", ui.StatusBanner);
      registry.registerComponent("chat-top-bar", ui.StatusBanner);
      registry.registerComponent("plugin-settings", ui.SettingsPanel);
    },
    destroy() {
      if (activeStore) activeStore.stop();
      activeStore = null;
    },
  });
})();
