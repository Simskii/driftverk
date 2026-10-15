#!/bin/sh
set -eu
cd "$(dirname "$0")"
mkdir -p ../control-plane/installer/bin
cp ../LICENSE ../control-plane/installer/bin/LICENSE
go mod download all
go run ../scripts/third-party-go.go ../control-plane/installer/bin/THIRD_PARTY_NOTICES.txt
for target_os in darwin linux windows; do
  for target_arch in amd64 arm64; do
    suffix=''
    if [ "$target_os" = windows ]; then suffix='.exe'; fi
    name="driftverk-${target_os}-${target_arch}${suffix}"
    CGO_ENABLED=0 GOOS="$target_os" GOARCH="$target_arch" go build -trimpath -ldflags='-s -w' -o "../control-plane/installer/bin/$name" .
    (cd ../control-plane/installer/bin
      if command -v sha256sum >/dev/null 2>&1; then sha256sum "$name" > "$name.sha256"
      else shasum -a 256 "$name" > "$name.sha256"; fi)
  done
done
