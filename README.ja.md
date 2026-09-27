# eBPFLens

[English](README.md)

Zabbix 風の Linux ダッシュボードを eBPF で再発明する実験。

**設計思想: eBPF を知らない人でも「Linux で今何が起きているか」が分かること。**
ポーリングで取る平均値では見えないもの(レイテンシの分布、プロセス単位の原因と影響、プロセス起動や OOM などのイベント)を eBPF で拾い、生データではなく「監視者にとっての意味」に変換して見せる。画面の一番上には判定と文章の要約(Lens Summary)を出し、ヒートマップなどの詳細はその根拠として置く。

> 状態: 実験段階。1 台(Ubuntu 26.04、カーネル 7.0)で作って確かめている。認証はまだ無いので、信頼できるネットワークの中だけで動かすこと。

## 構成

```
[各ホスト]                    [サーバー]                    [ブラウザ]
ebpflens-agent (Go)  ──JSON──▶ ebpflens-server (Go)  ──SSE/API──▶ 画面 (React + TS)
 eBPF プローブ(+ /proc)        保存・API                      サーバーに埋め込んで配信
```

- **エージェント**: Go + [cilium/ebpf](https://github.com/cilium/ebpf)(CO-RE)。監視対象にはカーネル BTF だけあればよく、単一バイナリで配れる
  - `runqlat`: CPU 実行待ち時間のヒストグラムと、プロセス別の CPU 使用・待ち
  - `proclife`: exec / exit / OOM kill のイベント(ring buffer)。コマンドライン引数はパスワードを含みうるので**取らない**
  - `memstall`: メモリ回収(`mm_vmscan_direct_reclaim_*` / `mm_vmscan_memcg_reclaim_*`)で止まった時間をプロセス別に。答え合わせに /proc/meminfo と /proc/pressure/memory も読む
- **サーバー**: Go。画面用の直近の窓はメモリ(ホスト×プローブごとに直近 900 件、イベントはホストごとに直近 20000 件)、長く残す分は SQLite
- **画面**: React + Vite + TypeScript の SPA。TanStack Query、Tailwind、uPlot、ヒートマップは canvas に描く。型は tygo で Go から生成
- **概念**: Zabbix に倣ってホスト / アイテム / トリガー / イベント

## 設計判断

- [ADR 0001: 誰でも SRE — 当番の人が動けるように障害を説明する](docs/adr/0001-everyone-an-sre.md)(英語)
- [ADR 0002: エージェントは 1 バイナリ、収集部は OS ごとに分ける](docs/adr/0002-collectors-per-os.md)(英語)

## 画面設計の原則

- **ダッシュボード(`/`)は全資源の概要。** Lens Summary と USE メソッドの升目(資源 × 使用率 / 飽和 / エラー)で 1 画面に収め、縦に伸ばさない。プローブを足したら升目を埋める
- **領域ごとの画面は詳細。** プローブを足したら、メニューの「リソース」に画面を 1 つ足す(例: `/cpu`、`/processes`、`/memory`)
- **すべてのパネル(`/all`)は全部並べて見る場所。** 領域ごとの画面にあるパネルを縦に並べる。プローブを足したらここにも足す
- 生データより先に意味を出す。判定と文章の要約が先、グラフはその根拠

## ビルドと実行

Go のビルドは監視対象と同じ種類の Linux 上で行う(`vmlinux.h` を実行中カーネルの BTF から生成するため)。画面は Node のあるマシンでビルドし、`internal/webui/dist` に出したものをサーバーに埋め込む。

必要なもの: Go 1.25+、clang、llvm、libbpf-dev、bpftool(画面のビルドには Node)

```bash
make web      # 型生成 + 画面のビルド(Node のあるマシン)
make build    # エージェントとサーバー(Linux)

./bin/ebpflens-server -addr :8080 -db ./ebpflens.db
sudo ./bin/ebpflens-agent -server http://127.0.0.1:8080
```

エージェント単体でも動く。

```bash
sudo ./bin/ebpflens-agent            # 1 秒ごとに JSON Lines
sudo ./bin/ebpflens-agent -text      # runqlat 風のテキストヒストグラム
```

`slots[i]` は `[2^i, 2^(i+1))` マイクロ秒の件数(区間ごとの差分)。

画面の開発は `cd frontend && EBPFLENS_API=http://<server>:8080 npm run dev`。

## 常駐(systemd)

`deploy/systemd/` のユニットで常駐させる。

- **エージェントは root で動かさない。** 専用ユーザー `ebpflens` で動かし、`CAP_BPF` と `CAP_PERFMON` だけを渡す(tracepoint / fentry へのアタッチと ring buffer はこの 2 つで足りる)
- サーバーは特権なし。書き込めるのは状態ディレクトリだけ(`ProtectSystem=strict`)
- 開発中の `bin/` を直接動かさない。`make install` で `/opt/ebpflens/bin` に入れてから再起動する

初回だけ:

```bash
sudo useradd --system --no-create-home --shell /usr/sbin/nologin ebpflens
sudo usermod -aG ebpflens "$USER"            # sqlite3 で DB を読めるように
make install
sudo systemctl enable --now ebpflens-server ebpflens-agent
```

更新:

```bash
make install
sudo systemctl restart ebpflens-server ebpflens-agent
```

DB は `/var/lib/ebpflens/ebpflens.db`(systemd の `StateDirectory`)に置かれる。別の場所に置くなら drop-in を足す:

```ini
# /etc/systemd/system/ebpflens-server.service.d/10-local-db.conf
[Unit]
RequiresMountsFor=/mnt/data/ebpflens

[Service]
ExecStart=
ExecStart=/opt/ebpflens/bin/ebpflens-server -addr :8080 -db /mnt/data/ebpflens/ebpflens.db
ReadWritePaths=/mnt/data/ebpflens
```

## トリガーと通知

判定はブラウザではなくサーバー(`internal/trigger`)で行うので、誰も画面を見ていなくても出来事(incident)は記録される。ルールはすべて決定的で、出来事には判定の根拠になった数値が付く([ADR 0001](docs/adr/0001-everyone-an-sre.md))。

| 種類 | 開く条件 | レベル | 閉じる条件 |
|---|---|---|---|
| `cpu_wait` | 実行待ち p99 が 1 ms 以上で 3 秒続く | 注意。10 ms 以上が 3 秒続いたら警告 | 1 ms 未満が 2 秒を超えて続く |
| `mem_stall` | 回収の停止が 10 ms/秒以上で 3 秒続く | 注意。100 ms/秒以上が 3 秒続いたら警告 | 10 ms/秒未満が 2 秒を超えて続く |
| `oom_kill` | OOM kill のイベント | 警告 | 即時(引き金のプロセスと、cgroup かホスト全体かを記録) |
| `crash` | SIGSEGV / SIGABRT / SIGBUS / SIGFPE / SIGILL / SIGSYS かコアダンプ付きの終了 | 注意 | 即時 |
| `crash_loop` | 同じコマンドが 5 分に 3 回クラッシュ | 警告 | 最後のクラッシュから 5 分 |
| `agent_down` | ホストから 30 秒何も届かない | 警告 | ホストがまた報告してきたとき |

開いている間、レベルは下がらない(最大値が経過を語る)。出来事は SQLite の `incidents` 表に id で upsert され(`-incident-retention`、既定 30 日)、SSE の `event: incident` で流れ、`GET /api/incidents?host=` で一覧できる。サーバー停止時に開いたままだった出来事は、最後の更新時刻で閉じた状態に戻す。開いたままにしていた判定の状態は残っていないので、「継続中」のままにすると嘘になるため。

しきい値は既定値の上に重ねる JSON(`-print-triggers` で既定値を出力。変えたい値だけ書けばよい)。`GET /api/triggers` で配るので、画面のしきい値の帯はサーバーと同じ数値になる。

```bash
./bin/ebpflens-server -print-triggers > triggers.json   # 編集してから
./bin/ebpflens-server -db … -triggers triggers.json
```

`-webhook URL` で、開始・格上げ・終了(途中経過は送らない)を JSON で POST する。`-webhook-format slack` / `discord` なら、それぞれが受け付ける 1 行のテキストだけを送る。例:

```
[WARNING] hal: processes are competing for CPU (99% of tasks waited up to 16.3 ms, 3 s since 09:01:34)
[RESOLVED] hal: processes are competing for CPU (99% of tasks waited up to 16.3 ms, 21 s since 09:01:34)
[WARNING] hal: flaky-app is crashing repeatedly (3 times since 09:02:00)
[WARNING] hal: host stopped reporting (last sample at 09:02:09, silent for 30 s)
```

通知の文面は英語のみ(画面には日英の訳がある)。送信は非同期で 1 回だけ再試行し、webhook が死んでいても受信は止まらない。

## なぜこの VM は止まったのか

KVM ホストでは、エージェントが /proc から QEMU プロセスを見つけ(comm が `qemu-system-*`、名前は libvirt の `-name guest=…` か Proxmox の `-name …` から。libvirt には依存しない)、その CPU 待ちと回収の停止を `vm:<名前>` として集計し、イベントに VM 名を付け、動いている VM の一覧を毎秒送る(`probe=vms`)。VM の QEMU が終了すると、サーバーは手元の証拠から次の順で原因を決めて `vm_down` の出来事を作る。

| 証拠 | 原因 | レベル |
|---|---|---|
| 直前にその pid が OOM kill され、VM 自身の cgroup の中だった | `cgroup_oom`(メモリを要求したプロセス付き) | 警告 |
| 直前にその pid が OOM kill され、ホスト全体の不足だった | `host_oom`(引き金のプロセス付き) | 警告 |
| クラッシュのシグナルかコアダンプ付きの終了 | `crash` | 警告 |
| 直前にその pid へ終了シグナルが送られた、またはシグナルで終了 | `killed`(誰が送ったか付き) | 注意 |
| どれでもなく exit 0 | `shutdown` | 注意 |

出来事には、止まる前の 1 分間にその VM がどうだったか(メモリ回収で止まった時間と CPU 待ちの p99。どちらもプロセス別の eBPF の値)も付く(lab の cgroup OOM では回収で 1,188 ms 止まり、うち 929 ms は最後の 1 秒)。

検証で分かって、対応したことが 2 つある。

- **QEMU は SIGTERM を自分で処理して exit 0 で終わる。** 終了イベントだけでは誰かに殺されたと分からない。`signal_generate` の tracepoint で、SIGTERM / SIGKILL / SIGINT / SIGHUP / SIGQUIT を誰がどのプロセスに送ったかを記録する(実際にキューに入ったものだけ。自分自身へのシグナルは除く)。これで「exit 0」が「libvirtd(pid 2002)に止められた」になる。量はごくわずかで、検証機では 10 分に約 10 件(ほとんど udev がワーカーを片付けるもの)。
- **libvirt は QEMU を `-no-shutdown` で動かし、ゲストが止まった後に自分で SIGTERM を送る。** そのため `virsh shutdown` と `virsh destroy` はホストから見ると同じに見える。文面はそう書く(「管理された shutdown か virsh destroy」)。見分けるには libvirt 自身の停止理由が要り、それは後の段階。

検証機の lab VM で再現: `virsh destroy` → libvirtd の SIGTERM で killed、`virsh shutdown` → 上の理由で同じ、QEMU に `kill -SEGV` → crash、`virsh memtune --hard-limit 256M` とゲスト内の 700MB 確保 → `cgroup_oom`(カーネルの「Memory cgroup out of memory: Killed process … (qemu-system-x86)」と一致)。ホスト全体の OOM で VM を落とすのは検証機では安全にできないので、記録したイベントの形に対する単体テストで押さえている。

## VM の画面

メニューに **VM** のグループ(一覧と、VM ごとの項目。稼働中/停止の印と、新しい出来事があればレベルの印)を、**ホスト**(ホスト自身の資源)の上に置いた。

- **VM 一覧**(`/vms`): 直近 24 時間に見えた VM を 1 行ずつ。状態(いつから稼働 / いつ停止 · 原因)、ホストから見た CPU 待ち p99、CPU 占有率、回収停止(直近 5 秒)、直近の出来事。出来事が新しい VM が上。
- **VM のページ**(`/vms/<名前>`): ADR 0001 の形の **VM Lens Summary**。原因ごとの見出し、あるフィールドだけから組み立てた **根拠** の箇条書き(誰がシグナルを送ったか、OOM の引き金と cgroup かホストか、直前 1 分の回収停止と CPU 待ち p99)、理由付きの **次にすること**(「VM のメモリ上限を上げるか、ゲストのメモリを減らしてください。上限がそのままなので、再起動だけでは繰り返します」)。その下に、この VM の CPU 待ちのヒートマップと推移(ホスト側)、回収停止、この VM の出来事。
- ダッシュボードの升目に **VM** の行(稼働数、最も待たされている VM の CPU 待ち、24 時間の停止数)、Lens Summary に **VM** の行。VM の停止は見出しで CPU・メモリ・プロセスより優先される。

## 保存

`-db` を付けると SQLite に保存する(pure Go の modernc.org/sqlite。cgo 不要)。再起動しても履歴が戻る。

- 保持期間: サンプル 24 時間(`-retention`)、イベント 7 日(`-event-retention`)。10 分ごとに古い行を消す
- 書き込みはキューに積み、1 秒ごとに 1 トランザクションでまとめて書く。受信は止めない
- 目安: 検証機でサンプル 1 件あたり約 4KB(ホスト 1 台で 1 日約 350MB)、イベントは平常時 0.7 件/秒
- **DB ファイルはローカルディスクに置く。** SQLite は NFS 越しではロックが当てにならず、壊れうる

### 大きくなったら PostgreSQL

次のどれかを超えたら PostgreSQL に移し、さらに苦しくなったら TimescaleDB を足す(本家 Zabbix と同じ道筋)。

- 監視するホストが 10 台を超えた
- 秒単位のデータを 1 週間以上残したい
- ホストをまたいだ集計が要る

移行を安くするため、SQL は両方で動く書き方に限っている(時刻は Unix ミリ秒の整数、本体は JSON テキスト、`ON CONFLICT`)。保存処理は `internal/store` の `Persister` の後ろに閉じているので、差し替えはそこだけで済む。Prometheus 系はプロセスの起動・終了のようなイベントを持てず、プロセス別のヒストグラムで系列数も膨らむので選ばない。

## ロードマップ

方針: **GPU 以外は eBPF を主役にする。** /proc や PSI は答え合わせに使う。

1. ✅ runqlat を Go で動かし、ヒストグラムを JSON で出す
2. ✅ サーバー + 画面。CPU実行待ち時間のヒートマップ、しきい値の帯、Lens Summary、直近の出来事
3. ✅ 原因と影響: プロセス単位の CPU 待ち(誰が待たされたか)と CPU 占有(誰が使っていたか)
4. ✅ プロセスのライフサイクル: exec / exit(終了コード・シグナル・寿命)/ OOM kill。CPU 使用率も eBPF の計測値から出す
5. ✅ 画面構成: 概要ページ(Lens Summary + USE メソッドの升目)と、領域ごとの詳細ページ。レスポンシブなメニュー
6. ✅ メモリの詰まり: 回収(direct reclaim / memcg reclaim)で止まった時間をプロセス別に。PSI と使用率は /proc から答え合わせ
7. ✅ トリガーと通知: 判定をサーバー側で行い、出来事(incident)として記録・webhook で通知。材料はすべて eBPF 由来
8. ✅ VM 監視(「なぜ VM が止まったか」と VM の画面まで完了): ホストから KVM のゲストを見る。vCPU の CPU 待ち(原因付きの steal time)、QEMU のメモリ停止、VM が落ちた理由(ホストの OOM、QEMU のクラッシュ、KVM の tracepoint で見るゲストのパニック・シャットダウン)を、ゲスト内のエージェントと突き合わせる。VM は独立した画面群にする: メニューを **ホスト**(今の資源)と **VM**(一覧と、VM ごとのページ。それぞれに Lens Summary)に分ける。VM を動かしている人が知りたいのはサーバー全体ではなく「自分の VM」だから
9. GPU の基本メトリクス(NVML。例外的に eBPF ではない): 使用率・VRAM・温度・電力、プロセスごとの VRAM
10. GPU × eBPF: libcudart / libcuda への uprobe で、推論プロセスごとのカーネル起動・転送・同期待ちを測り、「GPU が遊んでいる理由」を出す
11. ディスクとネットワーク: biolatency / tcpconnect / tcpretrans
12. macOS エージェント: サーバー・画面・出来事の仕組みは同じまま、macOS が特別な権限なしに公開している範囲(CPU とロード、メモリ圧迫の段階、kqueue によるプロセスの起動・終了、libproc によるプロセス別 CPU)を流す。macOS には eBPF がないので、実行待ち時間の分布やプロセス別の回収停止は取れない。Mac は「できる範囲」であって本線ではない。収集部は OS ごとに分ける([ADR 0002](docs/adr/0002-collectors-per-os.md))。Windows は需要があれば(ETW になる)

## 判定のしきい値(仮)

CPU実行待ち時間の p99 で、注意 1ms / 警告 10ms。3 秒以上続いた超過を「出来事」にする(上の「トリガーと通知」を参照)。

検証機での実測(2026-09-26):

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

メモリ回収の停止(全プロセスの合計): 注意 10 ms/秒、警告 100 ms/秒。

## メモリ回収の停止と PSI の違い

eBPF の `memstall` は「プロセスが実際に回収で止まっていた時間」をスレッドごとに足したもの。PSI(`/proc/pressure/memory` の some)は、CPU ごとの停止時間をその CPU の稼働時間で重み付けして平均した「ホスト全体として失った生産時間」で、約 2 秒ごとにまとめて更新される。1 つのプロセスだけが止まり、ほかの CPU が動いているときは PSI のほうが小さく出る。

- 検証機(cgroup 上限 32MB の中で 4 つの dd が別々のファイルを読む): eBPF 約 11.5 ms/秒、PSI some 約 3〜5 ms/秒
- 検証用 VM(メモリ 1GB、2 vCPU)で VM 全体を使い切ったとき: 5 秒間で eBPF 127.8 ms、PSI some 134.7 ms とほぼ一致した。CPU が少なく、ほぼ全員が止まっていると重み付けで薄まらない。止まったのはメモリを確保していた python3 だけでなく、systemd-journal、rsyslogd、エージェント自身(最大 9 ms)にも及んだ。最後は OOM kill(`memcg=false`、VM 全体の 244,727 ページ)

## 検証用 VM

ホスト全体のメモリ不足(direct reclaim)や OOM は、コンテナ(cgroup)では起こせない。cgroup の上限に当たって起きるのは memcg reclaim だけで、direct reclaim はホスト全体の空きが下限を割ったときに起きる。ホストを汚さずに起こすため、libvirt / KVM の小さな VM を使う。

```bash
sh lab/create-vm.sh          # 作成して起動(既にあれば起動)。Ubuntu 26.04 クラウドイメージ、メモリ 1GB、スワップ無し
sh lab/create-vm.sh push     # bin/ebpflens-agent を VM にコピー
sh lab/create-vm.sh ssh      # VM に入る
virsh -c qemu:///system shutdown ebpflens-lab   # 止める(ディスクは残る)
```

`lab/fleet.sh up 10` でさらに 10 台(`ebpflens-fleet-01..10`、各 1GB / 2 vCPU。ベースイメージと鍵は共有)を起動できる。`ssh N cmd`、`ips`、`down`。

8 コアの検証機で 10 台: `virt-install` から 20 秒で 10 台ともエージェントに見えた。エージェントは RSS 23MB・CPU 0.3%、サンプルは毎秒 2.9KB。うち 3 台の中で `stress-ng --cpu 2` を回す(8 コアに 6 vCPU が張り付き、ホスト 71% busy)と、**何もしていない** VM のホスト側 CPU 待ち p99 が数十 µs から 0.5〜2.3 ms に上がった。ホストから VM ごとに見た steal time である。この回で分かったこと:

- **スワップがあると、cgroup のメモリ上限は VM を殺さず、遅くする。** `virsh memtune --hard-limit 256M` の VM が 700MB を触ると、上限に 4,846 回当たったのに OOM kill は起きなかった。QEMU をスワップに追い出す回収が毎回成功していたため。これは VM の回収停止として見える(`--swap-hard-limit` でスワップも抑えた後の `vm_down` には、直前 1 分の停止 2.9 秒が付いていた)。スワップのあるホストで上限により VM を落とすには、スワップも抑える。
- 3 台の VM が CPU を約 25% ずつ分け合っていると、ホストの原因の一文は原因を名指ししない(単一プロセスのルールは 30% を要求する)。被害側は正しく名指しされる。隣人の「グループ」を原因にするのは steal の帰属の段階で扱う。

VM のファイルは `LAB_DIR` を指定しなければ `/var/lib/libvirt/images/ebpflens-lab` に置かれる。VM のカーネルは 7.0.0-31、ホストは 7.0.0-34 で、ホストでビルドしたエージェントがそのまま動いた(CO-RE)。

## 検証機

- Ubuntu 26.04.1、カーネル 7.0.0-34-generic、8 コア、メモリ 30GB、RTX 2070

## 関連記事

- [平均値の裏を覗く — eBPFとは何か、Zabbixと比べて何が見えるのか](https://pocraft.net/2026/09/26/ebpf-intro-vs-zabbix/)

## ライセンス

[Apache License 2.0](LICENSE)。`internal/probe/*/*.bpf.c` の BPF プログラムは、カーネルの GPL 専用ヘルパーを使うために BSD/GPL のデュアルライセンス。
