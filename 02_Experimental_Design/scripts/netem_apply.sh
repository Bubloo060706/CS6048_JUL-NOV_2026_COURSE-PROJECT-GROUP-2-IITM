#!/usr/bin/env bash
# SAFETY-FIRST helper: only applies to a disposable veth with a default noqueue root.
# It intentionally refuses physical/Wi-Fi/SSH interfaces and existing qdisc trees.
set -euo pipefail

IFACE="${1:-}"
RATE="${2:-}"
DELAY="${3:-0ms}"
JITTER="${4:-0ms}"
LOSS="${5:-0%}"

if [[ $EUID -ne 0 ]]; then echo "Run with sudo: $0 VETH RATE DELAY JITTER LOSS" >&2; exit 1; fi
if [[ -z "$IFACE" || -z "$RATE" ]]; then echo "Usage: sudo $0 VETH RATE DELAY JITTER LOSS" >&2; exit 2; fi
command -v tc >/dev/null || { echo 'tc not found; install iproute2.' >&2; exit 1; }
command -v ip >/dev/null || { echo 'ip not found; install iproute2.' >&2; exit 1; }
ip link show dev "$IFACE" >/dev/null 2>&1 || { echo "Interface not found: $IFACE" >&2; exit 1; }
DETAIL="$(ip -d link show dev "$IFACE")"
[[ "${DETAIL,,}" == *veth* ]] || { echo 'REFUSED: interface is not identified as a veth.' >&2; exit 1; }
QDISC="$(tc qdisc show dev "$IFACE")"
[[ "$QDISC" == *noqueue* && "$QDISC" != *mq* && "$QDISC" != *fq_codel* ]] || {
  echo 'REFUSED: root qdisc is not default noqueue. Existing qdisc trees cannot be safely restored.' >&2
  echo "$QDISC" >&2
  exit 1
}
tc qdisc add dev "$IFACE" root handle 1: netem rate "$RATE" delay "$DELAY" "$JITTER" loss "$LOSS"
echo "Applied netem to disposable veth $IFACE. Verify with: tc -s qdisc show dev $IFACE"
echo "Cleanup: sudo ./scripts/netem_clear.sh $IFACE"
