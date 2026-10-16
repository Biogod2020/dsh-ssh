#!/bin/sh
# Sent over a verified SSH channel. No sudo, shell-profile changes, or global npm install.
set -eu
umask 077
root=${1:-"$HOME/.local/share/dsh-remote"}
version=${2:?Reviewed DSH version is required}
integrity=${3:?Reviewed DSH integrity is required}
compatible=${4:?Compatible DSH versions are required}
case "$root" in /*) ;; *) echo 'DSH_ERROR: Installation directory must be absolute'; exit 1;; esac
fail() { echo "DSH_ERROR: $*"; exit 1; }
progress() { printf 'DSH_PROGRESS:%s\n' "$1"; }
progress checking
os=$(uname -s)
arch=$(uname -m)
case "$os" in Linux) platform=linux;; Darwin) platform=darwin;; *) fail "Unsupported operating system: $os";; esac
case "$arch" in x86_64|amd64) arch=x64;; aarch64|arm64) arch=arm64;; *) fail "Unsupported architecture: $arch";; esac
[ -d "$HOME" ] && [ -w "$HOME" ] || fail 'Home directory is not writable'
[ ! -L "$root" ] || fail 'Installation directory must not be a symlink'
mkdir -p "$root"
[ -w "$root" ] || fail 'Installation directory is not writable'
prepareInstall() {
  command -v tar >/dev/null 2>&1 || fail 'tar is required'
  command -v curl >/dev/null 2>&1 || fail 'curl with HTTPS support is required'
  if command -v sha256sum >/dev/null 2>&1; then hash() { sha256sum "$1" | awk '{print $1}'; }
  elif command -v shasum >/dev/null 2>&1; then hash() { shasum -a 256 "$1" | awk '{print $1}'; }
  else fail 'sha256sum or shasum is required'; fi
  free=$(df -Pk "$root" | awk 'NR==2 {print $4}')
  case "$free" in ''|*[!0-9]*) fail 'Cannot determine free disk space';; esac
  [ "$free" -ge 1048576 ] || fail 'At least 1 GiB of free disk space is required'
}
# mkdir owns a whole install transaction. An interrupted receipt is preserved, never blindly removed.
lock="$root/install.lock"
if ! mkdir "$lock" 2>/dev/null; then fail 'Another installation is active or interrupted; inspect install.lock before retrying'; fi
printf '%s\n' "$$" > "$lock/pid"
trap 'rm -f "$lock/pid"; rmdir "$lock"' EXIT
node_bin=''
for candidate in "$(command -v node || true)" "$HOME/.local/bin/node" "$root/node/bin/node" "$HOME"/.nvm/versions/node/*/bin/node; do
  if [ -x "$candidate" ] && "$candidate" -e 'let [a,b]=process.versions.node.split(".").map(Number);process.exit(a===22&&b>=19||a>=24?0:1)' >/dev/null 2>&1; then node_bin=$candidate; break; fi
done
download() { curl --fail --location --proto '=https' --proto-redir '=https' --connect-timeout 20 --max-time 600 --silent --show-error "$1" -o "$2"; }
if [ -z "$node_bin" ]; then
  prepareInstall
  if [ "$platform" = linux ]; then
    libc=$(getconf GNU_LIBC_VERSION 2>/dev/null || true)
    printf '%s\n' "$libc" | awk '{split($2,v,".");exit !(v[1]>2 || v[1]==2&&v[2]>=28)}' || fail 'Node requires glibc 2.28 or newer; musl and older glibc need a compatible preinstalled Node'
    [ -n "$libc" ] || fail 'Cannot verify glibc; install a compatible Node first'
    uname -r | awk -F. '{exit !($1>4 || $1==4&&$2>=18)}' || fail 'Node requires Linux kernel 4.18 or newer'
  else
    sw_vers -productVersion | awk -F. '{exit !($1>13 || $1==13&&$2>=5)}' || fail 'Node requires macOS 13.5 or newer'
  fi
  progress installing-node
  case "$platform-$arch" in
    linux-x64) expected=2faf6a387e9b62b888e21c54f01249fb27537ffecf1842f29f4c919d0a59a0ff;;
    linux-arm64) expected=589f5b6dd4fcfee4dfda73013903c966abaa8abd93dbc9d436544e472b4f0e74;;
    darwin-x64) expected=298b4c7b3cb80765c8703e42b90324a4ece3b6634947b89e769c3c980ab55185;;
    darwin-arm64) expected=39189dab4eeb15706c424af0ac08a3044c9e48f7db12a7d77f6b7aafc7dd5df6;;
  esac
  stage=$(mktemp -d "$root/node-stage.XXXXXXXX")
  download "https://nodejs.org/dist/v24.16.0/node-v24.16.0-$platform-$arch.tar.gz" "$stage/node.tar.gz" || fail 'Node download failed; no release was activated'
  [ "$(hash "$stage/node.tar.gz")" = "$expected" ] || fail 'Node checksum mismatch; no release was activated'
  mkdir "$stage/unpacked"
  tar -xzf "$stage/node.tar.gz" -C "$stage/unpacked" --strip-components=1
  "$stage/unpacked/bin/node" --version >/dev/null || fail 'Downloaded Node cannot execute on this machine'
  [ ! -e "$root/node" ] || fail 'An unusable managed Node already exists; inspect it before replacing'
  mv "$stage/unpacked" "$root/node"
  node_bin="$root/node/bin/node"
fi
export PATH="$(dirname "$node_bin"):$PATH"
release="$root/releases/$version"
dsh_bin=''
# Prefer the reviewed release; retain compatible installations and existing sessions.
selected_version=$version
for candidate in "$release/node_modules/.bin/dsh" "$(command -v dsh || true)" "$HOME/.local/bin/dsh" "$(dirname "$node_bin")/dsh" "$root"/releases/*/node_modules/.bin/dsh; do
  [ -x "$candidate" ] || continue
  candidate_version=$("$candidate" --version 2>/dev/null || true)
  case "|$compatible|" in *"|$candidate_version|"*) dsh_bin=$candidate; selected_version=$candidate_version; break;; esac
done
if [ -z "$dsh_bin" ]; then
  prepareInstall
  progress installing-dsh
  command -v npm >/dev/null 2>&1 || fail 'The selected Node installation has no npm'
  mkdir -p "$root/releases"
  stage=$(mktemp -d "$root/releases/staging.XXXXXXXX")
  # Validate the pinned root artifact independently; npm validates dependency integrity in its lockfile.
  download "https://registry.npmjs.org/@deepseek-ai/dsh/-/dsh-$version.tgz" "$stage/dsh.tgz" || fail 'DSH download failed; no release was activated'
  "$node_bin" -e 'const fs=require("fs"),c=require("crypto");if(c.createHash("sha512").update(fs.readFileSync(process.argv[1])).digest("base64")!==process.argv[2])process.exit(1)' "$stage/dsh.tgz" "$integrity" || fail 'DSH checksum mismatch'
  printf '%s\n' '{"private":true}' > "$stage/package.json"
  npm install --prefix "$stage" --registry=https://registry.npmjs.org --no-audit --no-fund --save-exact "$stage/dsh.tgz" > "$stage/install.log" 2>&1 || fail 'DSH dependency installation failed; inspect the private staging install.log'
  [ "$("$stage/node_modules/.bin/dsh" --version)" = "$version" ] || fail 'Installed DSH version did not pass verification'
  "$stage/node_modules/.bin/dsh" web --help >/dev/null 2>&1 || fail 'Installed DSH web command is unavailable'
  [ ! -e "$release" ] || fail 'An incomplete release already exists; inspect it before replacing'
  "$node_bin" -e 'require("fs").renameSync(process.argv[1],process.argv[2])' "$stage" "$release"
  dsh_bin="$release/node_modules/.bin/dsh"
fi
"$node_bin" -e 'console.log("DSH_INSTALL:"+JSON.stringify({node:process.argv[1],dsh:process.argv[2],root:process.argv[3],version:process.argv[4]}))' "$node_bin" "$dsh_bin" "$root" "$selected_version"
