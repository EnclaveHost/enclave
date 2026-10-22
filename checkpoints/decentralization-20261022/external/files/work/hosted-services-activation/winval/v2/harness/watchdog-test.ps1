# proves the run_ps watchdog: this session sleeps far past its bound; the watchdog must end it (it never prints 'not ended')
Start-Sleep -Seconds 90
'not ended'
