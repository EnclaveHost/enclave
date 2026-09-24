# Cinematic banner asset

Asset: `site/assets/compute-cinematic.webp` (203 KB). Generated with the built-in image generation tool, then encoded as WebP with FFmpeg. The original is retained under the local Codex generated-images directory. Motion is CSS camera drift and a moving light layer, not a video or a real-time hardware status visualization. No third-party imagery or animation library is used.

## Generation prompt

Use case: ads-marketing. Create one photorealistic cinematic 3D environment image for a premium confidential-computing company's full-width website banner. Extra wide landscape composition, 2560x1440 or wider landscape. A monumental black graphite processor and precision-machined server hardware landscape, macro low-angle camera gliding across a complex dark motherboard, layered metallic heatsinks, dense tiny capacitors, brushed aluminum, black ceramic, engraved circuit traces. A single broad rectangular chip sits right of center, its perimeter emitting restrained luminous emerald light, with thin luminous emerald pathways extending across the board toward foreground. Atmospheric depth and subtle volumetric light, physically based materials, dramatic rim lighting, deep blacks, silver metallic details. Perspective feels like a cinematic high-end GPU launch film or Unreal Engine product rendering, tactile and sophisticated. Main visual interest occupies right 55%, left 45% stays dark with low-contrast hardware receding to make large white web text legible. Fill entire frame with the environment, no separate floating diagram. No text, no lettering, no brand logos, no lock symbols, no padlocks, no shields, no outlined wireframe cubes, no UI, no infographic, no cartoon, no rounded illustration. High detail and sharp material realism with selective depth of field. This is a background plate for a slow cinematic camera-move animation.

## Validation

Built the production bundle. Checked home, Host, Develop and Apps at 390, 768 and 1440 pixels for image loading and overflow. Inspected desktop and mobile screenshots. Verified pause control and reduced-motion behavior. Animation pauses offscreen and when the document is hidden; listeners are removed on soft-navigation unmount.

## Page-specific scenes

Three additional original images were generated with the built-in image tool and encoded as WebP with FFmpeg. Overview retains the original processor plate. Apps uses a sideways camera glide, Develop a diagonal approach with pulsing violet light, and Host a slow forward move down a server aisle. All share the same pause, visibility and reduced-motion behavior.

Assets:
- `site/assets/apps-cinematic.webp`
- `site/assets/develop-cinematic.webp`
- `site/assets/host-cinematic.webp`

Each prompt consists of this prefix, the corresponding scene below, then the common suffix.

Prefix: Use case: ads-marketing. Original full-width website hero BACKGROUND plate, landscape 16:9, highly detailed realistic cinematic materials and lighting.

Apps: A cinematic photoreal 3D scene of a series of precision-machined dark titanium application cartridges with translucent smoked-glass tops, arranged along an elegant curved black platform. Restrained cyan light travels inside the glass, beautiful reflections, layered mechanical detail, premium product-launch film aesthetic. Close camera with selective depth of field. The cartridges occupy the RIGHT two thirds, receding into darkness; LEFT third very dark low-detail negative space for white website headline. No cube stack, no processor motherboard, no server racks.

Develop: A cinematic photoreal macro environment of an intricate black silicon wafer and dense etched circuit pathways forming sweeping precise geometric routes toward a luminous violet-white central optical junction on the RIGHT. Fine metallic conductors, microstructures, shimmering fiber-optic threads, huge sense of scale and depth, low-angle lens, premium scientific product film aesthetic. LEFT third is dark soft-focus circuitry negative space for white website headline. No readable code, no monitor, no chip hero, no server racks.

Host: A cinematic photoreal wide-angle view down a vast dark data-center aisle, sculptural black server racks on the RIGHT and in deep perspective, brushed metal ventilation grilles, tiny warm amber status lights and subtle overhead golden rim lighting, polished dark floor reflecting the lights. Premium architectural photography / hardware launch film, atmospheric depth, physically realistic. LEFT third stays dark low-detail open aisle negative space for white website headline. No people, no floating processor, no green motherboard.

Suffix: Color palette almost-black graphite with restrained accent lighting. Fill the whole image with the environment, no framing. No text, no letters, no logos, no watermark, no UI, no infographic, no line-art or cartoon. Intended for slow animated camera movement behind website copy.
