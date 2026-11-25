# Enclave RPC catalog art

- `logo.svg`: the catalog thumbnail (16:9; the store shows it contained on the tile).
- `banner.svg`: the app page banner (4:1; the store crops it to 3:1 on narrow screens, so everything that matters
  sits in the middle 1200 of its 1600 units).
- `mark.svg`: the mark alone, square.

The three files are what gets pinned: their text is outlines, so they look the same wherever they are drawn. They
are generated from `src/`, which names the font (Adwaita Mono):

    for n in mark logo banner; do rsvg-convert -f svg rpc/media/src/$n.svg -o rpc/media/$n.svg; done

The art reaches the catalog in a version's config (`_media`, with `thumbnailSvg` and `bannerSvg` set), so it shows
with the next version published after the two files are pinned. Not pinned and not on the catalog as of 2026-11-25:
versions 8 to 10 carry no art.
