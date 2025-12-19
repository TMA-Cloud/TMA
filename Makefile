# =============================================================================
# Makefile for TMA Cloud - Docker Build
# =============================================================================
# This Makefile is for building the Docker image only.
# For running containers, use docker run or docker-compose directly.
#
# Quick Start:
#   make build        - Build Docker image
#   make              - Same as make build (default target)
# =============================================================================

.PHONY: help build build-no-cache clean

# =============================================================================
# Configuration Variables (can be overridden)
# =============================================================================
IMAGE_NAME ?= tma-cloud
IMAGE_TAG ?= latest

# =============================================================================
# Default target
# =============================================================================
.DEFAULT_GOAL := build

help:
	@echo "TMA Cloud - Docker Build"
	@echo ""
	@echo "Available commands:"
	@echo "  make              Build Docker image (default)"
	@echo "  make build        Build Docker image"
	@echo "  make build-no-cache  Build without using cache"
	@echo "  make clean        Remove Docker image"
	@echo ""
	@echo "Configuration (override with VAR=value):"
	@echo "  IMAGE_NAME        Docker image name (default: tma-cloud)"
	@echo "  IMAGE_TAG         Docker image tag (default: latest)"
	@echo ""
	@echo "Versioning:"
	@echo "  - When using 'make build', image label 'version' is read from backend/package.json"
	@echo "  - IMAGE_TAG is just the Docker tag (can differ from label value)"
	@echo ""
	@echo "Examples:"
	@echo "  make build"
	@echo "  make build IMAGE_TAG=2.0.3"
	@echo "  make build-no-cache"
	@echo ""

# =============================================================================
# Build Commands
# =============================================================================
build:
	@echo "Building Docker image $(IMAGE_NAME):$(IMAGE_TAG)..."
	@VERSION=$$(node -p "require('./backend/package.json').version" 2>/dev/null || echo "unknown"); \
	echo "Extracted version: $$VERSION"; \
	docker build --build-arg VERSION=$$VERSION -t $(IMAGE_NAME):$(IMAGE_TAG) . || (echo "Build failed!" && exit 1)
	@echo "Build complete! Image: $(IMAGE_NAME):$(IMAGE_TAG)"

build-no-cache:
	@echo "Building Docker image $(IMAGE_NAME):$(IMAGE_TAG) without cache..."
	@VERSION=$$(node -p "require('./backend/package.json').version" 2>/dev/null || echo "unknown"); \
	echo "Extracted version: $$VERSION"; \
	docker build --no-cache --build-arg VERSION=$$VERSION -t $(IMAGE_NAME):$(IMAGE_TAG) . || (echo "Build failed!" && exit 1)
	@echo "Build complete! Image: $(IMAGE_NAME):$(IMAGE_TAG)"

# =============================================================================
# Cleanup
# =============================================================================
clean:
	@echo "Removing Docker image $(IMAGE_NAME):$(IMAGE_TAG)..."
	@docker rmi $(IMAGE_NAME):$(IMAGE_TAG) 2>/dev/null || echo "Image not found"
	@echo "Cleanup complete"
