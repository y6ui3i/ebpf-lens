// Package fileerr sorts failed file opens (errno + path) into what they mean for an operator. The agent and the
// server share this table so the same failure is judged the same way everywhere.
//
// Most failed opens are a program looking for something optional: a locale file, a library in the next directory
// of a search path, a Python module under each sys.path entry, a /proc entry of a process that just exited. Those
// are ENOENT and they are the everyday background (about forty a second on the idle test host). A few errnos
// mean the file is there and the program cannot have it, or the system cannot give it: those are trouble.
package fileerr

import "strings"

// Tiers. Trouble opens an incident; notable is shown with its path but does not; noise is only counted.
const (
	TierTrouble = "trouble"
	TierNotable = "notable"
	TierNoise   = "noise"
)

// Names of the errnos an open can return (asm-generic/errno-base.h, errno.h).
var names = map[uint32]string{
	1: "EPERM", 2: "ENOENT", 3: "ESRCH", 4: "EINTR", 5: "EIO", 6: "ENXIO", 9: "EBADF", 11: "EAGAIN", 12: "ENOMEM",
	13: "EACCES", 14: "EFAULT", 16: "EBUSY", 17: "EEXIST", 18: "EXDEV", 19: "ENODEV", 20: "ENOTDIR", 21: "EISDIR",
	22: "EINVAL", 23: "ENFILE", 24: "EMFILE", 26: "ETXTBSY", 27: "EFBIG", 28: "ENOSPC", 30: "EROFS", 36: "ENAMETOOLONG",
	40: "ELOOP", 75: "EOVERFLOW", 95: "EOPNOTSUPP", 116: "ESTALE", 122: "EDQUOT",
}

// Name of an errno: "EACCES", or "E13"-style when unknown.
func Name(errno uint32) string {
	if n, ok := names[errno]; ok {
		return n
	}
	return "E" + itoa(errno)
}

func itoa(n uint32) string {
	if n == 0 {
		return "0"
	}
	var b [10]byte
	i := len(b)
	for n > 0 {
		i--
		b[i] = byte('0' + n%10)
		n /= 10
	}
	return string(b[i:])
}

// trouble: the file exists (or the system should have room for it) and the program cannot have it.
var trouble = map[string]bool{
	"EACCES":  true, // permission denied: the service user may not read it
	"EPERM":   true, // operation not permitted (capabilities, immutable file, AppArmor)
	"EROFS":   true, // read-only file system: a disk that remounted itself read-only after errors, or a wrong mount
	"ENOSPC":  true, // no space left
	"EDQUOT":  true, // quota exceeded
	"EMFILE":  true, // this process has too many open files (ulimit -n): a leak
	"ENFILE":  true, // the whole system has too many open files (fs.file-max)
	"EIO":     true, // I/O error: the disk
	"ENOMEM":  true,
	"ETXTBSY": true, // writing a binary that is running
	"ESTALE":  true, // NFS handle went stale
}

// Pseudo file systems are probed, not configured: a failure under them is a program looking at a process or a
// device that is not there any more (or that it may not look at), not a file someone forgot
var pseudo = []string{"/proc/", "/sys/", "/dev/"}

// Tier of one failed open. ENOENT is notable: shown with its path so "nginx cannot find /etc/ssl/certs/x.pem"
// is on the screen, but never an incident — programs look for optional files all day long. Failures under
// /proc, /sys and /dev are noise whatever the errno (lsof probing every process's fd table gets EACCES by the
// hundred). EEXIST (O_CREAT|O_EXCL on an existing file), ENXIO (open() on a socket file), ENOTDIR, EISDIR, ELOOP
// and the like are noise too.
func Tier(errname, path string) string {
	for _, p := range pseudo {
		if strings.HasPrefix(path, p) {
			return TierNoise
		}
	}
	switch {
	case trouble[errname]:
		return TierTrouble
	case errname == "ENOENT":
		return TierNotable
	}
	return TierNoise
}
