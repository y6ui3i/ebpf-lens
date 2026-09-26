// UI language switching (English / Japanese).
// English is the default for non-Japanese browsers. Both dictionaries must have the same keys:
// `ja` is typed from the keys of `en`, so a missing translation fails `tsc`.
import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from "react";

export type Lang = "en" | "ja";

const STORAGE_KEY = "ebpflens.lang";

const en = {
  // Language switch
  "lang.en": "EN",
  "lang.ja": "日本語",
  "lang.aria": "Language",

  // Common
  "common.ongoing": "ongoing",
  "common.none": "None",
  "common.time": "Time",
  "common.process": "Process",
  "common.count": "Count",
  "common.seconds": "{n} s",
  "range.sep": " – ",
  "list.sep": ", ",
  "unit.s": "s",
  "unit.min": "min",
  "unit.h": "h",
  "unit.msPerSec": "ms/s",
  "chart.caution": "Caution {v}",
  "chart.warning": "Warning {v}",

  // Levels
  "level.ok": "OK",
  "level.caution": "Caution",
  "level.warning": "Warning",

  // Pages / routes
  "page.dashboard": "Dashboard",
  "page.all": "All panels",
  "page.cpu": "CPU wait time",
  "page.impact": "Cause and impact",
  "page.memory": "Memory",
  "page.processes": "Process starts and exits",

  // Top bar
  "app.homeAria": "Go to dashboard",
  "app.hostAria": "Host",
  "app.noHosts": "No hosts",
  "app.waitingPre": "Waiting for data from an agent. Start ",
  "app.waitingPost": ".",
  "app.jumpAria": "Jump to panel",
  "status.live": "Live",
  "status.connecting": "Connecting",
  "status.reconnecting": "Reconnecting",

  // Nav
  "nav.aria": "Menu",
  "nav.open": "Open menu",
  "nav.close": "Close menu",
  "nav.group.ebpflens": "eBPFLens",
  "nav.group.resources": "Resources",
  "nav.group.recent": "Recently viewed",
  "nav.soon": "Coming soon",
  "resource.cpu": "CPU",
  "resource.memory": "Memory",
  "resource.processes": "Processes",
  "resource.disk": "Disk",
  "resource.network": "Network",
  "resource.gpu": "GPU",

  // Lens Summary
  "summary.cpu.ok": "CPU wait time is low",
  "summary.cpu.caution": "CPU wait is rising",
  "summary.cpu.warning": "Processes are competing for CPU",
  "summary.mem.ok": "",
  "summary.mem.caution": "Processes are starting to stall on low memory",
  "summary.mem.warning": "Processes are heavily stalled on low memory",
  "summary.life.oom": "A process was killed due to low memory",
  "summary.life.loop": "A process is crashing repeatedly",
  "summary.life.crash": "A process exited abnormally",
  "summary.p99Ok": "99% of tasks got a CPU within {p99}",
  "summary.p99Bad": "99% of tasks waited up to {p99} for a CPU",
  "summary.baseRatio": " (about {ratio}× the usual {base}).",
  "summary.base": " (usually {base}).",
  "summary.period": ".",
  "summary.util": " CPU utilization is {pct}%.",
  "summary.recentEpisodes": "Recent CPU episodes (in view)",
  "summary.col.level": "Level",
  "summary.col.period": "Time",
  "summary.col.duration": "Duration",
  "summary.col.peak": "Max wait (p99)",
  "episode.ongoing": "High CPU wait since {start}, for {seconds} s so far (max {peak}).",
  "episode.past": "High CPU wait was observed {span} (max {peak}, {seconds} s).",
  "episode.spanAround": "around {t}",
  "episode.spanRange": "from {a} to {b}",
  "cause.who": "{comm} ({n} processes)",
  "cause.culpritOngoing": "Cause: {who} is using {pct}% of total CPU.",
  "cause.culpritPast": "Cause: {who} was using {pct}% of total CPU.",
  "cause.noCulprit": "No single process was hogging the CPU.",
  "cause.victim": "{comm} ({total} total, 99% within {p99})",
  "cause.victims": "Processes kept waiting: {list}.",
  "cause.victimsOthers": "Other processes kept waiting: {list}.",

  // Lifecycle sentence (lib/lifecycle.ts)
  "life.signal": "signal {n}",
  "life.oomWhyMemcg": "its cgroup hit its memory limit",
  "life.oomWhyHost": "the host ran out of memory",
  "life.oomMore": " (+{n} more)",
  "life.oom": "At {time}, {comm} (pid {pid}) was OOM-killed because {why}{more}.",
  "life.loop": "{comm} has crashed {count} times in the last 5 minutes.",
  "life.crash": "At {time}, {comm} (pid {pid}) crashed with {signal}.",
  // Exits include processes started before the window, so {short} is not a subset of {execs}.
  "life.none": "No crashes. In the last 5 minutes, {execs} processes started and {short} exited in under 1 s.",

  // Memory sentence (lib/memory.ts)
  "mem.usage": "{pct}% used, {free} available",
  "mem.top": " (top: {comm})",
  "mem.stalling": "Processes are stalled on memory reclaim for {stall} in total{top}. {usage}.",
  "mem.viaMemcg": "reclaim under its cgroup limit",
  "mem.viaReclaim": "memory reclaim",
  "mem.recent": "No stalls right now ({usage}). In the last 5 minutes, {comm} stalled {count} times on {via}, {ms} ms in total.",
  "mem.none": "No process has stalled on memory reclaim ({usage}).",

  // USE matrix
  "use.title": "Status by resource",
  "use.desc": "USE method: check utilization, saturation and errors per resource. Click a cell for details",
  "use.col.util": "Utilization",
  "use.col.utilHint": "how busy",
  "use.col.sat": "Saturation",
  "use.col.satHint": "waiting for lack of capacity",
  "use.col.err": "Errors",
  "use.col.errHint": "failures and kills",
  "use.cpuUtil": "Average of the last 5 s",
  "use.cpuSat": "Wait for 99% of tasks to get a CPU",
  "use.memUtil": "{free} available (/proc)",
  "use.memSat": "Time processes stalled on reclaim",
  "use.memErr": "OOM kills (last 5 min)",
  "use.procUtil": "Starts (last 5 min)",
  "use.procErr": "Crashes (last 5 min)",
  "use.planned": "Not implemented (roadmap {n})",
  "use.sparkAria": "{note}, trend over the last 5 min",

  // Impact panel
  "impact.scopeEpisode": "episode {range}",
  "impact.scopeRecent": "last {n} s",
  "impact.desc": "Who was using the CPU and who was kept waiting ({scope})",
  "impact.scopeAria": "Range to aggregate",
  "impact.btnEpisode": "Latest episode",
  "impact.btnRecent": "Last {n} s",
  "impact.noData": "No per-process data yet (the agent may be outdated)",
  "impact.cpuTitle": "Processes using the CPU",
  "impact.cpuShare": "Share of total CPU",
  "impact.cpuTime": "CPU time",
  "impact.waitTitle": "Processes kept waiting",
  "impact.waitTotal": "Total wait",
  "impact.p99Within": "99% within",
  "impact.max": "Max",
  "impact.culpritTag": "(cause)",
  "impact.footer": "Processes with the same name are grouped. The agent sends only the top processes each second, so totals are approximate",

  // CPU latency card
  "cpu.desc": "How long a runnable process waits before it gets a CPU",
  "cpu.lastSecond": "Last 1 s",
  "cpu.p99Pre": "99% of tasks got a CPU within ",
  "cpu.p99Post": "",
  "cpu.p50": "Half within {p50} · {n} total",
  "cpu.distTitle": "Wait time distribution",
  "cpu.distNote": "Last 5 min, 1 column = 1 s",
  "cpu.trendTitle": "Wait time trend and thresholds",
  "cpu.trendNote": "While the p99 line is inside a band, processes are competing for CPU (provisional thresholds)",
  "cpu.hideTable": "Hide table",
  "cpu.showTable": "Show the latest histogram as a table",
  "cpu.chartAria": "CPU wait time p50 and p99 over time (log scale)",
  "cpu.seriesP50": "Half of tasks (p50)",
  "cpu.seriesP99": "99% of tasks (p99)",

  // Histogram table
  "hist.caption": "1 interval at {time}",
  "hist.wait": "Wait time",
  "hist.count": "Count",
  "hist.share": "Share",

  // Heatmap
  "heat.aria": "Heatmap of CPU wait time. X axis: time, Y axis: wait time, color: count",
  "heat.yCaption": "Time spent waiting for a CPU (longer toward the top)",
  "heat.count": "{n} times",
  "heat.xAxis": "X axis",
  "heat.xDesc": "when it happened",
  "heat.yAxis": "Y axis",
  "heat.color": "Color",
  "heat.colorDesc": "how often that wait occurred ({more})",
  "heat.brighter": "brighter = more",
  "heat.darker": "darker = more",

  // Memory panel
  "mem.title": "Memory reclaim stalls",
  "mem.desc": "Time processes spent stalled freeing memory themselves (reclaim) when memory ran short",
  "mem.tileStall": "Reclaim stall time",
  "mem.tileStallNote": "Sum over all processes, median of the last 5 s (eBPF)",
  "mem.tileUsed": "Used",
  "mem.tileUsedNote": "{total} total (/proc/meminfo)",
  "mem.tileAvail": "Available",
  "mem.tileAvailNote": "MemAvailable (/proc/meminfo)",
  "mem.tilePsiNote": "For cross-checking (/proc/pressure/memory)",
  "mem.distTitle": "Distribution of stall time per event",
  "mem.distNote": "Last 5 min, 1 column = 1 s. Empty if nothing happened",
  "mem.heatAria": "Heatmap of memory reclaim stall time. X axis: time, Y axis: stall time per event, color: count",
  "mem.heatYCaption": "Stall time per reclaim (longer toward the top)",
  "mem.trendTitle": "Stall time over time (eBPF and PSI)",
  "mem.trendNote": "Caution {c} ms/s, warning {w} ms/s (provisional). PSI is weighted by per-CPU busy time, so it reads lower than eBPF",
  "mem.procsTitle": "Processes stalled on reclaim (last 5 min)",
  "mem.colTotal": "Total stalled",
  "mem.colMax": "Max per event",
  "mem.colReclaimed": "Reclaimed",
  "mem.colCause": "Cause",
  "mem.causeMemcg": "cgroup limit",
  "mem.causeHost": "Host-wide shortage",
  "mem.causeBoth": "Both",
  "mem.seriesEbpf": "eBPF (process stall time)",
  "mem.seriesPsi": "PSI some (cross-check)",
  "mem.chartAria": "Memory reclaim stall time over time, eBPF and PSI side by side",

  // Lifecycle panel
  "lp.desc": "Record of process starts, exits and kills (last 5 min). Even processes that exit instantly are captured one by one",
  "lp.tileExec": "Started",
  "lp.tileExecNote": "Number of execs",
  "lp.tileShort": "Exited in under 1 s",
  "lp.tileShortNote": "Invisible to monitors that poll every few tens of seconds",
  "lp.tileErr": "Error exits",
  "lp.tileErrNote": "Non-zero exit code (not used for the status)",
  "lp.tileCrash": "Crashes / OOM",
  "lp.tileCrashNote": "Crashes such as SIGSEGV, and kills due to low memory",
  "lp.notableTitle": "Processes that ended abnormally",
  "lp.crash": "Crash",
  "lp.shortTitle": "Processes that exited in under 1 s",
  "lp.shortNote": "Short-lived commands run from cron or scripts. Too many of them nibble away at the CPU",
  "lp.colCommand": "Command",
  "lp.colMedian": "Lifetime (median)",
  "lp.colMin": "Shortest",
  "lp.logTitle": "Recent events",
  "lp.onlyProblems": "Problems only",
  "lp.logNote": "Latest {n}, newest first. Command-line arguments are not recorded",
  "lp.dropped": "Dropped {n} events because processing fell behind",
  "lp.kind.exec": "Start",
  "lp.kind.exit": "Exit",
  "lp.kind.oom": "OOM kill",
  "lp.lifetime": "lifetime {v}",
  "lp.coreDump": " (core dumped)",
  "lp.exitCode": "exit code {n}",
  "lp.scopeMemcg": "the cgroup limit ({mb} MB)",
  "lp.scopeHost": "the host limit ({mb} MB)",
  "lp.oomDesc": "Killed on reaching {scope} · triggered by {comm} (pid {pid})",
};

export type Key = keyof typeof en;
export type Params = Record<string, string | number>;

const ja: Record<Key, string> = {
  "lang.en": "EN",
  "lang.ja": "日本語",
  "lang.aria": "言語",

  "common.ongoing": "継続中",
  "common.none": "ありません",
  "common.time": "時刻",
  "common.process": "プロセス",
  "common.count": "回数",
  "common.seconds": "{n} 秒",
  "range.sep": " 〜 ",
  "list.sep": "、",
  "unit.s": "秒",
  "unit.min": "分",
  "unit.h": "時間",
  "unit.msPerSec": "ms/秒",
  "chart.caution": "注意 {v}",
  "chart.warning": "警告 {v}",

  "level.ok": "正常",
  "level.caution": "注意",
  "level.warning": "警告",

  "page.dashboard": "ダッシュボード",
  "page.all": "すべてのパネル",
  "page.cpu": "CPU実行待ち時間",
  "page.impact": "原因と影響",
  "page.memory": "メモリ",
  "page.processes": "プロセスの起動と終了",

  "app.homeAria": "ダッシュボードへ",
  "app.hostAria": "ホスト",
  "app.noHosts": "ホストなし",
  "app.waitingPre": "エージェントからのデータを待っています。",
  "app.waitingPost": " を起動してください。",
  "app.jumpAria": "パネルへ移動",
  "status.live": "ライブ",
  "status.connecting": "接続中",
  "status.reconnecting": "再接続中",

  "nav.aria": "メニュー",
  "nav.open": "メニューを開く",
  "nav.close": "メニューを閉じる",
  "nav.group.ebpflens": "eBPFLens",
  "nav.group.resources": "リソース",
  "nav.group.recent": "最近見た画面",
  "nav.soon": "準備中",
  "resource.cpu": "CPU",
  "resource.memory": "メモリ",
  "resource.processes": "プロセス",
  "resource.disk": "ディスク",
  "resource.network": "ネットワーク",
  "resource.gpu": "GPU",

  "summary.cpu.ok": "CPU待ち時間は低い状態です",
  "summary.cpu.caution": "CPU待ちがやや増えています",
  "summary.cpu.warning": "CPUの取り合いが起きています",
  "summary.mem.ok": "",
  "summary.mem.caution": "メモリ不足でプロセスが止まり始めています",
  "summary.mem.warning": "メモリ不足でプロセスが大きく止まっています",
  "summary.life.oom": "メモリ不足でプロセスが強制終了されました",
  "summary.life.loop": "クラッシュを繰り返しているプロセスがあります",
  "summary.life.crash": "異常終了したプロセスがあります",
  "summary.p99Ok": "99%のタスクが {p99} 以内にCPUを獲得しています",
  "summary.p99Bad": "99%のタスクがCPUを得るまで最大 {p99} 待たされています",
  "summary.baseRatio": "(平常時 {base} の約{ratio}倍)。",
  "summary.base": "(平常時 {base})。",
  "summary.period": "。",
  "summary.util": " CPU使用率は {pct}% です。",
  "summary.recentEpisodes": "CPU の直近の出来事(表示範囲内)",
  "summary.col.level": "レベル",
  "summary.col.period": "時間帯",
  "summary.col.duration": "継続",
  "summary.col.peak": "最大待ち(p99)",
  "episode.ongoing": "{start} から {seconds} 秒間、高いCPU待ちが続いています(最大 {peak})。",
  "episode.past": "{span}に高いCPU待ちが観測されました(最大 {peak}、{seconds} 秒間)。",
  "episode.spanAround": "{t}頃",
  "episode.spanRange": "{a}〜{b}",
  "cause.who": "{comm}({n}プロセス)",
  "cause.culpritOngoing": "原因: {who} がCPU全体の{pct}%を使っています。",
  "cause.culpritPast": "原因: {who} がCPU全体の{pct}%を使っていました。",
  "cause.noCulprit": "特定のプロセスがCPUを占有していたわけではありません。",
  "cause.victim": "{comm}(合計 {total}、99%は {p99} 以内)",
  "cause.victims": "待たされたのは {list} です。",
  "cause.victimsOthers": "そのほかで待たされたのは {list} です。",

  "life.signal": "シグナル {n}",
  "life.oomWhyMemcg": "cgroup のメモリ上限に達したため",
  "life.oomWhyHost": "ホスト全体のメモリが不足したため",
  "life.oomMore": "(ほか {n} 件)",
  "life.oom": "{time} に、{why} {comm}(pid {pid})が強制終了されました{more}。",
  "life.loop": "{comm} が直近5分で {count} 回クラッシュしています。",
  "life.crash": "{time} に {comm}(pid {pid})が {signal} で異常終了しました。",
  // Not "うち" (of which): exits include processes started before the window.
  "life.none": "異常終了はありません。直近5分で {execs} 回起動し、1秒未満で終わったプロセスは {short} 件でした。",

  "mem.usage": "使用率 {pct}%、空き {free}",
  "mem.top": "(一番は {comm})",
  "mem.stalling": "メモリの回収で、プロセスが合計 {stall} 止まっています{top}。{usage}。",
  "mem.viaMemcg": "cgroup の上限による回収で",
  "mem.viaReclaim": "メモリの回収で",
  "mem.recent": "今は止まっていません({usage})。直近5分では {comm} が{via} {count} 回、合計 {ms} ms 止まりました。",
  "mem.none": "メモリの回収で止まったプロセスはありません({usage})。",

  "use.title": "資源ごとの状態",
  "use.desc": "USE メソッド: 資源ごとに使用率・飽和・エラーを見る。升目を押すと詳しい画面へ",
  "use.col.util": "使用率",
  "use.col.utilHint": "どれだけ使っているか",
  "use.col.sat": "飽和",
  "use.col.satHint": "足りずに待たされているか",
  "use.col.err": "エラー",
  "use.col.errHint": "失敗や強制終了",
  "use.cpuUtil": "直近5秒の平均",
  "use.cpuSat": "99%のタスクがCPUを得るまでの待ち",
  "use.memUtil": "空き {free}(/proc)",
  "use.memSat": "回収でプロセスが止まった時間",
  "use.memErr": "OOM kill(直近5分)",
  "use.procUtil": "起動(直近5分)",
  "use.procErr": "クラッシュ(直近5分)",
  "use.planned": "未実装(ロードマップ {n})",
  "use.sparkAria": "{note}の直近5分の推移",

  "impact.scopeEpisode": "出来事 {range}",
  "impact.scopeRecent": "直近 {n} 秒",
  "impact.desc": "誰がCPUを使っていて、誰が待たされたか({scope})",
  "impact.scopeAria": "集計する範囲",
  "impact.btnEpisode": "直近の出来事",
  "impact.btnRecent": "直近 {n} 秒",
  "impact.noData": "プロセス別のデータがまだありません(エージェントが古い可能性があります)",
  "impact.cpuTitle": "CPUを使っていたプロセス",
  "impact.cpuShare": "CPU全体に占める割合",
  "impact.cpuTime": "CPU時間",
  "impact.waitTitle": "待たされていたプロセス",
  "impact.waitTotal": "待ちの合計",
  "impact.p99Within": "99%は以内",
  "impact.max": "最大",
  "impact.culpritTag": "(原因側)",
  "impact.footer": "同じ名前のプロセスはまとめて表示。エージェントは1秒ごとに上位のプロセスだけを送るため、合計は近似値です",

  "cpu.desc": "実行可能になったプロセスが、CPUに割り当てられるまでの待ち時間",
  "cpu.lastSecond": "直近1秒",
  "cpu.p99Pre": "99%のタスクが ",
  "cpu.p99Post": " 以内にCPUを獲得",
  "cpu.p50": "半数は {p50} 以内 · 計 {n} 回",
  "cpu.distTitle": "待ち時間の分布",
  "cpu.distNote": "直近5分・1列 = 1秒",
  "cpu.trendTitle": "待ち時間の推移としきい値",
  "cpu.trendNote": "p99 の線が帯に入っている間は、CPUの取り合いが起きています(しきい値は仮)",
  "cpu.hideTable": "表を閉じる",
  "cpu.showTable": "直近のヒストグラムを表で見る",
  "cpu.chartAria": "CPU実行待ち時間の p50 と p99 の推移(対数軸)",
  "cpu.seriesP50": "半数のタスク(p50)",
  "cpu.seriesP99": "99%のタスク(p99)",

  "hist.caption": "{time} の 1 区間",
  "hist.wait": "待ち時間",
  "hist.count": "件数",
  "hist.share": "割合",

  "heat.aria": "CPU実行待ち時間のヒートマップ。横軸が時刻、縦軸が待ち時間、色が回数",
  "heat.yCaption": "CPUを待った時間(上ほど長い)",
  "heat.count": "{n} 回",
  "heat.xAxis": "横軸",
  "heat.xDesc": "いつ発生したか",
  "heat.yAxis": "縦軸",
  "heat.color": "色",
  "heat.colorDesc": "その待ち時間が起きた回数({more})",
  "heat.brighter": "明るいほど多い",
  "heat.darker": "濃いほど多い",

  "mem.title": "メモリ回収による停止",
  "mem.desc": "メモリが足りないとき、プロセスが自分で空きを作る(回収する)ために止まった時間",
  "mem.tileStall": "回収で止まった時間",
  "mem.tileStallNote": "全プロセスの合計、直近5秒の中央値(eBPF)",
  "mem.tileUsed": "使用率",
  "mem.tileUsedNote": "全体 {total}(/proc/meminfo)",
  "mem.tileAvail": "空き",
  "mem.tileAvailNote": "MemAvailable(/proc/meminfo)",
  "mem.tilePsiNote": "答え合わせ用(/proc/pressure/memory)",
  "mem.distTitle": "1回あたりの停止時間の分布",
  "mem.distNote": "直近5分・1列 = 1秒。何も起きていなければ空",
  "mem.heatAria": "メモリ回収による停止時間のヒートマップ。横軸が時刻、縦軸が1回あたりの停止時間、色が回数",
  "mem.heatYCaption": "1回の回収で止まった時間(上ほど長い)",
  "mem.trendTitle": "止まった時間の推移(eBPF と PSI)",
  "mem.trendNote": "注意 {c} ms/秒・警告 {w} ms/秒(仮)。PSI は CPU ごとの稼働時間で重み付けした値なので、eBPF より小さく出る",
  "mem.procsTitle": "回収で止まったプロセス(直近5分)",
  "mem.colTotal": "止まった合計",
  "mem.colMax": "1回の最大",
  "mem.colReclaimed": "回収した量",
  "mem.colCause": "原因",
  "mem.causeMemcg": "cgroup の上限",
  "mem.causeHost": "ホスト全体の不足",
  "mem.causeBoth": "両方",
  "mem.seriesEbpf": "eBPF(プロセスが止まった時間)",
  "mem.seriesPsi": "PSI some(答え合わせ)",
  "mem.chartAria": "メモリ回収で止まった時間の推移。eBPF と PSI を並べたもの",

  "lp.desc": "プロセスが起動・終了・強制終了された記録(直近5分)。一瞬で終わるプロセスも1件ずつ拾います",
  "lp.tileExec": "起動",
  "lp.tileExecNote": "exec の回数",
  "lp.tileShort": "1秒未満で終了",
  "lp.tileShortNote": "数十秒ごとに値を取る監視では見えない",
  "lp.tileErr": "エラー終了",
  "lp.tileErrNote": "終了コードが0以外(判定には使わない)",
  "lp.tileCrash": "クラッシュ / OOM",
  "lp.tileCrashNote": "SIGSEGV などの異常終了と、メモリ不足による強制終了",
  "lp.notableTitle": "異常な終わり方をしたプロセス",
  "lp.crash": "クラッシュ",
  "lp.shortTitle": "1秒未満で終わったプロセス",
  "lp.shortNote": "cron やスクリプトから呼ばれる一瞬のコマンド。多すぎると CPU を細かく食う",
  "lp.colCommand": "コマンド",
  "lp.colMedian": "寿命(中央値)",
  "lp.colMin": "最短",
  "lp.logTitle": "最近の記録",
  "lp.onlyProblems": "異常のみ",
  "lp.logNote": "新しい順に {n} 件。コマンドライン引数は記録しない",
  "lp.dropped": "処理が追いつかず {n} 件のイベントを取りこぼしました",
  "lp.kind.exec": "起動",
  "lp.kind.exit": "終了",
  "lp.kind.oom": "OOM kill",
  "lp.lifetime": "寿命 {v}",
  "lp.coreDump": "(コアダンプ)",
  "lp.exitCode": "終了コード {n}",
  "lp.scopeMemcg": "cgroup の上限({mb} MB)",
  "lp.scopeHost": "ホスト全体({mb} MB)",
  "lp.oomDesc": "{scope}に達して強制終了 · 要求したのは {comm}(pid {pid})",
};

const DICTS: Record<Lang, Record<Key, string>> = { en, ja };

// Plain function for code outside React (sentence builders in lib/*.ts)
export function translate(lang: Lang, key: Key, params?: Params): string {
  const s = DICTS[lang][key];
  if (!params) return s;
  return s.replace(/\{(\w+)\}/g, (m, name: string) => (name in params ? String(params[name]) : m));
}

export type TFn = (key: Key, params?: Params) => string;

// Japanese uses ja-JP. English uses en-GB so times stay a compact 24-hour HH:MM:SS
const LOCALE: Record<Lang, string> = { en: "en-GB", ja: "ja-JP" };

export function formatTime(lang: Lang, t: Date | number | string, opts?: Intl.DateTimeFormatOptions): string {
  return new Date(t).toLocaleTimeString(LOCALE[lang], opts);
}

export const formatHM = (lang: Lang, t: Date | number | string) =>
  formatTime(lang, t, { hour: "2-digit", minute: "2-digit" });

export const formatHMS = (lang: Lang, t: Date | number | string) =>
  formatTime(lang, t, { hour: "2-digit", minute: "2-digit", second: "2-digit" });

// A saved choice wins; otherwise follow the browser. localStorage can throw (e.g. private mode)
function initialLang(): Lang {
  try {
    const saved = localStorage.getItem(STORAGE_KEY);
    if (saved === "en" || saved === "ja") return saved;
  } catch {
    // Fall through to browser detection
  }
  const nav = typeof navigator !== "undefined" ? navigator.language : "";
  return nav?.toLowerCase().startsWith("ja") ? "ja" : "en";
}

type I18n = { lang: Lang; setLang: (l: Lang) => void; t: TFn };

const I18nContext = createContext<I18n | null>(null);

export function I18nProvider({ children }: { children: ReactNode }) {
  const [lang, setLangState] = useState<Lang>(initialLang);

  const setLang = useCallback((l: Lang) => {
    setLangState(l);
    try {
      localStorage.setItem(STORAGE_KEY, l);
    } catch {
      // Cannot persist here; remember it only for this session
    }
  }, []);

  useEffect(() => {
    document.documentElement.lang = lang;
  }, [lang]);

  const value = useMemo<I18n>(
    () => ({ lang, setLang, t: (key, params) => translate(lang, key, params) }),
    [lang, setLang],
  );
  return <I18nContext.Provider value={value}>{children}</I18nContext.Provider>;
}

export function useI18n(): I18n {
  const ctx = useContext(I18nContext);
  if (!ctx) throw new Error("useI18n must be used inside <I18nProvider>");
  return ctx;
}
