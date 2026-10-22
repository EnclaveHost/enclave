# minipc helpers for the bounded Windows validation (work/hosted-services-activation/winval). PowerShell goes as
# -EncodedCommand with ssh -n (cmd.exe parses remote command lines; stdin piping into PowerShell stalls); files go by SFTP.
# The ONLY remote path ever written: C:\ProgramData\Enclave\host-services-validation-20261021 (and nothing outside it).
SSHOPT=(-o BatchMode=yes -o ConnectTimeout=15 -o ServerAliveInterval=10 -o ServerAliveCountMax=3)
VROOT='C:\ProgramData\Enclave\host-services-validation-20261021'
VROOT_SFTP='/C:/ProgramData/Enclave/host-services-validation-20261021'
ps_remote() { local enc; enc=$(printf '%s' "\$ErrorActionPreference='Stop'; \$ProgressPreference='SilentlyContinue'; $1" | iconv -f UTF-8 -t UTF-16LE | base64 -w0)
  ssh -n "${SSHOPT[@]}" minipc powershell -NoProfile -NonInteractive -EncodedCommand "$enc" | tr -d '\r'; }
