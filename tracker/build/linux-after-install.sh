#!/bin/bash
# Crewline Tracker .deb post-install: electron-builder's usual steps, plus an AppArmor profile so the app can
# start on Ubuntu 24.04+ (which blocks the user namespaces Electron's sandbox needs unless an app is allowed them).
APP='/opt/Crewline Tracker'

if type update-alternatives 2>/dev/null >&1; then
    if [ -L '/usr/bin/crewline-tracker' -a -e '/usr/bin/crewline-tracker' -a "`readlink '/usr/bin/crewline-tracker'`" != '/etc/alternatives/crewline-tracker' ]; then
        rm -f '/usr/bin/crewline-tracker'
    fi
    update-alternatives --install '/usr/bin/crewline-tracker' 'crewline-tracker' "$APP/crewline-tracker" 100 || ln -sf "$APP/crewline-tracker" '/usr/bin/crewline-tracker'
else
    ln -sf "$APP/crewline-tracker" '/usr/bin/crewline-tracker'
fi

profile_loaded=0
if [ -d /etc/apparmor.d ] && hash apparmor_parser 2>/dev/null; then
    abi=''
    [ -f /etc/apparmor.d/abi/4.0 ] && abi='abi <abi/4.0>,'
    cat > /etc/apparmor.d/crewline-tracker <<PROFILE
$abi
include <tunables/global>

profile crewline-tracker "$APP/crewline-tracker" flags=(unconfined) {
  userns,

  include if exists <local/crewline-tracker>
}
PROFILE
    if apparmor_parser -r -T -W /etc/apparmor.d/crewline-tracker 2>/dev/null; then
        profile_loaded=1
    else
        # Older AppArmor (e.g. Ubuntu 22.04) doesn't know the userns rule: don't leave a profile it can't load.
        rm -f /etc/apparmor.d/crewline-tracker
    fi
fi

# No AppArmor profile: fall back to the setuid sandbox helper, which works whether or not user namespaces are allowed.
if [ "$profile_loaded" = 1 ]; then
    chmod 0755 "$APP/chrome-sandbox" || true
else
    chown root:root "$APP/chrome-sandbox" || true
    chmod 4755 "$APP/chrome-sandbox" || true
fi

if hash update-mime-database 2>/dev/null; then
    update-mime-database /usr/share/mime || true
fi
if hash update-desktop-database 2>/dev/null; then
    update-desktop-database /usr/share/applications || true
fi
exit 0
