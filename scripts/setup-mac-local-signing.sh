#!/usr/bin/env bash
set -euo pipefail

identity_name="TermRelay Local Code Signing"

for command in codesign openssl security; do
  command -v "$command" >/dev/null 2>&1 || {
    echo "Required command is missing: $command" >&2
    exit 1
  }
done

if security find-identity -v -p codesigning 2>/dev/null \
  | grep -Fq "\"$identity_name\""; then
  echo "Code-signing identity already exists: $identity_name"
  exit 0
fi

login_keychain="$(security login-keychain \
  | sed -e 's/^[[:space:]]*"//' -e 's/"[[:space:]]*$//')"
if [ -z "$login_keychain" ] || [ ! -f "$login_keychain" ]; then
  echo "Unable to locate the user login keychain." >&2
  exit 1
fi

work_dir="$(mktemp -d "${TMPDIR:-/tmp}/termrelay-local-signing.XXXXXX")"
trap 'rm -rf "$work_dir"' EXIT

private_key="$work_dir/private-key.pem"
certificate="$work_dir/certificate.pem"
identity_archive="$work_dir/identity.p12"
archive_password="$(openssl rand -hex 32)"

echo "Creating local code-signing identity: $identity_name"
openssl req \
  -newkey rsa:3072 \
  -nodes \
  -x509 \
  -days 3650 \
  -sha256 \
  -subj "/CN=$identity_name/O=TermRelay Local Development" \
  -addext "basicConstraints=critical,CA:TRUE" \
  -addext "keyUsage=critical,digitalSignature,keyCertSign" \
  -addext "extendedKeyUsage=codeSigning" \
  -keyout "$private_key" \
  -out "$certificate" \
  >/dev/null 2>&1

openssl pkcs12 \
  -export \
  -name "$identity_name" \
  -inkey "$private_key" \
  -in "$certificate" \
  -out "$identity_archive" \
  -passout "pass:$archive_password"

security import "$identity_archive" \
  -k "$login_keychain" \
  -f pkcs12 \
  -P "$archive_password" \
  -x \
  -T /usr/bin/codesign
security add-trusted-cert \
  -r trustRoot \
  -p codeSign \
  -k "$login_keychain" \
  "$certificate"

if ! security find-identity -v -p codesigning 2>/dev/null \
  | grep -Fq "\"$identity_name\""; then
  echo "The identity was imported but is not valid for code signing." >&2
  exit 1
fi

echo "Local code-signing identity is ready: $identity_name"
echo "Future TermRelay releases will select it automatically."
