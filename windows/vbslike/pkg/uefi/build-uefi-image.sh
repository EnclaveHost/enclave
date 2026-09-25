#!/bin/sh
# build-uefi-image.sh -- the guest as a STANDARD UEFI boot image, for a Gen2 Hyper-V VM whose firmware is Microsoft's
# standard OpenHCL IGVM (UEFI in VTL0). Research E8: this build starts a standard OpenHCL image and not a linux-direct
# one, so the guest that ran linux-direct is delivered here unchanged, as a UEFI payload.
#
#   build-uefi-image.sh --kernel BZIMAGE --initrd INITRD --cmdline "…" --stub linuxx64.efi.stub --out DIR
#                       [--uki-recipe build-uki.sh] [--mtools DIR] [--esp-mib 128] [--disk-mib 256] [--epoch N]
#
# The UKI follows enclave-5d's spec (isolation/m3/UEFI-BOOT.md, acfdddac): .osrel, .cmdline, .linux, .initrd in that
# order, the fixed .osrel text, and SOURCE_DATE_EPOCH=0 for objcopy (it stamps the PE TimeDateStamp and the checksum
# follows). This file assembles it independently; with --uki-recipe it ALSO runs 5d's own build-uki.sh, and the two
# must agree byte for byte (two readings of one spec, as with the AppID). The ESP's FAT timestamps use --epoch.
#
# It builds, in DIR:
#   uki.efi     a Unified Kernel Image: systemd-stub + .osrel + .cmdline + .initrd + .linux (the kernel must carry an
#               EFI stub; the WSL kernel does). The cmdline and initrd are INSIDE the signed-able PE, so nothing on the
#               disk can change them without changing this file's hash.
#   esp.img     FAT32, holding only \EFI\BOOT\BOOTX64.EFI = uki.efi (the removable-media default path: no boot entry,
#               no NVRAM variable needed). Fixed volume id and timestamps (mkfs.fat --invariant, SOURCE_DATE_EPOCH).
#   disk.raw    GPT, fixed disk and partition GUIDs, one EFI System partition at 1 MiB = esp.img. THIS is the pinned
#               identity of the disk.
#   guest.iso   a UEFI El Torito ISO: esp.img is a file INSIDE the ISO 9660 volume and the El Torito EFI entry points at
#               it. The catalog's 16-bit sector count cannot express an ESP over 32 MiB, so it is written as 0; EDK2
#               firmware (OVMF, and Project Mu in Hyper-V) then takes the rest of the ISO 9660 VOLUME from the image's
#               LBA, which holds the whole image only if the image is inside the volume. MEASURED: an ESP appended as a
#               GPT partition OUTSIDE the volume fails ("Not Found" at the CD-ROM). READ-ONLY by construction: the Gen2
#               boot medium enclave-d1 chose. Reproducible.
#   disk.vhdx   the Hyper-V container of disk.raw, kept as the pinned FALLBACK medium (Gen2 boots "from a SCSI virtual hard disk (.VHDX)"). Its header
#               GUIDs are random (qemu-img), so its bytes are NOT reproducible; the builder converts it back and
#               requires the payload to be disk.raw byte for byte.
#   build.json  every input, tool and output with its sha256.
# Reproducible: two runs over the same inputs and tools give identical uki.efi, esp.img and disk.raw (checked by
# `--check`, which builds twice). It needs no root, starts no VM, and changes nothing outside DIR.
set -eu
KERNEL= INITRD= CMDLINE= STUB= OUT= MTOOLS= ESP_MIB=128 DISK_MIB=256 EPOCH=1758672000 CHECK= RECIPE=
while [ $# -gt 0 ]; do case "$1" in
  --kernel) KERNEL=$2; shift 2;; --initrd) INITRD=$2; shift 2;; --cmdline) CMDLINE=$2; shift 2;;
  --stub) STUB=$2; shift 2;; --out) OUT=$2; shift 2;; --mtools) MTOOLS=$2; shift 2;;
  --esp-mib) ESP_MIB=$2; shift 2;; --disk-mib) DISK_MIB=$2; shift 2;; --epoch) EPOCH=$2; shift 2;;
  --uki-recipe) RECIPE=$2; shift 2;; --check) CHECK=1; shift;; *) echo "unknown argument $1" >&2; exit 2;; esac; done
for v in KERNEL INITRD STUB OUT; do eval "[ -n \"\${$v}\" ]" || { echo "--$(echo $v | tr A-Z a-z) is required" >&2; exit 2; }; done
[ -n "$CMDLINE" ] || { echo "--cmdline is required" >&2; exit 2; }
[ -n "$MTOOLS" ] && PATH="$MTOOLS:$PATH"
for t in objcopy objdump mkfs.fat mcopy mmd sfdisk qemu-img xorriso sha256sum; do command -v $t >/dev/null || { echo "missing tool: $t" >&2; exit 2; }; done
export SOURCE_DATE_EPOCH=$EPOCH TZ=UTC LC_ALL=C MTOOLS_SKIP_CHECK=1

# --check: build twice into fresh directories and require the pinned outputs to be identical, then keep the first
if [ -n "$CHECK" ]; then
  self=$(cd "$(dirname "$0")" && pwd)/$(basename "$0")
  set -- --kernel "$KERNEL" --initrd "$INITRD" --cmdline "$CMDLINE" --stub "$STUB" --esp-mib "$ESP_MIB" --disk-mib "$DISK_MIB" --epoch "$EPOCH"
  [ -n "$MTOOLS" ] && set -- "$@" --mtools "$MTOOLS"
  [ -n "$RECIPE" ] && set -- "$@" --uki-recipe "$RECIPE"
  rm -rf "$OUT.check-a" "$OUT.check-b"
  "$self" "$@" --out "$OUT.check-a" >/dev/null; "$self" "$@" --out "$OUT.check-b" >/dev/null
  rc=0; for f in uki.efi esp.img disk.raw guest.iso; do
    a=$(sha256sum < "$OUT.check-a/$f" | cut -c1-64); b=$(sha256sum < "$OUT.check-b/$f" | cut -c1-64)
    if [ "$a" = "$b" ]; then echo "reproducible  $f  $a"; else echo "DIFFERS       $f  $a vs $b"; rc=1; fi; done
  rm -rf "$OUT.check-b"; rm -rf "$OUT"; mv "$OUT.check-a" "$OUT"; exit $rc
fi

mkdir -p "$OUT"; W=$(mktemp -d); trap 'rm -rf "$W"' EXIT
sha() { sha256sum < "$1" | cut -c1-64; }

# 1. the UKI, per UEFI-BOOT.md: after the stub's last section, each at the stub's SectionAlignment, in the order
#    .osrel .cmdline .linux .initrd; the PE timestamp pinned by SOURCE_DATE_EPOCH=0.
printf 'NAME="enclave NucBox guest"\nID=enclave-nucbox-guest\n' > "$W/osrel"
printf '%s' "$CMDLINE" > "$W/cmdline"
align=$(objdump -p "$STUB" | awk '$1 == "SectionAlignment" { print $2 }'); align=$((0x$align))
next=$(objdump -h "$STUB" | awk 'NF == 7 && $1 ~ /^[0-9]+$/ { e = strtonum("0x" $3) + strtonum("0x" $4); if (e > m) m = e } END { print m }')
up() { echo $(( ($1 + align - 1) / align * align )); }
args=""; vma=$(up "$next")
for pair in osrel:"$W/osrel" cmdline:"$W/cmdline" linux:"$KERNEL" initrd:"$INITRD"; do
  name=${pair%%:*}; file=${pair#*:}
  args="$args --add-section .$name=$file --change-section-vma .$name=$(printf 0x%x "$vma")"
  vma=$(up $(( vma + $(stat -Lc%s "$file") )))
done
# shellcheck disable=SC2086
SOURCE_DATE_EPOCH=0 objcopy $args "$STUB" "$W/uki.efi"
touch -d "@$EPOCH" "$W/uki.efi"
if [ -n "$RECIPE" ]; then   # enclave-5d's own recipe must produce the same bytes
  UKI_STUB="$STUB" sh "$RECIPE" "$KERNEL" "$INITRD" "$W/uki.recipe.efi" "$CMDLINE" >/dev/null
  [ "$(sha "$W/uki.recipe.efi")" = "$(sha "$W/uki.efi")" ] \
    || { echo "the UKI differs from enclave-5d's build-uki.sh: $(sha "$W/uki.efi") vs $(sha "$W/uki.recipe.efi")" >&2; exit 1; }
fi

# 2. the ESP: FAT32, fixed volume id, invariant metadata, the UKI at the removable-media default path
truncate -s "${ESP_MIB}M" "$W/esp.img"
mkfs.fat -F 32 -i E5C1A7E5 --invariant -n ENCLAVEESP "$W/esp.img" >/dev/null
mmd -i "$W/esp.img" ::/EFI ::/EFI/BOOT
mcopy -m -i "$W/esp.img" "$W/uki.efi" ::/EFI/BOOT/BOOTX64.EFI

# 3. the disk: GPT with fixed GUIDs, the ESP at 1 MiB (sector 2048)
truncate -s "${DISK_MIB}M" "$W/disk.raw"
esp_sectors=$(( ESP_MIB * 2048 ))
printf 'label: gpt\nlabel-id: 5E6C0D1A-7A0B-4C3E-9E0B-000000000001\nfirst-lba: 2048\nstart=2048, size=%s, type=C12A7328-F81F-11D2-BA4B-00A0C93EC93B, uuid=5E6C0D1A-7A0B-4C3E-9E0B-0000000000E5, name="EFI System"\n' "$esp_sectors" \
  | sfdisk --no-reread --no-tell-kernel -q "$W/disk.raw"
dd if="$W/esp.img" of="$W/disk.raw" bs=1M seek=1 conv=notrunc status=none

# 4. the Hyper-V container, and the check that it carries exactly disk.raw
qemu-img convert -q -f raw -O vhdx -o subformat=dynamic "$W/disk.raw" "$W/disk.vhdx"
qemu-img convert -q -f vhdx -O raw "$W/disk.vhdx" "$W/disk.back"
[ "$(sha "$W/disk.back")" = "$(sha "$W/disk.raw")" ] || { echo "disk.vhdx does not carry disk.raw" >&2; exit 1; }

# 5. the ISO: esp.img as the only file of the ISO 9660 tree, and the El Torito EFI no-emulation image
mkdir -p "$W/isoroot"; cp "$W/esp.img" "$W/isoroot/efiboot.img"
touch -d "@$EPOCH" "$W/isoroot" "$W/isoroot/efiboot.img"
modstamp=$(date -u -d "@$EPOCH" +%Y%m%d%H%M%S00)
xorriso -report_about SORRY -as mkisofs -o "$W/guest.iso" -V ENCLAVE_GUEST -iso-level 3 \
  --modification-date="$modstamp" \
  -e efiboot.img -no-emul-boot \
  "$W/isoroot" 2>/dev/null

for f in uki.efi esp.img disk.raw disk.vhdx guest.iso; do cp "$W/$f" "$OUT/$f"; done
cat > "$OUT/build.json" <<JSON
{
 "type": "enclave-vbslike-uefi-image/1",
 "inputs": {
  "kernel":  { "sha256": "$(sha "$KERNEL")", "bytes": $(stat -Lc%s "$KERNEL") },
  "initrd":  { "sha256": "$(sha "$INITRD")", "bytes": $(stat -Lc%s "$INITRD") },
  "stub":    { "sha256": "$(sha "$STUB")", "bytes": $(stat -Lc%s "$STUB") },
  "cmdline": $(printf '%s' "$CMDLINE" | python3 -c 'import json,sys; print(json.dumps(sys.stdin.read()))'),
  "cmdlineSha256": "$(printf '%s' "$CMDLINE" | sha256sum | cut -c1-64)",
  "ukiRecipe": $( [ -n "$RECIPE" ] && echo "{ \"sha256\": \"$(sha "$RECIPE")\", \"agrees\": true }" || echo null )
 },
 "params": { "espMiB": $ESP_MIB, "diskMiB": $DISK_MIB, "sourceDateEpoch": $EPOCH, "fatVolumeId": "E5C1A7E5",
             "gptLabelId": "5E6C0D1A-7A0B-4C3E-9E0B-000000000001", "espPartUuid": "5E6C0D1A-7A0B-4C3E-9E0B-0000000000E5",
             "espPath": "/EFI/BOOT/BOOTX64.EFI" },
 "tools": { "objcopy": "$(objcopy --version | head -1)", "mtools": "$(mcopy --version | head -1)",
            "sfdisk": "$(sfdisk --version)", "xorriso": "$(xorriso -version 2>/dev/null | head -1)", "qemu-img": "$(qemu-img --version | head -1)", "mkfs.fat": "$(mkfs.fat --help 2>&1 | head -1)" },
 "outputs": {
  "uki.efi":   { "sha256": "$(sha "$OUT/uki.efi")", "bytes": $(stat -c%s "$OUT/uki.efi") },
  "esp.img":   { "sha256": "$(sha "$OUT/esp.img")", "bytes": $(stat -c%s "$OUT/esp.img") },
  "disk.raw":  { "sha256": "$(sha "$OUT/disk.raw")", "bytes": $(stat -c%s "$OUT/disk.raw"), "note": "the pinned identity of the disk" },
  "disk.vhdx": { "sha256": "$(sha "$OUT/disk.vhdx")", "bytes": $(stat -c%s "$OUT/disk.vhdx"), "note": "FALLBACK container: header GUIDs are random, so NOT reproducible; its payload is disk.raw (checked)" },
  "guest.iso": { "sha256": "$(sha "$OUT/guest.iso")", "bytes": $(stat -c%s "$OUT/guest.iso"), "note": "the boot medium: El Torito EFI = /efiboot.img (= esp.img) inside the ISO 9660 volume; read-only" }
 }
}
JSON
echo "guest.iso $(sha "$OUT/guest.iso")"; echo "uki.efi   $(sha "$OUT/uki.efi")"; echo "esp.img   $(sha "$OUT/esp.img")"; echo "disk.raw  $(sha "$OUT/disk.raw")"; echo "disk.vhdx $(sha "$OUT/disk.vhdx") (container; payload = disk.raw, checked)"
