// Package probe は各 eBPF プローブで共有する小道具。
package probe

// CString は BPF 側の char 配列(NUL 終端)を文字列にする。
func CString(b []int8) string {
	s := make([]byte, 0, len(b))
	for _, c := range b {
		if c == 0 {
			break
		}
		s = append(s, byte(c))
	}
	return string(s)
}
