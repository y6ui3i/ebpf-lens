# eBPFLens

Zabbix 風の Linux ダッシュボードを eBPF で再発明する実験。

ポーリングで取る平均値では見えないもの(レイテンシの分布、プロセス単位の接続・再送、プロセス起動や OOM などのイベント)を、eBPF で拾ってブラウザに出す。

## 構成(予定)

- **エージェント**: Go + [cilium/ebpf](https://github.com/cilium/ebpf)(CO-RE)の単一バイナリ
  - /proc 系メトリクス(CPU・メモリ・ディスク・ネットワーク)
  - eBPF プローブ: runqlat / biolatency / tcpconnect / tcpretrans / execsnoop / oomkill
- **保存**: SQLite
- **画面**: エージェントが HTTP で配信、SSE でライブ更新、uPlot とヒートマップ
- **概念**: Zabbix に倣ってホスト / アイテム / トリガー / イベント

## ロードマップ

1. runqlat を Go で動かし、ヒストグラムを JSON で出す
2. HTTP + SSE でヒートマップ表示
3. /proc メトリクスと execsnoop / oomkill のイベントログ
4. トリガーと通知

## 実験環境

- hal (Ubuntu 26.04)
