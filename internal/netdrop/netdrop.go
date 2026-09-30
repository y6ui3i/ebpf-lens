// Package netdrop sorts the kernel's packet drop reasons (enum skb_drop_reason, reported by the kfree_skb
// tracepoint) into what they mean for an operator. The kernel names every drop; most names are housekeeping
// (a duplicate segment, a socket that closed with data still queued) and a few are trouble (a full accept queue,
// a firewall rule, no route, no memory). The agent and the server share this table so the same drop is judged
// the same way everywhere.
package netdrop

// Tiers. Trouble opens an incident; notable is shown with its addresses but does not; noise is only counted.
const (
	TierTrouble = "trouble"
	TierNotable = "notable"
	TierNoise   = "noise"
)

// trouble: something is refusing, full, missing or broken. Each of these has a person who can fix it.
var trouble = map[string]bool{
	// this host is refusing or cannot keep up
	"TCP_LISTEN_OVERFLOW": true, // the accept queue is full: the server is not calling accept() fast enough
	"SOCKET_RCVBUFF":      true, // the socket's receive buffer is full: the application is not reading
	"SOCKET_BACKLOG":      true, // the socket's backlog is full (the application holds the socket lock too long)
	"TCP_ZEROWINDOW":      true, // the receiver advertised a zero window and data still arrived
	"TCP_OFO_QUEUE_PRUNE": true, // out-of-order queue pruned: memory pressure on the socket
	"TCP_OFO_DROP":        true,
	"PROTO_MEM":           true, // the protocol's memory limit (tcp_mem)
	"NOMEM":               true,
	"PFMEMALLOC":          true,
	// policy
	"NETFILTER_DROP":    true, // a firewall rule (nftables / iptables) dropped it
	"BPF_CGROUP_EGRESS": true,
	"XDP":               true,
	"TC_INGRESS":        true,
	"TC_EGRESS":         true,
	"SECURITY_HOOK":     true,
	"XFRM_POLICY":       true, // IPsec policy
	"IP_RPFILTER":       true, // reverse path filter: the source address is not routed via the interface it came in on
	// path
	"IP_OUTNOROUTES":    true, // no route to the destination
	"IP_INNOROUTES":     true,
	"IP_INADDRERRORS":   true,
	"IPV6DISABLED":      true, // IPv6 is disabled on the interface but something keeps sending IPv6
	"NEIGH_CREATEFAIL":  true,
	"NEIGH_FAILED":      true, // ARP / ND did not resolve the next hop
	"NEIGH_QUEUEFULL":   true,
	"NEIGH_DEAD":        true,
	"NEIGH_HH_FILLFAIL": true,
	// queues and devices
	"QDISC_DROP":       true, // the qdisc dropped it (the interface is saturated)
	"QDISC_BURST_DROP": true,
	"QDISC_OVERLIMIT":  true,
	"QDISC_CONGESTED":  true,
	"CAKE_FLOOD":       true,
	"FQ_BAND_LIMIT":    true,
	"FQ_HORIZON_LIMIT": true,
	"FQ_FLOW_LIMIT":    true,
	"CPU_BACKLOG":      true, // the per-CPU input backlog (netdev_max_backlog) is full
	"FULL_RING":        true,
	"DEV_READY":        true,
	"DEV_HDR":          true,
	"NO_TX_TARGET":     true,
	// corruption
	"TCP_CSUM":           true,
	"UDP_CSUM":           true,
	"IP_CSUM":            true,
	"ICMP_CSUM":          true,
	"SKB_CSUM":           true,
	"IP_INHDR":           true,
	"PKT_TOO_BIG":        true,
	"FRAG_REASM_TIMEOUT": true,
	"FRAG_TOO_FAR":       true,
	"DUP_FRAG":           true,
}

// notable: worth a row with addresses (who sent what to where), but normal enough not to page anyone.
var notable = map[string]bool{
	"NO_SOCKET":               true, // a packet for a port nobody listens on (a scanner, a stale client, a late UDP answer)
	"TCP_RESET":               true, // the peer reset the connection
	"TCP_ABORT_ON_DATA":       true,
	"TCP_INVALID_SYN":         true,
	"TCP_FLAGS":               true,
	"OTHERHOST":               true, // a frame for another MAC address (promiscuous mode, a misdirected switch)
	"UNICAST_IN_L2_MULTICAST": true,
	"IP_LOCAL_SOURCE":         true,
	"IP_INVALID_SOURCE":       true,
	"IP_INVALID_DEST":         true,
	"IP_LOCALNET":             true,
	"IP_NOPROTO":              true,
	"INVALID_PROTO":           true,
	"UNHANDLED_PROTO":         true,
	"TCP_MINTTL":              true,
	"TCP_MD5NOTFOUND":         true, "TCP_MD5UNEXPECTED": true, "TCP_MD5FAILURE": true,
	"TCP_AONOTFOUND": true, "TCP_AOUNEXPECTED": true, "TCP_AOKEYNOTFOUND": true, "TCP_AOFAILURE": true, "TCP_AUTH_HDR": true,
	"IPV6_BAD_EXTHDR": true, "IPV6_NDISC_FRAG": true, "IPV6_NDISC_HOP_LIMIT": true, "IPV6_NDISC_BAD_CODE": true, "IPV6_NDISC_BAD_OPTIONS": true, "IPV6_NDISC_NS_OTHERHOST": true,
	"VXLAN_INVALID_HDR": true, "VXLAN_VNI_NOT_FOUND": true, "VXLAN_ENTRY_EXISTS": true, "MAC_INVALID_SOURCE": true,
	"TC_COOKIE_ERROR": true, "TC_CHAIN_NOTFOUND": true, "TC_RECLASSIFY_LOOP": true, "PACKET_SOCK_ERROR": true,
	"TAP_FILTER": true, "TAP_TXFILTER": true, "TUNNEL_TXINFO": true, "IP_TUNNEL_ECN": true, "LOCAL_MAC": true, "ARP_PVLAN_DISABLE": true,
	"BRIDGE_INGRESS_STP_STATE": true, "MAC_IEEE_MAC_CONTROL": true,
}

// Tier of a reason name (without the SKB_DROP_REASON_ prefix). Everything the tables do not list is noise:
// NOT_SPECIFIED, SOCKET_CLOSE, SOCKET_FILTER, the TCP_OLD_* / PAWS / OFOMERGE family (duplicates and stale
// segments, which every TCP connection produces), QUEUE_PURGE, UNIX_*, PKT_TOO_SMALL, HDR_TRUNC, the GSO ones...
func Tier(reason string) string {
	switch {
	case trouble[reason]:
		return TierTrouble
	case notable[reason]:
		return TierNotable
	}
	return TierNoise
}
