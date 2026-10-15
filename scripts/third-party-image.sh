#!/bin/sh
# Export installed upstream legal files without treating an SBOM as license text.
set -eu
if [ "$#" -ne 2 ]; then echo 'Usage: third-party-image.sh IMAGE OUTPUT.tar' >&2; exit 1; fi
docker run --rm --user 0 --entrypoint sh "$1" -c '
set -eu
: > /tmp/legal-files
for directory in /usr/share/doc /usr/share/common-licenses /usr/share/licenses /usr/share/driftverk; do
  if [ -d "$directory" ]; then find -L "$directory" -type f >> /tmp/legal-files; fi
done
for directory in /usr/local/lib /app/node_modules /opt/uv; do
  if [ -d "$directory" ]; then
    find "$directory" -type f \( -iname "license*" -o -iname "licence*" -o -iname "notice*" -o -iname "copying*" -o -iname "copyright*" -o -iname "authors*" -o -iname "third_party*" \) >> /tmp/legal-files
  fi
done
test -s /tmp/legal-files
# Store referenced license text, including file symlinks, in the archive itself.
tar -h -cf - -T /tmp/legal-files
' > "$2"
