// Package model はエージェント・サーバー・フロントで共有するデータ型。
// フロントの型は tygo で frontend/src/types/model.ts に生成する(make types)。
package model

import "time"

// Sample は 1 区間ぶんのヒストグラム。Slots[i] は [2^i, 2^(i+1)) の件数
// (slot 0 のみ [0, 2))。単位は Unit。
type Sample struct {
	Host  string    `json:"host"`
	Time  time.Time `json:"time"`
	Probe string    `json:"probe"`
	Unit  string    `json:"unit"`
	Slots []uint64  `json:"slots"`
}

// HostInfo はサーバーが把握しているホストの一覧に使う。
type HostInfo struct {
	Name     string    `json:"name"`
	LastSeen time.Time `json:"lastSeen"`
	Probes   []string  `json:"probes"`
}
