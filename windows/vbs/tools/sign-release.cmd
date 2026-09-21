@echo off
rem sign-release.cmd -- sign an enclave DLL with Artifact Signing (VBS enclave profile). See ..\SIGNING.md.
rem   sign-release.cmd <path\to\ee-engine.dll>
rem Needs: Windows SDK 26100 signtool, Microsoft.Trusted.Signing.Client (Azure.CodeSigning.Dlib.dll),
rem and the ARTIFACT_SIGNING_* variables plus Azure credentials (az login or AZURE_CLIENT_*).
setlocal
if "%~1"=="" (echo usage: sign-release.cmd ^<enclave.dll^> & exit /b 2)
if not defined ARTIFACT_SIGNING_ENDPOINT (echo ARTIFACT_SIGNING_ENDPOINT is not set & exit /b 2)
if not defined ARTIFACT_SIGNING_ACCOUNT (echo ARTIFACT_SIGNING_ACCOUNT is not set & exit /b 2)
if not defined ARTIFACT_SIGNING_PROFILE (echo ARTIFACT_SIGNING_PROFILE is not set & exit /b 2)
if not defined ARTIFACT_SIGNING_DLIB set ARTIFACT_SIGNING_DLIB=%USERPROFILE%\.nuget\packages\microsoft.trusted.signing.client\1.0.60\bin\x64\Azure.CodeSigning.Dlib.dll
if not exist "%ARTIFACT_SIGNING_DLIB%" (echo dlib not found: %ARTIFACT_SIGNING_DLIB% & exit /b 2)
set KITS=C:\Program Files (x86)\Windows Kits\10
set META=%TEMP%\artifact-signing-metadata.json
> "%META%" echo { "Endpoint": "%ARTIFACT_SIGNING_ENDPOINT%", "CodeSigningAccountName": "%ARTIFACT_SIGNING_ACCOUNT%", "CertificateProfileName": "%ARTIFACT_SIGNING_PROFILE%" }
echo === veiid (enclave image identity must be stamped before signing)
"%KITS%\bin\10.0.26100.0\x64\veiid.exe" "%~1" || exit /b 1
echo === signtool with Artifact Signing (page hashes are mandatory for enclaves)
"%KITS%\bin\10.0.26100.0\x64\signtool.exe" sign /v /debug /fd SHA256 /ph /tr http://timestamp.acs.microsoft.com /td SHA256 /dlib "%ARTIFACT_SIGNING_DLIB%" /dmdf "%META%" "%~1"
if errorlevel 1 (echo === SIGN FAILED & exit /b 1)
"%KITS%\bin\10.0.26100.0\x64\signtool.exe" verify /v /ph /pa "%~1"
echo === signed %~1
