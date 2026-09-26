// Package probe holds small helpers shared by the eBPF probes.
package probe

// CString converts a NUL-terminated char array from the BPF side into a string.
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
