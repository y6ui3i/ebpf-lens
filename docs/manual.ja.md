# eBPFLens 運用マニュアル

[English](manual.md)

読み手は当番の人です。能力はあるが、カーネルの専門家ではなく、いま忙しい人。eBPFLens に何が見えるのか、各画面が何を意味するのか、黄色や赤になったら何をすればよいのかを書きます。設計の背景は [ADR 0001](adr/0001-everyone-an-sre.md)、ビルドと配置は [README](../README.ja.md) にあります。

## 1. 5 分で分かる eBPFLens

eBPFLens は Linux ホストをカーネルの中から eBPF で見て、見えたものを平易な文に変えます。**何かおかしいか**、**何が**、**誰のせいで**、**誰が困っていて**、**何をすべきか**。平均値をポーリングするのではなく、スケジューラの切り替え・メモリ回収の停止・プロセスの起動と終了・OOM kill・終了シグナルをすべて数えるので、ポーリングの隙間で起きたことも拾えます。

ダッシュボード(`http://<server>:8080`)を開いて、上から読みます。

1. **Lens Summary** — レベルと見出しの 1 行(例: *警告 · CPUの取り合いが起きています*)、その下に領域ごとの 1 行: **CPU**、**メモリ**、**プロセス**、**VM**。
2. **直近の出来事** — 24 時間以内に起きたことを新しい順に。
3. **資源ごとの状態** — 資源 × *使用率 / 飽和 / エラー* の升目。どの升目も詳細画面へのリンクです。

見出しが緑なら、あなたの出番はありません。緑でなければ、見出しが領域を、その下の行が何が起きたか(分かれば理由も)を言っています。根拠は升目かメニューから詳細画面へ。

言語は上部バーの **EN / 日本語**。ホストは上部バーの選択(1 台のサーバーで複数ホストを見られます)。

## 2. 導入と配置

### 必要なもの

- **監視対象のホスト**: カーネル BTF のある Linux(`/sys/kernel/btf/vmlinux` がある。Ubuntu、Fedora、RHEL 9、Debian 12 以降は標準で入っています)。検証は Ubuntu 26.04 / カーネル 7.0。エージェントは静的な単一バイナリで、ホストに他に入れるものはありません。
- **ビルド機**(同じアーキテクチャの Linux): Go 1.25+、clang、llvm、libbpf-dev、bpftool。画面は Node 22 で一度ビルドしてサーバーのバイナリに埋め込むので、ブラウザ側に必要なものはありません。
- **サーバー**: 各ホストから TCP 1 ポート(既定 8080)で届く Linux。監視対象の 1 台を兼ねてもかまいません。SQLite 内蔵で、データベースのサービスは不要です。
- **ネットワーク**: エージェント → サーバー `:8080`(HTTP)、ブラウザ → サーバー `:8080`。認証はありません(7 章)。このポートは信頼できるネットワークの中に置くか、認証を足すリバースプロキシの後ろに置いてください。

### ビルド

```bash
git clone https://github.com/yoshiharu-ishii/ebpf-lens && cd ebpf-lens
make web      # Node のある機械で。TS の型を生成し、画面を internal/webui/dist にビルド
make build    # Linux で。このカーネルの BTF から vmlinux.h → BPF オブジェクト → bin/ebpflens-agent と bin/ebpflens-server
```

`bin/` に 2 つのバイナリができます。`ebpflens-agent` は監視したいホストすべてにコピー、サーバーは決めた場所へ。

### サーバーの配置(systemd)

サーバー機で、リポジトリの中から:

```bash
sudo useradd --system --no-create-home --shell /usr/sbin/nologin ebpflens
sudo usermod -aG ebpflens "$USER"            # 任意: sqlite3 で DB を読めるようにする
make install                                 # /opt/ebpflens/bin/* と /etc/systemd/system/ebpflens-{server,agent}.service
sudo systemctl enable --now ebpflens-server
```

ユニットはサーバーを特権なしの `ebpflens` ユーザーで動かし、`:8080` で待ち受け、DB は `/var/lib/ebpflens/ebpflens.db`(サンプル 24 時間、イベント 7 日、出来事 30 日)。DB を別のディスクに置くなら drop-in を足します。NFS には置かないでください。

```ini
# /etc/systemd/system/ebpflens-server.service.d/10-local-db.conf
[Unit]
RequiresMountsFor=/data/ebpflens
[Service]
ExecStart=
ExecStart=/opt/ebpflens/bin/ebpflens-server -addr :8080 -db /data/ebpflens/ebpflens.db
ReadWritePaths=/data/ebpflens
```

しきい値の変更や通知の追加は、同じ `ExecStart` にフラグを足します(`-triggers /etc/ebpflens/triggers.json`、`-webhook https://… -webhook-format slack`。8 章参照)。そのあと `sudo systemctl daemon-reload && sudo systemctl restart ebpflens-server`。

### 各ホストへのエージェント配置(systemd)

監視対象の各ホストで:

```bash
sudo useradd --system --no-create-home --shell /usr/sbin/nologin ebpflens
sudo install -d /opt/ebpflens/bin
sudo install -m 0755 ebpflens-agent /opt/ebpflens/bin/
sudo install -m 0644 deploy/systemd/ebpflens-agent.service /etc/systemd/system/
sudo systemctl daemon-reload
```

ユニットの `ExecStart` の `-server` を自分のサーバーに向け(`-server http://SERVER:8080`。同梱のユニットはサーバーが同じ機械にある前提です)、`sudo systemctl enable --now ebpflens-agent`。エージェントは `ebpflens` ユーザーで、`CAP_BPF` と `CAP_PERFMON` だけを持って動きます。root ではありません。ホストはダッシュボードのホスト選択にホスト名で現れます(`-host 名前` で上書き可)。1 台のサーバーで多数のホストを見られ、各ホストのエージェントは互いに独立です。報告が止まったホストは 30 秒で「エージェント停止」の出来事になります。

### 動作確認

```bash
systemctl status ebpflens-server ebpflens-agent
journalctl -u ebpflens-agent -n 20            # "load bpf objects" のエラーが出ていないこと
curl -s http://SERVER:8080/api/hosts          # 各ホストと最終サンプル時刻
```

`http://SERVER:8080` を開くと、数秒で Lens Summary が緑になり、CPU の行にマイクロ秒の待ち時間が出ます。ホストが出てこないときは、エージェントが動いていない、サーバーに届いていない、カーネルに BTF がない、のどれかです(エージェントのログに出ます)。

### 更新

新しいバイナリをビルドし、サーバーでは `make install && sudo systemctl restart ebpflens-server`、各ホストでは新しいエージェントを `/opt/ebpflens/bin/` にコピーして `sudo systemctl restart ebpflens-agent`。出来事と履歴はサーバーの再起動をまたいで残ります(開いていた出来事の扱いは 5 章)。

### 削除

`sudo systemctl disable --now ebpflens-agent`(サーバーは `ebpflens-server`)、`/opt/ebpflens`・ユニット・`/var/lib/ebpflens`(DB)・`ebpflens` ユーザーを削除。エージェントはホストに他に何も残しません。eBPF のプログラムは停止時に外れます。

## 3. ダッシュボードの読み方

### レベル

| 印 | レベル | 意味 |
|---|---|---|
| ● | 正常 | 平常の範囲内 |
| ▲ | 注意 | 見ておく価値がある。しきい値を数秒超えた、または異常だが致命的ではないことが起きた |
| ◆ | 警告 | 動く。しきい値をしばらく超えた、プロセスが殺された・クラッシュを繰り返している、ホストや VM が止まった |

全体のレベルは**最も悪い領域**です。見出しの優先順位は、報告が止まったホスト → VM → CPU → メモリ → プロセスの順。エージェントが沈黙していれば他の値は古く、VM の停止はプロセスのクラッシュより重いからです。

### 4 つの所見

- **CPU** — 「99%のタスクが 30 µs 以内にCPUを獲得しています(平常時 29 µs)。CPU使用率は 1% です。」最初の数字は直近 5 秒の実行待ち p99: *実行できる状態になった* タスクが CPU を得るまで待った時間です。「平常時」は表示範囲の落ち着いた秒の中央値。直近に取り合いがあれば、2 文目がいつ・何秒・最大を、3 文目が原因(「stress-ng-cpu(32プロセス)がCPU全体の93%を使っていました」)と被害側(「そのほかで待たされたのは steam(合計 437 ms、99%は 989 µs 以内)」)を言います。
- **メモリ** — いま回収で止まっているプロセスがあるか(メモリを要求したプロセスが、カーネルが空きを作る間止められる)、それに /proc からの使用率と空き。直近 5 分に止まったものがあれば、誰がどれだけかも。
- **プロセス** — 直近の OOM kill、クラッシュの繰り返し、クラッシュ。なければ起動数と、1 秒未満で終わった数。
- **VM** — 直近の VM の停止と原因、または稼働中の台数。

### 直近の出来事

1 行が 1 件: レベル、種類、プロセス/VM、時間帯(または *継続中*)、継続時間、種類ごとの詳細(最大待ち、ms/秒、シグナル、OOM の範囲と引き金、クラッシュ回数、誰がシグナルを送ったか)。継続中の出来事には終了時刻がありません。種類の一覧は 5 章に。

### 資源ごとの状態(USE)

Brendan Gregg の USE メソッドに倣い、資源ごとに 3 つの問いを立てます。

| 列 | 問い | 升目の例 |
|---|---|---|
| **使用率** | どれだけ使っているか | CPU %、メモリ %、プロセスの起動数、稼働中の VM 数 |
| **飽和** | 足りずに待たされているものがあるか | CPU 待ち p99、回収で止まった ms/秒、最も待たされている VM |
| **エラー** | 失敗や強制終了があったか | OOM kill、クラッシュ、VM の停止 |

升目には最新値、5 分のスパークライン、異常時だけレベルの印。「未実装(ロードマップ n)」はまだ作っていないものです。

## 4. 各画面

メニュー(☰)は 3 グループ: **eBPFLens**(ダッシュボード、すべてのパネル)、**VM**(VM 一覧、VM ごと)、**ホスト**(CPU実行待ち時間、プロセスの起動と終了、メモリ。ディスク・ネットワーク・GPU は準備中)。

### CPU実行待ち時間(`/cpu`)

*何か。* 実行できるタスクが CPU を得るまで待った時間。落ち着いた 8 コア機では p99 が数十 µs、4 倍の割り当て過多では 8〜16 ms。この待ちは CPU 使用率のグラフには出ません。70% のホストでも、同時に実行可能になるタスクの組み合わせ次第でミリ秒待たせます。

*見えるもの。*
- **待ち時間の分布** — ヒートマップ。横が時刻(直近 5 分、1 列 1 秒)、縦が待ち時間(対数、上ほど長い)、色が回数。取り合いは、明るい帯が 8 µs の行から 8 ms の行へ飛ぶ形で見えます。
- **待ち時間の推移** — p50 と p99 に、注意(1 ms)と警告(10 ms)の帯。p99 が帯の中にある間、CPU の取り合いが起きています。
- **原因と影響** — 直近の出来事(なければ直近 10 秒)について、CPU を*使っていた*側(ホスト全体に占める割合)と*待たされた*側(合計、回数、p99、最大)の 2 表。「原因」は単独でホストの 30% 以上を使うプロセス。25% ずつの隣人が 3 つの場合は被害側だけが出ます(既知の穴、7 章)。

*読み方。* 一番待たされているプロセスが、利用者が体感しているものです。大きく使って少ししか待たないのは占有者、少ししか使わず大きく待つのは被害者。EEVDF はよく眠るタスク(対話的なもの)を起床時に優遇するので、被害者の待ちは占有者より 1 桁小さいのが普通です。16 ms の嵐の中で、応答を待たせたくないデーモンの p99 が 1 ms、というのが「守られてはいるが無傷ではない」姿です。

### プロセスの起動と終了(`/processes`)

*何か。* ホスト上のすべての exec・exit・OOM kill・終了シグナルを、カーネルから。1 ミリ秒しか生きないプロセスも含みます。コマンドライン引数は意図的に**記録しません**(パスワードが入りうるため)。

*見えるもの。* 4 つの数字(起動、1 秒未満で終了、エラー終了、クラッシュ + OOM)、異常な終わり方の表、短命コマンドの上位(cron やスクリプトの雑音。fork 爆弾も)、「異常のみ」で絞れる生のイベントの記録。

*読み方。* **OOM kill** の行は範囲(ホスト全体か cgroup の上限か)と、*どのプロセスのメモリ要求が引き金だったか* を言います。引き金は被害者と別のことが多い。**クラッシュ**は SIGSEGV/SIGABRT/SIGBUS/SIGFPE/SIGILL/SIGSYS かコアダンプ付きの終了。SIGTERM/SIGKILL はクラッシュではなく、誰かが止めたということです。**シグナル**の行は、誰が誰に SIGTERM/SIGKILL/SIGINT/SIGHUP/SIGQUIT を送ったかです。

### メモリ(`/memory`)

*何か。* プロセスがメモリ回収で止まった時間。メモリを要求した瞬間に、カーネルが空きを作る間だけ待たされる、その時間です。eBPF でプロセスごとに数えます(ホスト全体の不足なら direct reclaim、cgroup の上限なら memcg reclaim)。使用率と PSI は /proc から、答え合わせのためだけに。

*見えるもの。* 数字(ms/秒、使用率、空き、PSI)、停止時間の分布のヒートマップ、eBPF の停止と PSI の推移、止まったプロセスと原因(cgroup の上限かホストの不足か)。

*読み方。* 使用率だけでは問題ではありません。止まっているかどうかが問題です。**cgroup の上限**で止まるプロセスは、自分の上限に当たったコンテナや VM で、直すのはその上限であってホストではない。ホスト全体の停止は、機械が足りないということ。1 つのプロセスだけが止まり他の CPU が動いていると、PSI は eBPF より小さく出ます。それは想定どおり(PSI は CPU 時間で重み付けする)で、目安は「*誰が* はプロセス別の数字、*機械全体* は PSI」です。

### VM(`/vms` と `/vms/<名前>`)

*何か。* ホストから見た KVM のゲスト。eBPFLens は QEMU プロセスを見分ける(libvirt と Proxmox の命名)ので、VM ごとの CPU 待ちと回収停止がその名前で集計され、VM の死はホスト側の証拠から説明されます。ゲストの中にエージェントは要りません。libvirt へのアクセスも要りません。

*VM 一覧。* 直近 24 時間に見えた VM が 1 行ずつ: 状態(いつから稼働 / いつ停止 · 原因)、ホスト側の CPU 待ち p99、ホスト CPU の占有率、回収停止、直近の出来事。新しい出来事のある VM が上に来ます。

*VM のページ。* **VM Lens Summary**:
- **原因ごとの見出し** — *cgroup のメモリ上限で強制終了されました*、*ホストの OOM killer に強制終了されました*、*QEMU がクラッシュしました*、*シグナルで停止しました*、*正常に終了しました*、または *稼働中*。
- **根拠** — ある事実だけ: 誰がシグナルを送ったか、どのメモリ要求が OOM の引き金で、上限は VM の cgroup かホストか、シグナルとコアダンプ、VM の最後の 1 分(回収停止、CPU 待ち p99)。
- **次にすること、理由付き** — 例: *VM のメモリ上限を上げるか、ゲストのメモリを減らしてください。上限がそのままなので、再起動だけでは繰り返します。*

その下に、この VM 自身の CPU 待ちのヒートマップと推移(ホスト側 — 分布付きの steal time です)、回収停止、この VM の出来事。

*読み方。* 稼働中の VM で、自分の CPU 占有率はほぼゼロなのに待ち p99 が 1 ms を超えているなら、**うるさい隣人の被害者**です。ホストの CPU 画面で誰が忙しいかを見ます。死ぬ前に回収で止まっていた VM は、上限にぶつかって身動きが取れなくなっていたということ。ホストにスワップがあると、上限は VM を殺さず、遅くします。

### すべてのパネル(`/all`)

上の画面のパネルを 1 ページに縦に並べ、ジャンプリンク付き。クリックよりスクロールしたいときに。

## 5. 出来事: 種類ごとの意味と対応

出来事は**サーバー側**で固定のルールにより決まります(しきい値は JSON、8 章)。開いている間、レベルは下がりません。最大値が経過を語ります。サーバー再起動時に開いていた出来事は、最後の更新時刻で閉じた扱いになります。止まっていた間のことを知っているふりはしません。

| 種類 | 開く条件 | レベル | 閉じる条件 | 意味と対応 |
|---|---|---|---|---|
| **CPUの取り合い**(`cpu_wait`) | 実行待ち p99 ≥ 1 ms が 3 秒 | 注意。10 ms 以上が 3 秒続けば警告 | 1 ms 未満が 2 秒を超えて続く | タスクが CPU を待っています。CPU 画面の*原因*の表が占有者を、*影響*の表が被害者を名指しします。占有者を絞るか移す。誰が食べているか分かる前に CPU を足さない。 |
| **メモリ回収による停止**(`mem_stall`) | 停止 ≥ 10 ms/秒が 3 秒 | 注意。100 ms/秒以上で警告 | 10 ms/秒未満が 2 秒を超えて続く | カーネルが空きを作る間、プロセスが固まっています。メモリ画面が誰かと、cgroup の上限(上限を直す)かホスト(空ける・足す)かを言います。 |
| **メモリ不足で強制終了**(`oom_kill`) | カーネルがプロセスを殺した | 警告 | 即時 | 根拠: 被害者、引き金のプロセス、ホストか cgroup か。引き金が被害者と違えば、見るべきは引き金です。 |
| **クラッシュ**(`crash`) | クラッシュのシグナルかコアダンプ付きの終了 | 注意 | 即時 | ソフトウェアの不具合。そのプロセスのログとコアダンプを。 |
| **クラッシュの繰り返し**(`crash_loop`) | 同じコマンドが 5 分に 3 回クラッシュ | 警告 | 最後のクラッシュから 5 分 | 何かが同じ失敗に向けて再起動し続けています。まず再起動のループを止め、それからクラッシュを直す。 |
| **エージェント停止**(`agent_down`) | 30 秒サンプルが来ない | 警告 | ホストがまた報告する | ホストか、ネットワークか、エージェントが落ちています。このホストの他の値はすべて古い。まずホストを見る。 |
| **VM 停止**(`vm_down`) | VM の QEMU プロセスが終了 | OOM・クラッシュは警告、killed・正常終了は注意 | 即時 | VM のページを開く。原因・根拠・次にすることがそこにあります。 |

`vm_down` の原因:

| 原因 | 根拠 | 次にすること(と理由) |
|---|---|---|
| `cgroup_oom` | VM 自身の cgroup の中での OOM kill と、引き金のプロセス | VM のメモリ上限を上げるかゲストのメモリを減らす。上限がそのままなので再起動だけでは繰り返す。 |
| `host_oom` | ホスト全体の OOM kill | ホストの割り当て過多。ホストのメモリを空けてから再起動しないと、また起きうる。 |
| `crash` | QEMU がクラッシュのシグナルかコアダンプで終了 | 再起動する。QEMU のクラッシュはゲストのせいではない。QEMU のログとコアダンプを確認。 |
| `killed` | QEMU に終了シグナルが送られた。誰が送ったか付き | 意図した操作でなければ再起動。送り主が *libvirtd* の場合、ゲストの shutdown と `virsh destroy` の両方がこれになる(7 章)。 |
| `shutdown` | シグナルなしの exit 0 | 正常終了。意図していなければ再起動。 |

## 6. 通知

`ebpflens-server -webhook URL` で、**遷移**(開始・格上げ・終了)ごとに 1 行を POST します。途中経過は送りません。`-webhook-format generic` は `{event, text, incident}`、`slack` は `{text}`、`discord` は `{content}`。文面は英語で、例:

```
[WARNING] hal: processes are competing for CPU (99% of tasks waited up to 16.3 ms, 3 s since 09:01:34)
[RESOLVED] hal: processes are competing for CPU (99% of tasks waited up to 16.3 ms, 21 s since 09:01:34)
[WARNING] hal: flaky-app is crashing repeatedly (3 times since 09:02:00)
[WARNING] hal: host stopped reporting (last sample at 09:02:09, silent for 30 s)
[WARNING] hal: VM web-02 stopped at 09:55:38: its cgroup memory limit was reached; triggered by libvirtd (pid 2002). In the minute before: 1188 ms stalled in memory reclaim, CPU wait p99 29 µs
```

送信は非同期で 1 回だけ再試行。webhook が死んでいてもエージェントは止まりません。

## 7. 見えないもの、限界

- **認証がありません。** サーバーに届く人は誰でも全部を読め、偽のサンプルを送れます。信頼できるネットワークの中だけで動かしてください。
- **ゲストの shutdown と `virsh destroy` はホストから同じに見えます。** libvirt は QEMU を `-no-shutdown` で動かし、どちらの場合も自分で SIGTERM を送り、QEMU は SIGTERM で exit 0 します。見分けるには libvirt 自身の停止理由が必要で、まだ読んでいません。
- **原因の名指しは単一プロセスが 30% 以上のときだけ。** 25% ずつの隣人 3 つは被害側としてしか出ません。
- **プロセス別の表は上位 N 件です。** エージェントは毎秒、待ち時間と CPU の上位 8 件(VM は常に)を送ります。長い範囲の合計は近似で、画面にもそう書いてあります。
- **ホスト全体の OOM による VM の停止**は、記録したイベントの形に対する単体テストでしか再現していません。
- **しきい値は仮です。** 8 コア 1 台の実測から決めました。自分のホストに合わせて調整してください(8 章)。
- **Linux 専用です。** macOS には eBPF がなく、できる範囲の macOS エージェントは計画のみ。
- **Windows は需要がなければ作りません。**
- **ダッシュボードはサンプル 5 分・出来事 24 時間を表示します。** DB はサンプル 24 時間・イベント 7 日・出来事 30 日を保持しますが、長期の履歴画面はまだありません。

## 8. 設定と API の早見表

サーバー:

| フラグ | 既定 | 意味 |
|---|---|---|
| `-addr` | `:8080` | 待ち受けアドレス |
| `-db` | (なし) | SQLite ファイル。空なら保存しない |
| `-keep` | 900 | ホスト×プローブごとにメモリに持つサンプル数(画面の窓) |
| `-keep-events` | 20000 | ホストごとにメモリに持つイベント数 |
| `-retention` / `-event-retention` / `-incident-retention` | 24h / 168h / 720h | DB の保持期間 |
| `-triggers` | (既定値) | 既定のしきい値の上に重ねる JSON。`-print-triggers` で既定値を出力 |
| `-webhook` / `-webhook-format` | (なし) / `generic` | 通知 |

エージェント: `-server URL`、`-host 名前`、`-interval 1s`、`-top 8`、`-text`(人が読む出力)、`-count N`。

しきい値のファイル(値は既定値):

```json
{
  "cpu":       {"caution": 1000, "warning": 10000, "minSeconds": 3, "maxGapSeconds": 2},
  "memory":    {"caution": 10,   "warning": 100,   "minSeconds": 3, "maxGapSeconds": 2},
  "processes": {"crashLoopCount": 3, "crashLoopWindowSeconds": 300},
  "agentDown": {"afterSeconds": 30}
}
```

API(断りがなければ `GET`): `/api/hosts`、`/api/samples?host=&probe=runqlat|memstall|vms`、`/api/events?host=`、`/api/incidents?host=`(新しい順。継続中は `end` なし)、`/api/triggers`、`/api/stream?host=`(SSE: `sample`、`events`、`incident`)。エージェントは `POST /api/ingest` と `/api/events`。

## 9. 用語集

- **実行待ち時間(run-queue latency、CPU 待ち)** — タスクが実行可能になってから実際に CPU で動くまでの時間。CPU の飽和の信号。
- **p50 / p99** — 測定値の半分 / 99% がその下に収まる値。p99 は運の悪いリクエストが見る値。
- **回収停止(reclaim stall)** — カーネルが代わりにメモリを空ける間、プロセスが止められること(direct reclaim / cgroup reclaim)。
- **PSI** — カーネルの Pressure Stall Information(`/proc/pressure/*`)。機械全体で失った生産時間。1 プロセスだけが止まるとプロセス別の値より小さく出る。
- **OOM kill** — メモリ不足でカーネルがプロセスを殺すこと。ホスト全体でも cgroup の中でも起きる。
- **cgroup** — カーネルの資源制限の単位。コンテナも VM もそれぞれ 1 つの中にいる。
- **steal** — VM が使いたかったのにホストが他に渡した CPU 時間。eBPFLens では VM のホスト側の実行待ちとして見える。
- **出来事(incident)** — ルールが「おかしい」と判定した 1 件。根拠・開始・終了・レベルを持つ。
