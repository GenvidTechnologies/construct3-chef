#!/usr/bin/env bash
# Download leaf package dependencies from Azure Blob Storage.
# Reads versions from .packages-version (format: name=version per line).
# Requires: az CLI, logged in with storage access.

set -euo pipefail

CONTAINER="cordova"
DEST_DIR=".packages"
VERSION_FILE=".packages-version"

if [[ ! -f "$VERSION_FILE" ]]; then
  echo "ERROR: $VERSION_FILE not found" >&2
  exit 1
fi

mkdir -p "$DEST_DIR"

while IFS='=' read -r name version; do
  [[ -z "$name" || "$name" == \#* ]] && continue
  blob="$name/tags/$version/$name-$version.tgz"
  dest="$DEST_DIR/$name.tgz"

  if [[ -f "$dest" ]]; then
    echo "Already downloaded: $dest"
    continue
  fi

  echo "Downloading $blob..."
  az storage blob download -c "$CONTAINER" -n "$blob" --file "$dest" --no-progress
done < "$VERSION_FILE"

echo "Dependencies downloaded to $DEST_DIR/"
