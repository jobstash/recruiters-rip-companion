#!/bin/sh
# Independent of the AppImage FUSE mount and installed Electron libraries.
# Arguments are passed as an argv array, never evaluated as shell code.
set -eu
umask 077
work=$1 target=$2 staged=$3 backup=$4 oldpid=$5 digest=$6 id=$7 profile=$8 lock=$9
case "$id" in *[!a-f0-9]*|'') exit 1;; esac
[ "${#id}" = 32 ]
case "$oldpid" in *[!0-9]*|'') exit 1;; esac
[ "$oldpid" -gt 0 ]
parent=$(dirname -- "$target")
[ "$staged" = "$parent/.recruiters-update-$id.AppImage" ]
[ "$backup" = "$parent/.recruiters-backup-$id.AppImage" ]
[ "$(basename -- "$work")" = "install-$id" ]
[ "$profile" = "$(dirname -- "$(dirname -- "$work")")" ]
identity=$(printf '%s' "$target" | sha256sum); identity=${identity%% *}
[ "$lock" = "$parent/.recruiters-installation-$identity.lock" ]
[ "$(readlink -f -- /proc/$$/fd/3)" = "$lock" ]
locked=0
acquire_lock() {
  [ "$locked" = 0 ] || return 0
  /usr/bin/flock -n 3 || return 1
  locked=1
}
release_lock() { /usr/bin/flock -u 3; locked=0; }
real_file() { [ -f "$1" ] && [ ! -L "$1" ] && [ "$(readlink -f -- "$1")" = "$1" ]; }
real_dir() { [ -d "$1" ] && [ ! -L "$1" ] && [ "$(readlink -f -- "$1")" = "$1" ]; }
confirmed() { real_file "$work/confirmed.json" && cmp -s -- "$work/confirmed.json" "$work/expected-confirmation.json"; }
receipt() {
  status=$1
  if confirmed; then status=confirmed; fi
  if [ "${newpid:-0}" -gt 0 ]; then
    json=$(cat -- "$work/receipt-$status.json")
    printf '%s,"launchedPid":%s}' "${json%?}" "$newpid" > "$work/journal.shell-tmp"
  else
    cp -- "$work/receipt-$status.json" "$work/journal.shell-tmp"
  fi
  mv -f -- "$work/journal.shell-tmp" "$work/journal.json"
}
validate() {
  real_dir "$work" && real_dir "$parent" && real_file "$target" && real_file "$staged"
  [ ! -e "$backup" ] && [ ! -L "$backup" ]
  actual=$(sha256sum -- "$staged"); actual=${actual%% *}
  [ "$actual" = "$digest" ]
}
restore() {
  # A duplicate child may exit while another normal startup owns the app.
  # Only kernel exclusion, also held by ordinary startup, permits rollback.
  if ! acquire_lock; then receipt unconfirmed; return 1; fi
  if [ -e "$target" ]; then
    real_file "$target" && [ ! -e "$staged" ] && [ ! -L "$staged" ]
    mv -- "$target" "$staged"
  fi
  real_file "$backup"
  mv -- "$backup" "$target"
  receipt rolled-back
  release_lock
  "$target" "--user-data-dir=$profile" 3>&- </dev/null >/dev/null 2>&1 &
}
validate
printf '%s' "$id" > "$work/ready"
i=0
while [ ! -f "$work/commit" ]; do
  kill -0 "$oldpid" 2>/dev/null || exit 1
  i=$((i + 1)); [ "$i" -lt 300 ] || exit 1
  sleep 0.1
done
i=0
while kill -0 "$oldpid" 2>/dev/null; do
  i=$((i + 1)); [ "$i" -lt 600 ] || { receipt failed; exit 1; }
  sleep 0.2
done
if ! acquire_lock; then receipt unconfirmed; exit 0; fi
validate
receipt swapping
mv -- "$target" "$backup"
if ! mv -- "$staged" "$target"; then restore; exit 1; fi
receipt launching
release_lock
"$target" "--user-data-dir=$profile" 3>&- </dev/null >/dev/null 2>&1 &
newpid=$!
printf '%s' "$newpid" > "$work/launched-pid"
receipt launched
i=0
while ! confirmed; do
  if ! kill -0 "$newpid" 2>/dev/null; then
    wait "$newpid" || true
    restore
    exit 1
  fi
  i=$((i + 1))
  if [ "$i" -ge 480 ]; then receipt unconfirmed; exit 0; fi
  sleep 0.25
done
receipt confirmed
