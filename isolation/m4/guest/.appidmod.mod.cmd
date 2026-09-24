savedcmd_appidmod.mod := printf '%s\n'   appidmod.o | awk '!x[$$0]++ { print("./"$$0) }' > appidmod.mod
