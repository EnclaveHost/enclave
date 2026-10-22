# the b231396f inline preservation logic on a snapshot pair whose VM list was unavailable both times
$pre = [ordered]@{ vmCount = -1; vmSha = 'u' }; $post = [ordered]@{ vmCount = -1; vmSha = 'u' }; $keep = [ordered]@{}
foreach ($k in 'vmCount','vmSha') { $keep[$k] = ((ConvertTo-Json -InputObject $pre[$k] -Compress) -eq (ConvertTo-Json -InputObject $post[$k] -Compress)) }
[ordered]@{ oldPreservedClaim = (@($keep.Values | Where-Object { -not $_ }).Count -eq 0) } | ConvertTo-Json -Compress
