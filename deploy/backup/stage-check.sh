#!/usr/bin/env bash
# Staging checks for backup.sh, kept in a file of their own so they can be tested without a particular host.
# Test seams: where the swap table and sysfs are read from. They are honored ONLY when a file named .test-seams sits next
# to this script (a test copies the directory and adds it; a release never ships it). Otherwise the kernel's paths are used,
# whatever the environment says.
SWAPS=/proc/swaps
SYSFS=/sys
if [ -f "$(dirname "${BASH_SOURCE[0]}")/.test-seams" ]; then
  SWAPS=${OPENPASSWORD_BACKUP_SWAPS_FILE:-$SWAPS}
  SYSFS=${OPENPASSWORD_BACKUP_SYSFS:-$SYSFS}
fi
# True when every swap device is encrypted (dm-crypt) or compressed RAM (zram with no writeback device), or when there is
# no swap. A zram device with a backing (writeback) device can write pages raw to that disk, so it is refused.
swap_safe() {
  local dev _kind real name uuid back
  [ -r "$SWAPS" ] || return 1
  while read -r dev _kind _; do
    [ -n "$dev" ] && [ "$dev" != Filename ] || continue
    case "$dev" in
      /dev/zram*)
        name=${dev#/dev/}
        # The device directory must exist and be readable: a missing one is not evidence that no writeback is configured.
        # It needs search permission as well as read: without it backing_dev would be hidden and its absence would prove nothing.
        [ -d "$SYSFS/block/$name" ] && [ -r "$SYSFS/block/$name" ] && [ -x "$SYSFS/block/$name" ] || return 1
        back=none
        if [ -e "$SYSFS/block/$name/backing_dev" ]; then back=$(cat "$SYSFS/block/$name/backing_dev" 2>/dev/null) || return 1; fi
        [ "$back" = none ] || return 1 ;;
      /dev/mapper/*|/dev/dm-*)
        real=$(readlink -f -- "$dev") || return 1
        name=${real##*/}
        uuid=$(cat "$SYSFS/block/$name/dm/uuid" 2>/dev/null || true)
        case "$uuid" in CRYPT-*) ;; *) return 1 ;; esac ;;
      *) return 1 ;;
    esac
  done < "$SWAPS"
  return 0
}
# A directory is memory-only when it is on ramfs, or on tmpfs that cannot reach an unencrypted swap.
memory_only() {
  local fs opts
  fs=$(stat -f -c %T -- "$1" 2>/dev/null) || return 1
  case "$fs" in
    ramfs) return 0 ;;
    tmpfs) ;;
    *) return 1 ;;
  esac
  opts=$(findmnt -no OPTIONS -T "$1" 2>/dev/null || true)
  [[ ",$opts," == *,noswap,* ]] && return 0
  swap_safe
}
