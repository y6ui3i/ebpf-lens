# eBPFLens

Zabbix 風の Linux ダッシュボードを eBPF で再発明する実験。

ポーリングで取る平均値では見えないもの(レイテンシの分布、プロセス単位の接続・再送、プロセス起動や OOM などのイベント)を、eBPF で拾ってブラウザに出す。

## 構成(予定)

```
[各ホスト]                    [サーバー]                    [ブラウザ]
ebpflens-agent (Go)  ──JSON──▶ ebpflens-server (Go)  ──SSE/API──▶ フロント (React + TS)
 eBPF + /proc 収集             保存・トリガー・API
```

- **エージェント**: Go + [cilium/ebpf](https://github.com/cilium/ebpf)(CO-RE)。監視対象にはカーネル BTF だけあればよく、単一バイナリで配れる
  - eBPF プローブ: runqlat / biolatency / tcpconnect / tcpretrans / execsnoop / oomkill
  - /proc 系メトリクス(CPU・メモリ・ディスク・ネットワーク)
- **サーバー**: Go。保存(SQLite)、トリガー、API、SSE
- **フロント**: React + Vite + TypeScript の SPA。TanStack Query / Table、shadcn/ui、uPlot、ヒートマップは canvas 自前描画。型は tygo で Go から生成
- **概念**: Zabbix に倣ってホスト / アイテム / トリガー / イベント

## ロードマップ

1. ✅ runqlat を Go で動かし、ヒストグラムを JSON で出す
2. サーバー + フロントで SSE ヒートマップ表示
3. /proc メトリクスと execsnoop / oomkill のイベントログ
4. トリガーと通知

## ビルドと実行

ビルドは監視対象と同じ Linux 上で行う(`vmlinux.h` を実行中カーネルの BTF から生成するため)。

必要なもの: Go 1.25+、clang、llvm、libbpf-dev、bpftool

```bash
make
sudo ./bin/ebpflens-agent            # 1 秒ごとに JSON Lines
sudo ./bin/ebpflens-agent -text      # runqlat 風のテキストヒストグラム
```

出力の `slots[i]` は `[2^i, 2^(i+1))` マイクロ秒の件数(区間ごとの差分)。

## 実験環境

- hal: Ubuntu 26.04.1、カーネル 7.0.0-34-generic、8 コア
