# Cinematic banner asset

Asset: `site/assets/compute-cinematic.webp` (203 KB). Generated with the built-in image generation tool, then encoded as WebP with FFmpeg. The original is retained under the local Codex generated-images directory. The still plates are the loading and reduced-motion fallbacks for the Gen-4.5 video loops described below. The scenes are decorative artwork, not a real-time hardware status visualization. No animation library is used.

## Generation prompt

Use case: ads-marketing. Create one photorealistic cinematic 3D environment image for a premium confidential-computing company's full-width website banner. Extra wide landscape composition, 2560x1440 or wider landscape. A monumental black graphite processor and precision-machined server hardware landscape, macro low-angle camera gliding across a complex dark motherboard, layered metallic heatsinks, dense tiny capacitors, brushed aluminum, black ceramic, engraved circuit traces. A single broad rectangular chip sits right of center, its perimeter emitting restrained luminous emerald light, with thin luminous emerald pathways extending across the board toward foreground. Atmospheric depth and subtle volumetric light, physically based materials, dramatic rim lighting, deep blacks, silver metallic details. Perspective feels like a cinematic high-end GPU launch film or Unreal Engine product rendering, tactile and sophisticated. Main visual interest occupies right 55%, left 45% stays dark with low-contrast hardware receding to make large white web text legible. Fill entire frame with the environment, no separate floating diagram. No text, no lettering, no brand logos, no lock symbols, no padlocks, no shields, no outlined wireframe cubes, no UI, no infographic, no cartoon, no rounded illustration. High detail and sharp material realism with selective depth of field. This is a background plate for a slow cinematic camera-move animation.

## Validation

Built the production bundle. Checked home, Host, Develop and Apps at 390, 768 and 1440 pixels for image loading and overflow. Inspected desktop and mobile screenshots. Verified pause control and reduced-motion behavior. Animation pauses offscreen and when the document is hidden; listeners are removed on soft-navigation unmount.

## Page-specific scenes

Three additional original images were generated with the built-in image tool and encoded as WebP with FFmpeg. Overview retains the original processor plate. Each page now uses its corresponding generated video with motion inside the scene. All share the same pause, visibility and reduced-motion behavior.

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


## Gen-4.5 video banners

All four source plates were animated with Runway Gen-4.5 (5 seconds, 16:9) on 2026-09-24 UTC. The source clips live in the Runway session “Emerald Circuit Macro Film”; source exports are retained locally in the Codex `work/banner-video` directory. Four generations consumed 240 credits; Runway awarded 300 quest credits during this work.

The published `site/assets/{compute,apps,develop,host}-cinematic.mp4` files are silent H.264, 1280×720 at 30 fps. Each five-second generation is retimed into a 16-second forward-and-return loop. A cosine timing curve slows the scene to a gentle stop at each turnaround, including the loop seam, and smoothly accelerates through the middle. Adjacent source frames are blended to avoid choppy repeated frames during the slow portions. Rebuild from the original Runway exports with `python scripts/render-banner-loops.py /path/to/source-directory` (FFmpeg and NumPy required). Source clips and one-second contact sheets were inspected for material/geometry stability. The hardware light pulses, illuminated interiors, optical activity and rack lighting are generated movement within the scene. Gen-4.5 also introduced camera movement despite the locked-off prompts.

The video component requests the clip only when visible and reduced motion is off. It pauses when offscreen, when the page is hidden, or when the user pauses it. Reduced-motion and JavaScript-disabled visitors see the original still image; playback errors retain that image. No audio track is shipped. Video sources and listeners are released on unmount.

### Motion prompts

#### Overview

Locked-off macro camera. Bright emerald electrical pulses travel in organized waves along the etched circuit traces toward the processor. The processor's edge lighting gently brightens as each wave arrives, then settles. Tiny specular reflections change across the brushed metal in response to the passing light. Solid hardware remains geometrically stable. Restrained premium hardware-film motion, dark left side remains calm for overlaid text, one continuous shot.

#### Apps

Locked-off product camera. Within the smoked-glass cartridges, the thin cyan energy rings rotate slowly around their internal cores. Soft luminous particles circulate inside each sealed chamber. Reflections slide naturally across the glass as the interior light changes. The metal bases and external shells remain stationary and rigid. Elegant restrained activity, dark left side stays quiet, one continuous shot.

#### Develop

Locked-off macro camera. Fine violet-white packets of light flow through the metallic circuit pathways into the optical junction. The fiber-optic strands shimmer in a coordinated gentle sequence, and the central junction pulses softly. Precise stable geometry, subtle changing reflections, no camera movement. The left side remains dark and readable, one continuous shot.

#### Host

Locked-off architectural camera. Small amber status lights on the server racks blink asynchronously and softly, in natural non-uniform patterns. Cooling fans visible behind ventilation grilles rotate slowly. Subtle reflections on the polished floor respond to the changing rack lights. Server cabinets remain rigid and stationary, calm premium data-center atmosphere, one continuous shot.

Validation: production build passed. Browser checks passed for all four pages at 390px and 1440px: correct video, muted looping playback, pause/resume, offscreen pause and no horizontal overflow. Live reduced-motion changes stop playback; initial reduced motion makes no video request. JavaScript-disabled rendering retains the still image. Desktop and mobile screenshots were reviewed.
