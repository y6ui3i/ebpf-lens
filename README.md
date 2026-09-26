# eBPFLens

Zabbix 風の Linux ダッシュボードを eBPF で再発明する実験。

**設計思想: eBPF を知らない人でも「Linux で今何が起きているか」が分かること。**
ポーリングで取る平均値では見えないもの(レイテンシの分布、プロセス単位の原因と影響、プロセス起動や OOM などのイベント)を eBPF で拾い、生データではなく「監視者にとっての意味」に変換して見せる。画面の一番上には判定と文章の要約(Lens Summary)を出し、ヒートマップなどの詳細はその根拠として置く。

## 構成

```
[各ホスト]                    [サーバー]                    [ブラウザ]
ebpflens-agent (Go)  ──JSON──▶ ebpflens-server (Go)  ──SSE/API──▶ フロント (React + TS)
 eBPF + /proc 収集             保存・トリガー・API             サーバーに埋め込んで配信
```

- **エージェント**: Go + [cilium/ebpf](https://github.com/cilium/ebpf)(CO-RE)。監視対象にはカーネル BTF だけあればよく、単一バイナリで配れる
  - `runqlat`: CPU 実行待ち時間のヒストグラムと、プロセス別の CPU 使用・待ち
  - `proclife`: exec / exit / OOM kill のイベント(ring buffer)。コマンドライン引数はパスワードを含みうるので取らない
- **サーバー**: Go。画面用の直近の窓はメモリ(ホスト×プローブごとに直近 900 件、イベントはホストごとに直近 20000 件)、長く残す分は SQLite。トリガーは後で足す
- **フロント**: React + Vite + TypeScript の SPA。TanStack Query、Tailwind、uPlot、ヒートマップは canvas 自前描画。型は tygo で Go から生成
- **概念**: Zabbix に倣ってホスト / アイテム / トリガー / イベント

## 画面設計の原則

- **ダッシュボード(`/`)は全資源の概要。** Lens Summary と USE メソッドの升目(資源 × 使用率 / 飽和 / エラー)で 1 画面に収め、縦に伸ばさない。プローブを足したら升目を埋める
- **領域ごとの画面は詳細。** プローブを足したら、メニューの「リソース」に画面を 1 つ足す(例: `/cpu`、`/processes`)
- **すべてのパネル(`/all`)は全部並べて見る場所。** 領域ごとの画面にあるパネルを縦に並べる。プローブを足したらここにも足す
- 生データより先に意味を出す。判定と文章の要約が先、グラフはその根拠

## 常駐(systemd)

`deploy/systemd/` のユニットで常駐させる。hal では画面が http://hal:8080 、検証用の起動は 8001 を使う。

- **エージェントは root で動かさない。** 専用ユーザー `ebpflens` で動かし、`CAP_BPF` と `CAP_PERFMON` だけを渡す(tracepoint / fentry へのアタッチと ring buffer はこの 2 つで足りる)
- サーバーは特権なし。書き込めるのは DB のディレクトリだけ(`ProtectSystem=strict`)
- 開発中の `bin/` を直接動かさない。`make install` で `/opt/ebpflens/bin` に入れてから再起動する

初回だけ:

```bash
sudo useradd --system --no-create-home --shell /usr/sbin/nologin ebpflens
sudo usermod -aG ebpflens "$USER"            # sqlite3 で DB を読めるように
sudo install -d -o ebpflens -g ebpflens -m 2775 /mnt/data/ebpflens
make install
sudo systemctl enable --now ebpflens-server ebpflens-agent
```

更新:

```bash
make install
sudo systemctl restart ebpflens-server ebpflens-agent
```

## 保存

`-db` を付けると SQLite に保存する(pure Go の modernc.org/sqlite。cgo 不要)。再起動しても画面の履歴が戻る。

```bash
./bin/ebpflens-server -addr :8080 -db /mnt/data/ebpflens/ebpflens.db   # hal での置き場所
```

- 保持期間: サンプル 24 時間(`-retention`)、イベント 7 日(`-event-retention`)。10 分ごとに古い行を消す
- 書き込みはキューに積み、1 秒ごとに 1 トランザクションでまとめて書く。受信は止めない
- 目安: hal 1 台でサンプル 1 件あたり約 4KB(1 日約 350MB)、イベントは平常時 0.7 件/秒
- **DB ファイルは監視対象のローカルディスクに置く。** hal の `/mnt/data` は LAN に NFS で公開しているが、SQLite は NFS 越しではロックが当てにならず壊れうるので、Mac から NFS 経由で開かない

### 大きくなったら PostgreSQL

次のどれかを超えたら PostgreSQL に移し、さらに苦しくなったら TimescaleDB を足す(本家 Zabbix と同じ道筋)。

- 監視するホストが 10 台を超えた
- 秒単位のデータを 1 週間以上残したい
- ホストをまたいだ集計が要る

移行を安くするため、SQL は両方で動く書き方に限っている(時刻は Unix ミリ秒の整数、本体は JSON テキスト、`ON CONFLICT`)。保存処理は `internal/store` の `Persister` の後ろに閉じているので、差し替えはそこだけで済む。Prometheus 系はプロセスの起動・終了のようなイベントを持てず、プロセス別のヒストグラムで系列数も膨らむので選ばない。

## ロードマップ

方針: **GPU 以外は eBPF を主役にする。** /proc や PSI は答え合わせに使う。

1. ✅ runqlat を Go で動かし、ヒストグラムを JSON で出す
2. ✅ サーバー + フロント。CPU実行待ち時間のヒートマップ、しきい値の帯、Lens Summary、直近の出来事
3. ✅ 原因と影響: プロセス単位の CPU 待ち(誰が待たされたか)と CPU 占有(誰が使っていたか)
4. ✅ プロセスのライフサイクル: exec / exit(終了コード・シグナル・寿命)/ OOM kill。CPU 使用率も eBPF の計測値から出す
5. ✅ 画面構成: 概要ページ(Lens Summary + USE メソッドの升目)と、領域ごとの詳細ページ。レスポンシブなメニュー
6. メモリの詰まり: direct reclaim で止まった時間をプロセス別に(PSI で答え合わせ)
7. トリガーと通知: 判定をサーバー側へ移す。材料はすべて eBPF 由来
8. GPU の基本メトリクス(NVML、例外的に eBPF ではない): 使用率・VRAM・温度・電力、プロセスごとの VRAM
9. GPU × eBPF: libcudart / libcuda への uprobe で、推論プロセスごとのカーネル起動・転送・同期待ちを測り、「GPU が遊んでいる理由」を出す
10. ディスクとネットワーク: biolatency / tcpconnect / tcpretrans

## ビルドと実行

Go のビルドは監視対象と同じ Linux 上で行う(`vmlinux.h` を実行中カーネルの BTF から生成するため)。フロントは Node のあるマシンでビルドし、`internal/webui/dist` に出したものをサーバーに埋め込む。

必要なもの: Go 1.25+、clang、llvm、libbpf-dev、bpftool(フロントのビルドには Node)

```bash
make web      # 型生成 + フロントのビルド(Node のあるマシン)
make build    # エージェントとサーバー(Linux)

./bin/ebpflens-server -addr :8080
sudo ./bin/ebpflens-agent -server http://127.0.0.1:8080
```

エージェント単体でも動く。

```bash
sudo ./bin/ebpflens-agent            # 1 秒ごとに JSON Lines
sudo ./bin/ebpflens-agent -text      # runqlat 風のテキストヒストグラム
```

`slots[i]` は `[2^i, 2^(i+1))` マイクロ秒の件数(区間ごとの差分)。

フロントの開発は `cd frontend && EBPFLENS_API=http://<server>:8080 npm run dev`。

## 判定のしきい値(仮)

CPU実行待ち時間の p99 で、注意 1ms / 警告 10ms。直近 5 秒の p99 の中央値で判定し、3 秒以上続いた超過を「出来事」にする。

hal での実測(2026-09-26):

| 状態 | 1 秒 p99 の中央値 | 1 秒 p99 の最大 |
|---|---|---|
| 平常時 | 29 µs | 167 µs |
| Demucs(PyTorch GPU 推論、GPU 平均 76%) | 27 µs | 476 µs |
| stress-ng 4 倍過負荷 | 16 ms | 30 ms |

GPU 推論は CPU の取り合いをほとんど起こさない。学習(DataLoader のワーカーで CPU を埋める構成)は未計測。

プロセス別(stress-ng 4 倍過負荷中、1ms ごとに起きる victim-app を同居させた場合):

| プロセス | 平常時 p99 | 過負荷時 p99 | CPU 使用 |
|---|---|---|---|
| stress-ng-cpu ×32 | – | 16 ms | 99.5% |
| victim-app | 16 µs | 1.0 ms | 0.1% |

すぐ寝るタスクは EEVDF が起床時に優遇するので、巻き込まれた側の待ちは占有している側より 1 桁以上小さい。

## 実験環境

- hal: Ubuntu 26.04.1、カーネル 7.0.0-34-generic、8 コア、RTX 2070
