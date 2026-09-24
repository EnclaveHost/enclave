# Overview technology logo strip

The Overview hero is followed by the approved headline:

> Built on the hardware isolation enterprises trust.

Google, Microsoft, AMD, Intel, NVIDIA, Arm, and AWS appear as technology references, not as Enclave customers, sponsors, or endorsers. Keep this distinction when revising the copy.

The strip uses a 68-second continuous loop, pauses on hover and keyboard focus, includes a pause button, and stops when offscreen or the document is hidden. Reduced-motion and JavaScript-disabled visitors receive a static layout with all seven logos. Duplicated animation content is hidden from assistive technology. Assets are served locally.

## Asset sources

Downloaded September 24, 2026 (UTC). These marks remain the property of their respective owners.

- Google SVG: https://www.gstatic.com/images/branding/googlelogo/svg/googlelogo_clr_74x24px.svg
- Microsoft PNG: https://uhf.microsoft.com/images/microsoft/RE1Mu3b.png
- Intel SVG: https://www.intel.com/content/dam/logos/intel-header-logo.svg
- AMD SVG: https://raw.githubusercontent.com/simple-icons/simple-icons/develop/icons/amd.svg — viewBox cropped to the wordmark bounds; path unchanged.

CSS renders the assets in monochrome to match the site.

## Technology context

- Google Confidential VM: https://docs.cloud.google.com/confidential-computing/confidential-vm/docs/confidential-vm-overview
- Microsoft virtualization-based security: https://learn.microsoft.com/en-us/windows-hardware/design/device-experiences/oem-vbs
- AMD Secure Encrypted Virtualization: https://www.amd.com/en/developer/sev.html
- Intel Trust Domain Extensions: https://www.intel.com/content/www/us/en/developer/tools/trust-domain-extensions/overview.html

## Validation

Production build passed. Chromium checks at 1440px and 390px confirmed the exact headline, all seven assets loading, no horizontal overflow, working pause controls, and no page errors. Reduced-motion and JavaScript-disabled mobile layouts show a static seven-logo grid. Desktop and mobile screenshots were visually reviewed.

## Expanded strip

Logos reduced approximately 15%; NVIDIA, Arm, and AWS added. Additional locally served assets:

- NVIDIA: horizontal logo SVG symbol from https://www.nvidia.com/en-us/ (original paths and viewBox preserved).
- Arm: https://raw.githubusercontent.com/simple-icons/simple-icons/develop/icons/arm.svg (viewBox cropped to the wordmark; path unchanged).
- AWS: header SVG from https://aws.amazon.com/ec2/nitro/nitro-enclaves/ (paths and viewBox preserved).

Technology references:

- NVIDIA GPU confidential computing: https://docs.nvidia.com/nvidia-secure-ai-with-blackwell-and-hopper-gpus-whitepaper.pdf
- Arm Confidential Compute Architecture: https://www.arm.com/architecture/security-features/arm-confidential-compute-architecture
- AWS Nitro Enclaves: https://aws.amazon.com/ec2/nitro/nitro-enclaves/
