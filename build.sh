#!/usr/bin/env bash
# shellcheck shell=bash disable=SC2016,SC2046,SC2086

# Generic Build Script for Jenkins
# v1.2 Jun 2025 by Cronocide

#  ___  ___ ___ _    ___ ___ ___ _      _ _____ ___
# | _ )/ _ \_ _| |  | __| _ \ _ \ |    /_\_   _| __|
# | _ \ (_) | || |__| _||   /  _/ |__ / _ \| | | _|
# |___/\___/___|____|___|_|_\_| |____/_/ \_\_| |___|

# Get the OS type. Most specific distributions first.
export OS="$(uname -a)"
[[ "$OS" == *"iPhone"* || "$OS" == *"iPad"* ]] && export OS="iOS"
[[ "$OS" == *"ndroid"* ]] && export OS="Android"
[[ "$OS" == *"indows"* ]] && export OS="Windows"
[[ "$OS" == *"arwin"* ]] && export OS="macOS"
[[ "$OS" == *"BSD"* ]] && export OS="BSD"
[[ "$OS" == *"inux"* ]] && export OS="Linux"

# Verify a list of software or operating systems. Inverted returns for ease-of-use.
__missing_os() {
	for i in "$@"; do
		! __no_os "$i" && return 1
	done
	echo "This function is not available on $OS." && return 0
}

__no_os() {
	[[ "$OS" == "$1" ]] && return 1
	return 0
}

# Verify we have dependencies needed to execute successfully
__missing_reqs() {
	for i in "$@"; do
		[[ "$0" != "$i" ]] && __no_req "$i" && echo "$i is required to perform this function." && return 0
	done
	return 1
}

__no_req() {
	[[ "$(type $1 2>/dev/null)" == '' ]] && return 0
	return 1
}

# An abstraction for curl/wget. Accepts url and <optional output path>
__http_get() {
	OUTPUT="$2"; [ -z "$OUTPUT" ] && export OUTPUT="-"
	if [[ "$(type curl 2>/dev/null)" != '' ]]; then
		curl -s "$1" -o "$OUTPUT"
		[ "$OUTPUT" != "-" ] && { ! [ -f "$OUTPUT" ] || [[ $(cat "$OUTPUT" | tr -d '\0' 2>/dev/null) == '' ]]; } && return 1
		return 0
	else
		if ! [[ "$(type wget 2>/dev/null)" != '' ]]; then
			wget "$1" -O "$2"
			[ "$OUTPUT" != "-" ] && { ! [ -f "$2" ] || [[ $(cat "$2" | tr -d '\0' 2>/dev/null) == '' ]]; } && return 1
			return 0
		fi
	fi
	echo "curl or wget is required to perform this function." && return 1
}

__missing_sed() {
    __no_req "sed" && __no_req "gsed" && echo "sed or gsed is required to perform this function." && return 0
}

sed_i() {
    __missing_sed && return 1;
    if [[ "$OS" == "macOS" ]]; then
        if [[ $(type gsed 2>/dev/null) != '' ]]; then
            gsed -i "$@";
        else
            sed -i '' "$@";
        fi;
    else
        sed -i "$@";
    fi
}

# Echo errors to stderr
error() {
	echo -e "\0331;31m$*\033[0m" 1>&2
}

# Provide a reliable ISO 8601 timestamp.
isotime() {
	[[ "$OS" == "Linux" ]] && echo $(date --iso-8601=seconds) && return 0
	date +"%Y-%m-%dT%H:%M:%S%z" | sed 's#\(-[0-9]\{2\}\)00#\1:00#'
}

#  ___ _   _ _  _  ___ _____ ___ ___  _  _ ___
# | __| | | | \| |/ __|_   _|_ _/ _ \| \| / __|
# | _|| |_| | .` | (__  | |  | | (_) | .` \__ \
# |_|  \___/|_|\_|\___| |_| |___\___/|_|\_|___/


cicd_prepare() {
	# Prepare the build environment.
	echo "Preparing for Build"
	error "${FUNCNAME[0]} is not implemented"
	echo "Completed Preparing for Build"
}

cicd_inspect() {
	# Information about the build environment.
	echo "Inspecting Build Environment"
	env
	echo "Completed Inspecting Build Environment"
}

cicd_build() {
	# Build a new software artifact.
	__missing_reqs "uname docker" && exit 1
	echo "Building Software"
	# Set default build platform if not specified
	BUILD_PLATFORM=$([ "$(uname -m)" = "aarch64" ] || [ "$(uname -m)" = "arm64" ] && echo "linux/arm64" || echo "linux/amd64")
	[ -z "$DOCKER_PLATFORM" ] && echo "Missing DOCKER_PLATFORM, assuming $BUILD_PLATFORM."
	DOCKER_PLATFORM="${DOCKER_PLATFORM:-$BUILD_PLATFORM}"
	docker build --platform "$DOCKER_PLATFORM" --pull=true \
             --label "org.opencontainers.image.vendor=${VENDOR}" \
             --label "org.opencontainers.image.version=${VERSION}" \
             --label "org.opencontainers.image.created=$(isotime)" \
             --label "org.opencontainers.image.title=${PROJECT_NAME}" \
             --label "org.opencontainers.image.url=https://${GIT_REPO_NAME}" \
             --label "org.opencontainers.image.source=https://${IMAGE_NAME}" \
             --label "$VENDOR_RDNS.build-info.git-repo=${GIT_URL}" \
             --label "$VENDOR_RDNS.build-info.git-branch=${GIT_BRANCH}" \
             --label "$VENDOR_RDNS.build-info.git-commit=${GIT_COMMIT}" \
             --label "$VENDOR_RDNS.build-info.git-user-email=${GIT_COMMITTER}" \
             --label "$VENDOR_RDNS.build-info.build-time=$(isotime)" \
             --tag="$COMMIT_TAG" \
             --tag="$LATEST_TAG" \
             .
	echo "Completed Building Software"
}

cicd_test() {
	# Run tests on the built software artifact.
	echo "Testing Software"
	if ! __no_req qdev; then
		DOCKER_DEFAULT_PLATFORM="$DOCKER_PLATFORM" qdev image validate "$COMMIT_TAG" || return 1
	else
		error "${FUNCNAME[0]} is not implemented"
	fi
	echo "Completed Testing Software"
}

cicd_publish() {
	# Publish the software to artifact repositories.
	__missing_reqs "docker" && exit 1
	echo "Publishing Software"
	# Set default build platform if not specified
	BUILD_PLATFORM=$([ "$(uname -m)" = "aarch64" ] || [ "$(uname -m)" = "arm64" ] && echo "linux/arm64" || echo "linux/amd64")
	[ -z "$DOCKER_PLATFORM" ] && echo "Missing DOCKER_PLATFORM, assuming $BUILD_PLATFORM."
	DOCKER_PLATFORM="${DOCKER_PLATFORM:-$BUILD_PLATFORM}"
	# TODO: Improve the logic of this Docker login flow.
	LOGIN_CREDS="DOCKER_USERNAME DOCKER_PASSWORD"
	for CRED in $LOGIN_CREDS; do
	        [ -z "${!CRED}" ] && echo "Missing $CRED, skipping docker login." && export SKIP_DOCKER_LOGIN=1
	done
	[[ "$SKIP_DOCKER_LOGIN" != "1" ]] && docker login "$GIT_REPO_NAME" -u "$DOCKER_USERNAME" -p "$DOCKER_PASSWORD"
	docker push ${COMMIT_TAG} || exit 1
	docker push ${LATEST_TAG} || exit 1
	if ! __no_req qdev; then
		DOCKER_DEFAULT_PLATFORM="$DOCKER_PLATFORM" qdev image publish ${LATEST_TAG} "$USERN/$PROJECT_NAME:latest" || return 1
	fi
	echo "Completed Publishing Software"
}

cicd_deploy() {
	#  Deploy the container into an environment.
	echo "Deploying Software"
	error "${FUNCNAME[0]} is not implemented"
	echo "Completed Deploying Software"
}

prepare_devenv() {
	# Place actions here to prepare the environment for development
	echo
}

#  __  __   _   ___ _  _
# |  \/  | /_\ |_ _| \| |
# | |\/| |/ _ \ | || .` |
# |_|  |_/_/ \_\___|_|\_|

__missing_reqs "git sed" && exit 1

# Verify that an ACTION is supplied in the environment.
BUILD_PREFIX="cicd"
[ -z "$ACTION" ] && error "No ACTION supplied, no action taken." && exit 1
[[ "$ACTION" != "$BUILD_PREFIX"* ]] && error "Action $ACTION is not recognized as a valid action."
__no_req "$ACTION" && error "Action $ACTION is not recognized as a valid action." && exit 1

# Fill in variables if not supplied by CICD
[ -z "$USERN" ] && export USERN=cronocide
[ -z "$GIT_REPO_NAME" ] && export GIT_REPO_NAME=git.cronocide.net
[ -z "$VENDOR" ] && export VENDOR=cronocide.net
# Update submodules if the build system did not
git submodule update --init --recursive

# Prepare build system
prepare_devenv

# Define needed build strings
DIR=$(cd $(dirname ${BASH_SOURCE[0]}) && pwd)
PROJECT_NAME="$(git config --local remote.origin.url|sed -n 's#.*/\([^/.]*\)\(\.git\)\{0,1\}$#\1#p')"
IMAGE_NAME=$(echo "$GIT_REPO_NAME/$USERN/$PROJECT_NAME" | tr "[:upper:]" "[:lower:]")
GIT_COMMIT=$(git rev-parse HEAD)
GIT_COMMITTER=$(git log -1 --pretty=format:'%ae')
GIT_URL=$(git config --get remote.origin.url)
GIT_BRANCH=$(git branch | grep '\*' | cut -d ' ' -f2)
COMMIT_TAG="${IMAGE_NAME}:${GIT_COMMIT}"
LATEST_TAG="${IMAGE_NAME}:latest"
VENDOR_RDNS=$(IFS=. read -ra parts <<< "$VENDOR"; for ((i=${#parts[@]}-1; i>=0; i--)); do printf '%s.' "${parts[i]}"; done; echo)


# Automatic version detection. This relies on semver versions as tags. In their absence, version 0.0 + commit count will be used.
LAST_VERSION=$(git tag -l --sort=-v:refname v*.* | head -n 1); LAST_VERSION="${LAST_VERSION:-HEAD}"
SEMVER_MAJOR=$(echo "$LAST_VERSION" | tr -d [:alpha:] | cut -d. -f 1); SEMVER_MAJOR="${SEMVER_MAJOR:-0}"
SEMVER_MINOR=$(echo "$LAST_VERSION" | tr -d [:alpha:] | cut -d. -f 2); SEMVER_MINOR="${SEMVER_MINOR:-0}"
SEMVER_PATCH=$(git rev-list --count "$LAST_VERSION")
VERSION="$SEMVER_MAJOR.$SEMVER_MINOR.$SEMVER_PATCH"

# Run specified build task
"$ACTION"
