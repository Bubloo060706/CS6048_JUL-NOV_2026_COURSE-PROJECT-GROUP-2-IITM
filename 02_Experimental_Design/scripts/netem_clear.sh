#!/usr/bin/env bash
# Removes only the netem root installed on a disposable veth by netem_apply.sh.
set -euo pipefail
IFACE="${1:-}"
if [[ $EUID -ne 0 ]]; then echo "Run with sudo: $0 VETH" >&2; exit 1; fi
if [[ -z "$IFACE" ]]; then echo "Usage: sudo $0 VETH" >&2; exit 2; fi
command -v tc >/dev/null || { echo 'tc not found; install iproute2.' >&2; exit 1; }
command -v ip >/dev/null || { echo 'ip not found; install iproute2.' >&2; exit 1; }
ip link show dev "$IFACE" >/dev/null 2>&1 || { echo "Interface not found: $IFACE" >&2; exit 1; }
DETAIL="$(ip -d link show dev "$IFACE")"
[[ "${DETAIL,,}" == *veth* ]] || { echo 'REFUSED: interface is not identified as a veth.' >&2; exit 1; }
QDISC="$(tc qdisc show dev "$IFACE")"
[[ "$QDISC" == *netem* ]] || { echo 'REFUSED: no netem root found; refusing to delete an unrelated qdisc.' >&2; exit 1; }
tc qdisc del dev "$IFACE" root
echo "Removed netem from disposable veth $IFACE; default noqueue should be restored. Verify: tc qdisc show dev $IFACE"
