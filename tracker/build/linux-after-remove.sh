#!/bin/bash
# Crewline Tracker .deb post-remove: drop the command link and the AppArmor profile added on install.
if type update-alternatives >/dev/null 2>&1; then
    update-alternatives --remove 'crewline-tracker' '/usr/bin/crewline-tracker'
else
    rm -f '/usr/bin/crewline-tracker'
fi
if [ "$1" = remove ] || [ "$1" = purge ]; then
    if [ -f /etc/apparmor.d/crewline-tracker ]; then
        hash apparmor_parser 2>/dev/null && apparmor_parser -R /etc/apparmor.d/crewline-tracker 2>/dev/null
        rm -f /etc/apparmor.d/crewline-tracker
    fi
fi
exit 0
