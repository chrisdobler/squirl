# Squirl developer tasks. Run `make help` (or just `make`) for the list.

.DEFAULT_GOAL := help
SHELL := /bin/bash

# Squirl currently runs on the remote Ubuntu Docker host. Override these per
# command or in a git-ignored Makefile.local when using local Docker instead:
#   make start DOCKER_CONTEXT=desktop-linux DATABASE_HOST=127.0.0.1
-include Makefile.local
DOCKER_CONTEXT ?= ubuntu-desktop
DATABASE_HOST ?= $(if $(filter ubuntu-desktop,$(DOCKER_CONTEXT)),192.168.16.150,127.0.0.1)
DATABASE_URL ?= postgresql://squirl:squirl-dev-only@$(DATABASE_HOST):5432/squirl
TEST_DATABASE_URL ?= postgresql://squirl:squirl-dev-only@$(DATABASE_HOST):5432/squirl_test
ADMINER_HOST_PORT ?= 8080
CHROMA_ADMIN_HOST_PORT ?= 3001

DOCKER := docker $(if $(strip $(DOCKER_CONTEXT)),--context $(strip $(DOCKER_CONTEXT)))
COMPOSE := $(DOCKER) compose

.PHONY: help start start-electron stop up down build test test-db check .ensure-web-ports-available

help:  ## Show this help.
	@grep -h -E '^[a-zA-Z_-]+:.*?## .*$$' $(MAKEFILE_LIST) | sort \
		| awk 'BEGIN {FS = ":.*?## "}; {printf "  \033[36m%-10s\033[0m %s\n", $$1, $$2}'

start: .ensure-web-ports-available  ## Start databases, their admin UIs, and the Squirl web runtime.
	$(COMPOSE) up -d --wait postgres adminer chroma chroma-admin
	@echo ""
	@echo "  Squirl is starting."
	@echo "  ─────────────────────────────────────────────"
	@echo "  Web UI       http://127.0.0.1:5173"
	@echo "  API          http://127.0.0.1:4174"
	@echo "  Postgres UI  http://$(DATABASE_HOST):$(ADMINER_HOST_PORT)  (auto-login to squirl)"
	@echo "  Chroma UI    http://$(DATABASE_HOST):$(CHROMA_ADMIN_HOST_PORT)"
	@echo "  ─────────────────────────────────────────────"
	@echo "  Ctrl-C stops the web runtime; run 'make stop' for containers."
	@echo ""
	DATABASE_URL='$(DATABASE_URL)' pnpm dev:web

start-electron:  ## Start databases, their admin UIs, and Electron with hot reload.
	$(COMPOSE) up -d --wait postgres adminer chroma chroma-admin
	@echo ""
	@echo "  Squirl Electron is starting with hot reload."
	@echo "  Reusing the web runtime on ports 5173/4174 when it is already running."
	@echo "  DATABASE_URL host: $(DATABASE_HOST)"
	@echo "  Ctrl-C stops Electron; run 'make stop' for containers."
	@echo ""
	DATABASE_URL='$(DATABASE_URL)' pnpm dev:electron:hot

stop:  ## Stop the Docker services.
	$(COMPOSE) down

up:  ## Start the Docker services in the configured context.
	$(COMPOSE) up -d --wait postgres adminer chroma chroma-admin

down:  ## Stop the Docker services (alias for stop).
	$(COMPOSE) down

build:  ## Type-check and build the web client.
	pnpm build
	pnpm build:web

test:  ## Run the unit test suite.
	pnpm test

test-db:  ## Run destructive integration tests against squirl_test only.
	TEST_DATABASE_URL='$(TEST_DATABASE_URL)' pnpm test:db

check: build test test-db  ## Run builds and all tests.

.ensure-web-ports-available:
	@set -e; \
	project_listeners() { \
		for port in 4174 5173; do lsof -nP -iTCP:$$port -sTCP:LISTEN -t 2>/dev/null || true; done \
			| sort -u \
			| while read -r pid; do \
				cwd="$$(lsof -a -p "$$pid" -d cwd -Fn 2>/dev/null | sed -n 's/^n//p')"; \
				if [ "$$cwd" = '$(CURDIR)' ]; then echo "$$pid"; fi; \
			done; \
	}; \
	listeners="$$(project_listeners)"; \
	if [ -z "$$listeners" ]; then exit 0; fi; \
	echo ""; \
	echo "  This Squirl checkout is already using a web port:"; \
	for pid in $$listeners; do lsof -nP -a -p "$$pid" -iTCP -sTCP:LISTEN 2>/dev/null || true; done; \
	echo ""; \
	if [ ! -t 0 ]; then \
		echo "  Non-interactive shell; existing listeners were left running." >&2; \
		exit 1; \
	fi; \
	read -r -p "  Stop these listeners and restart Squirl? [y/N] " answer; \
	case "$$answer" in y|Y|yes|YES) ;; *) echo "  Aborting."; exit 1 ;; esac; \
	for pid in $$listeners; do echo "  Stopping PID $$pid"; kill "$$pid" 2>/dev/null || true; done; \
	for _ in 1 2 3 4 5 6 7 8 9 10; do \
		remaining="$$(project_listeners)"; \
		[ -z "$$remaining" ] && exit 0; \
		sleep 0.5; \
	done; \
	echo "  A Squirl web port is still in use." >&2; \
	exit 1
