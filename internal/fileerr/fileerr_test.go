package fileerr

import "testing"

// Measured on the test host in 25 s of idle: python3 / sh / lsof probing paths with ENOENT by the hundred, lsof
// reading other users' /proc/<pid>/fd with EACCES 900 times. Those stay off the incident path; a service user
// denied its certificate, or a disk gone read-only, is trouble.
func TestTiers(t *testing.T) {
	cases := []struct{ err, path, want string }{
		{"ENOENT", "/usr/lib/python3/dist-packages/foo.so", TierNotable},
		{"ENOENT", "/etc/ssl/certs/server.pem", TierNotable},
		{"ENOENT", "/proc/12345/status", TierNoise},
		{"EACCES", "/proc/1/fd", TierNoise},
		{"EACCES", "/etc/ssl/private/server.key", TierTrouble},
		{"EPERM", "/var/lib/app/state", TierTrouble},
		{"EROFS", "/var/log/app.log", TierTrouble},
		{"EMFILE", "/tmp/x", TierTrouble},
		{"ENOSPC", "/var/lib/db/wal", TierTrouble},
		{"EEXIST", "/tmp/lock", TierNoise},
		{"ENXIO", "/run/user/1000/bus", TierNoise},
		{"ENOTDIR", "/etc/foo/bar", TierNoise},
	}
	for _, c := range cases {
		if got := Tier(c.err, c.path); got != c.want {
			t.Errorf("Tier(%s, %s) = %s, want %s", c.err, c.path, got, c.want)
		}
	}
	if Name(13) != "EACCES" || Name(2) != "ENOENT" || Name(200) != "E200" {
		t.Errorf("names: %s %s %s", Name(13), Name(2), Name(200))
	}
}
