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
	Procs      []ProcStat `json:"procs,omitempty"`
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
}

// HostInfo はサーバーが把握しているホストの一覧に使う。
type HostInfo struct {
	Name     string    `json:"name"`
	LastSeen time.Time `json:"lastSeen"`
	Probes   []string  `json:"probes"`
}
