#!/usr/bin/bash
# Deploys the web app to eh2k.github.io/□●/web-app/ (the HomeCloud copy of eh2k_github_io):
#   - web-app/ without the dotfiles and the scripts for development
#   - web-app/roms/: the TR707/TR909/RZ-1 ROMs that the buttons under Library/Extras send to the module, from
#     extern/eproms (not in git, so they must be there)
# Both are put together in a temporary directory first and go up with one rsync. Nothing is deleted there:
# drumsynth/ and FV1emu/ under web-app/ exist only there. The apps (app/) are not uploaded, the page gets them
# from GitHub (main).
#
#   ./upload.sh [rsync options, e.g. -n for a dry run]
#   DEST=/tmp/site/web-app ./upload.sh     (another target, e.g. to try it locally)

set -e

cd $(dirname $0)
export PATH=/usr/bin/:$PATH

DEST=${DEST:-pi@eh2k.spdns.org:/home/pi/HomeCloud/eh2k_github_io/□●/web-app}

ROMS=(../extern/eproms/tr707/707_IC34.bin ../extern/eproms/tr707/707_IC35.bin
  ../extern/eproms/tr707/707_IC19_CRASH.bin ../extern/eproms/tr707/707_IC22_RIDE.bin
  ../extern/eproms/tr909/909_HIGH.bin ../extern/eproms/tr909/909_RIDE.bin
  ../extern/eproms/rz-1/RZ1_ROMA.bin ../extern/eproms/rz-1/RZ1_ROMB.bin)
for f in "${ROMS[@]}"; do
  if [ ! -f "$f" ]; then
    echo "$f is missing (extern/eproms is not in git)" >&2
    exit 1
  fi
done

STAGE=$(mktemp -d)
chmod 755 "$STAGE" # rsync -a gives the target directory the mode of this one
trap 'rm -rf "$STAGE"' EXIT

tar -c --exclude='./.*' --exclude=./upload.sh --exclude=./serve.sh --exclude=./eslint.sh . | tar -x -C "$STAGE"
mkdir -p "$STAGE/roms"
cp "${ROMS[@]}" "$STAGE/roms/"

rsync -av "$@" "$STAGE/" "$DEST/"
