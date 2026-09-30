package netdrop

import "testing"

// Measured on the test host in 30 s of idle: TCP_OLD_SEQUENCE / TCP_OLD_DATA / OFOMERGE / SOCKET_CLOSE /
// NOT_SPECIFIED / QUEUE_PURGE are the everyday drops of healthy connections and must stay noise. A full accept
// queue and a firewall rule are trouble; a packet to a closed port is notable (shown, not paged).
func TestTiers(t *testing.T) {
	for _, r := range []string{"TCP_OLD_SEQUENCE", "TCP_OLD_DATA", "TCP_OFOMERGE", "SOCKET_CLOSE", "NOT_SPECIFIED", "QUEUE_PURGE", "TCP_RFC7323_PAWS", "UNIX_DISCONNECT", "never heard of it"} {
		if Tier(r) != TierNoise {
			t.Errorf("%s must be noise, got %s", r, Tier(r))
		}
	}
	for _, r := range []string{"TCP_LISTEN_OVERFLOW", "NETFILTER_DROP", "IP_OUTNOROUTES", "SOCKET_RCVBUFF", "NOMEM", "QDISC_DROP", "IPV6DISABLED"} {
		if Tier(r) != TierTrouble {
			t.Errorf("%s must be trouble, got %s", r, Tier(r))
		}
	}
	for _, r := range []string{"NO_SOCKET", "TCP_RESET", "OTHERHOST"} {
		if Tier(r) != TierNotable {
			t.Errorf("%s must be notable, got %s", r, Tier(r))
		}
	}
}
