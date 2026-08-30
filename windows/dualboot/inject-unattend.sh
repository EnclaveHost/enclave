#!/usr/bin/env bash
# inject-unattend.sh -- finish OOBE without the Microsoft-account sign-in.
#
#   sudo ./inject-unattend.sh            # dry run
#   sudo ./inject-unattend.sh --apply
#
# The install boots fine; it dies in OOBE at the MSA sign-in, which is the one
# GPU-accelerated web view in the sequence, on a box whose monitors hang off an
# RTX 3070 that has no driver until OOBE installs one mid-flight.
#
# Windows reads %WINDIR%\Panther\unattend.xml during the oobeSystem pass, so
# dropping one there offline skips the online-account screens entirely, creates
# a local administrator and logs straight in -- no web view, no sign-in, and
# nothing that depends on the display surviving a driver swap.
set -uo pipefail

WINPART=/dev/nvme0n1p3
USERNAME="${USERNAME_OVERRIDE:-enclave}"
PASSWORD="${PASSWORD_OVERRIDE:-Enclave!2026}"
APPLY=0; FIXDIRTY=0
for a in "$@"; do
  case "$a" in
    --apply) APPLY=1 ;;
    --fix-dirty) FIXDIRTY=1 ;;
  esac
done
die() { echo "error: $*" >&2; exit 1; }
[ "$(id -u)" = 0 ] || die "must run as root"
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
. "$HERE/_ntfs.sh"

MNT=$(mktemp -d)
trap 'umount "$MNT" 2>/dev/null || true; rmdir "$MNT" 2>/dev/null || true' EXIT
MODE=ro; [ "$APPLY" = 1 ] && MODE=rw
ntfs_mount "$WINPART" "$MNT" "$MODE" "$FIXDIRTY" || exit 1
[ -d "$MNT/Windows/Panther" ] || die "no Windows\\Panther directory -- wrong partition?"

echo
echo "=== did the OOBE driver update actually land? ==="
NV=$(find "$MNT/Windows/System32/drivers" -maxdepth 1 -iname 'nvlddmkm.sys' 2>/dev/null)
if [ -n "$NV" ]; then
  echo "  nvlddmkm.sys PRESENT -- the NVIDIA driver installed:"
  ls -la $NV | sed 's/^/    /'
else
  echo "  nvlddmkm.sys absent -- still on Microsoft Basic Display"
fi
NVPKG=$(find "$MNT/Windows/System32/DriverStore/FileRepository" -maxdepth 1 -iname 'nv*' 2>/dev/null | wc -l)
echo "  NVIDIA packages staged in DriverStore: $NVPKG"
BASIC=$(find "$MNT/Windows/System32/drivers" -maxdepth 1 -iname 'BasicDisplay.sys' 2>/dev/null | wc -l)
echo "  BasicDisplay.sys present: $BASIC"
echo

TMP=$(mktemp)
cat > "$TMP" <<XML
<?xml version="1.0" encoding="utf-8"?>
<unattend xmlns="urn:schemas-microsoft-com:unattend">
  <settings pass="oobeSystem">
    <component name="Microsoft-Windows-Shell-Setup" processorArchitecture="amd64"
               publicKeyToken="31bf3856ad364e35" language="neutral" versionScope="nonSxS"
               xmlns:wcm="http://schemas.microsoft.com/WMIConfig/2002/State"
               xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">
      <OOBE>
        <HideEULAPage>true</HideEULAPage>
        <HideOEMRegistrationScreen>true</HideOEMRegistrationScreen>
        <HideOnlineAccountScreens>true</HideOnlineAccountScreens>
        <HideLocalAccountScreen>true</HideLocalAccountScreen>
        <HideWirelessSetupInOOBE>true</HideWirelessSetupInOOBE>
        <ProtectYourPC>3</ProtectYourPC>
      </OOBE>
      <UserAccounts>
        <LocalAccounts>
          <LocalAccount wcm:action="add">
            <Name>${USERNAME}</Name>
            <DisplayName>${USERNAME}</DisplayName>
            <Group>Administrators</Group>
            <Password>
              <Value>${PASSWORD}</Value>
              <PlainText>true</PlainText>
            </Password>
          </LocalAccount>
        </LocalAccounts>
      </UserAccounts>
      <AutoLogon>
        <Enabled>true</Enabled>
        <Username>${USERNAME}</Username>
        <LogonCount>5</LogonCount>
        <Password>
          <Value>${PASSWORD}</Value>
          <PlainText>true</PlainText>
        </Password>
      </AutoLogon>
      <TimeZone>Pacific Standard Time</TimeZone>
    </component>
  </settings>
</unattend>
XML

python3 -c "import xml.dom.minidom,sys; xml.dom.minidom.parse(sys.argv[1]); print('  unattend.xml is well-formed')" "$TMP" \
  || { rm -f "$TMP"; die "generated XML is malformed"; }
echo
echo "=== would write to Windows\\Panther\\unattend.xml ==="
sed 's/^/  /' "$TMP"
echo
echo "  local administrator: $USERNAME / $PASSWORD"
echo

if [ "$APPLY" != 1 ]; then
  rm -f "$TMP"
  echo "DRY RUN -- nothing changed.  Re-run with --apply."
  exit 0
fi

[ -f "$MNT/Windows/Panther/unattend.xml" ] && \
  cp "$MNT/Windows/Panther/unattend.xml" "/var/tmp/unattend.xml.bak-$(date +%s)"
cp "$TMP" "$MNT/Windows/Panther/unattend.xml"
rm -f "$TMP"
sync
ls -la "$MNT/Windows/Panther/unattend.xml"
echo
cat <<MSG

Written.  Reboot into Windows Boot Manager.

OOBE should now skip the network and account screens entirely and log straight
in as '$USERNAME'.  If the screen still goes black at the same point, the driver
install is the cause rather than the sign-in, and the answer is to give Windows
a display path that does not depend on the RTX 3070 -- either the ASPEED VGA
port on the motherboard, or the BMC's remote console.

Once you are at a desktop, the actual test:

  reg add "HKLM\\System\\CurrentControlSet\\Control\\Hypervisor" ^
    /v EnableHardwareIsolation /t REG_DWORD /d 1 /f
  shutdown /r /t 0

then:

  Get-VMHost | Select-Object SnpStatus, TdxStatus, GuestIsolationTypes
MSG
