# TMA Cloud: Docker image and developer shortcuts.
#
#   make              Build the Docker image (default)
#   make ci           What CI runs: format, lints, house rules, tests, wasm build
#   make fmt          Format Rust (rustfmt) and everything else (Prettier)
#   make house        File size, copied code and theme colour rules
#   make web          Build the web app into apps/tma-cloud-web/dist
#   make desktop      Build the desktop app (release)
#   make hooks        Use the repo's git hooks (.githooks/)

.PHONY: help build build-no-cache clean ci fmt house web desktop hooks

IMAGE_NAME ?= tma-cloud
IMAGE_TAG ?= latest
# The workspace version, from the root Cargo.toml.
VERSION := $(shell sed -n 's/^version = "\(.*\)"/\1/p' Cargo.toml | head -n1)

.DEFAULT_GOAL := build

help:
	@sed -n 's/^#   //p' Makefile

build:
	docker build --build-arg VERSION=$(VERSION) -t $(IMAGE_NAME):$(IMAGE_TAG) .

build-no-cache:
	docker build --no-cache --build-arg VERSION=$(VERSION) -t $(IMAGE_NAME):$(IMAGE_TAG) .

clean:
	-docker rmi $(IMAGE_NAME):$(IMAGE_TAG)

ci:
	cargo xtask ci

fmt:
	cargo xtask fmt

house:
	cargo xtask house

web:
	cd apps/tma-cloud-web && trunk build --release --cargo-profile wasm-release

desktop:
	cargo build --release -p tma-cloud

hooks:
	@git config core.hooksPath .githooks
	@echo "Git hooks enabled from .githooks/"
