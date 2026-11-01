# Root review: primary WMI context

Previous goal turn PROGRESS: four-second admission qualified and native query boundary isolated. New change disables automatic privilege enablement in HyperVStartProvider.Scope. Strict RequireSystem remains unchanged; no RevertToSelf, impersonation acceptance or alternate credentials. Local namespace/server and native two-second query timeout unchanged. A failed provider permission check remains a failure, without elevated retry.

Evidence: target ea292242 effectiveSYSTEM/None became effectiveSYSTEM/Impersonation immediately after singleton service enumeration. Microsoft System.Management source gates SecurityHandler.SetSecurity on EnablePrivileges, and its public option documentation limits use to operations requiring privilege enablement. These support this candidate change but are not proof of the installed Framework internal cause.

Two new hosted cases check fixed scope options and real local Win32_OperatingSystem singleton enumeration preserves the original primary identity. Target Hyper-V SYSTEM preparation must be qualified independently under original guarded worker/fresh admission. No production provider submission or claim to settle prior lost response. Original900s and current aggregate4s/resident2s unchanged.

References:
- https://learn.microsoft.com/en-us/dotnet/api/system.management.connectionoptions.enableprivileges
- https://raw.githubusercontent.com/dotnet/runtime/main/src/libraries/System.Management/src/System/Management/ManagementScope.cs
