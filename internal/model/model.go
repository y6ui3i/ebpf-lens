// Package model はエージェント・サーバー・フロントで共有するデータ型。
// フロントの型は tygo で frontend/src/types/model.ts に生成する(make types)。
package model

import "time"

// Sample は 1 区間ぶんのヒストグラム。Slots[i] は [2^i, 2^(i+1)) の件数
// (slot 0 のみ [0, 2))。単位は Unit。
type Sample struct {
	Host       string     `json:"host"`
	Time       time.Time  `json:"time"`
	Probe      string     `json:"probe"`
	Unit       string     `json:"unit"`
	Slots      []uint64   `json:"slots"`
	IntervalMs int64      `json:"intervalMs"` // 集計区間の長さ
	CPUs       int        `json:"cpus"`       // CPU 使用率の分母に使う
	BusyNs     uint64     `json:"busyNs"`     // 全プロセスの CPU 使用時間の合計(eBPF で計測。idle は含まない)
	Procs      []ProcStat `json:"procs,omitempty"`
	Mem        *MemStat   `json:"mem,omitempty"` // memstall のみ
}

// MemStat は memstall のサンプルに付けるメモリの状況。
// StallNs が eBPF の計測値(主役)、使用量と PSI は /proc からの答え合わせ。
type MemStat struct {
	TotalBytes     uint64 `json:"totalBytes"`
	AvailableBytes uint64 `json:"availableBytes"`
	StallNs        uint64 `json:"stallNs"`   // 区間内に全プロセスが回収で止まった時間の合計(eBPF)
	PsiSomeUs      uint64 `json:"psiSomeUs"` // 区間内の PSI memory some の増分(1 つ以上のタスクが止まっていた時間)
	PsiFullUs      uint64 `json:"psiFullUs"` // 区間内の PSI memory full の増分(全タスクが止まっていた時間)
}

// ProcEvent はプロセスの起動・終了・OOM kill の 1 件。
type ProcEvent struct {
	Time time.Time `json:"time"`
	Kind string    `json:"kind"` // "exec" | "exit" | "oom"
	Pid  uint32    `json:"pid"`
	Ppid uint32    `json:"ppid"`
	UID  uint32    `json:"uid"`
	Comm string    `json:"comm"`
	// exec
	Filename string `json:"filename,omitempty"`
	// exit
	ExitStatus int    `json:"exitStatus"` // 正常終了時の終了コード
	Signal     int    `json:"signal"`     // シグナルで終了したときのシグナル番号(0 なら正常終了)
	CoreDump   bool   `json:"coreDump"`
	LifetimeNs uint64 `json:"lifetimeNs"`
	// oom(Pid/Comm は強制終了されたプロセス)
	TriggerPid  uint32 `json:"triggerPid,omitempty"`
	TriggerComm string `json:"triggerComm,omitempty"`
	TotalPages  uint64 `json:"totalPages,omitempty"`
	Memcg       bool   `json:"memcg"` // cgroup のメモリ上限による OOM
}

// EventBatch はエージェントが 1 区間ごとにまとめて送るイベント。
type EventBatch struct {
	Host    string      `json:"host"`
	Time    time.Time   `json:"time"`
	Events  []ProcEvent `json:"events"`
	Dropped uint64      `json:"dropped"` // 溢れて捨てた件数(カーネル側 + エージェント側)
}

// ProcStat は 1 区間ぶんのプロセス別集計。同じ名前のプロセスはまとめる。
// エージェントは待ち時間と CPU 使用の上位だけを送るので、全プロセスではない。
type ProcStat struct {
	Comm      string   `json:"comm"`
	Procs     int      `json:"procs"` // この名前のプロセス数
	Pids      []uint32 `json:"pids"`  // 先頭の数件
	OnCPUNs   uint64   `json:"onCpuNs"`
	WaitCount uint64   `json:"waitCount"`
	WaitNs    uint64   `json:"waitNs"`
	WaitMaxNs uint64   `json:"waitMaxNs"`
	Slots     []uint64 `json:"slots"` // 待ち時間の log2 ヒストグラム(µs)
	// memstall のみ。memstall では Wait* を「メモリ回収で止まった」の意味で使う
	ReclaimedPages uint64 `json:"reclaimedPages,omitempty"`
	MemcgCount     uint64 `json:"memcgCount,omitempty"` // うち cgroup の上限による回収の回数
}

// HostInfo はサーバーが把握しているホストの一覧に使う。
type HostInfo struct {
	Name     string    `json:"name"`
	LastSeen time.Time `json:"lastSeen"`
	Probes   []string  `json:"probes"`
}
